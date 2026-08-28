/// Atlas Tauri library (E8).
///
/// The desktop app OWNS the embedded Atlas core: on startup it launches the
/// bundled Atlas daemon (which runs Lore — kuzu + lancedb + sqlite — in
/// process, no separate setup) and kills it on exit. The frontend keeps
/// talking to it over 127.0.0.1:3848 exactly as before, so atlasApi.ts needs
/// no changes. If a daemon is already listening (e.g. `atlas serve` in a
/// terminal), we reuse it instead of spawning a second one.
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// UX-truth site #5 — payload for the `daemon-spawn-failed` event.
///
/// Previously a spawn failure (missing bundled node, no bundled core dir, or
/// the OS `Command::spawn()` call itself erroring — port conflicts surface
/// here too on some platforms) was ONLY `eprintln!`'d: invisible to the
/// frontend, which has no stderr access. The UI then showed an infinite
/// "Retry / make sure Groundfloor Atlas is running" with no real cause, because from
/// its perspective the daemon just never answered on :3848 — indistinguishable
/// from "still starting up". Emitting this event gives the frontend the
/// concrete reason so it can show an actionable error instead of a spinner
/// that never resolves.
#[derive(Clone, serde::Serialize)]
struct DaemonSpawnFailed {
    reason: String,
}

const DAEMON_SPAWN_FAILED_EVENT: &str = "daemon-spawn-failed";

/// Holds the spawned daemon child so the Exit handler can stop it (never orphan
/// the process we started — the Node daemon handles SIGTERM/SIGKILL cleanly).
struct AtlasDaemon(Mutex<Option<Child>>);

/// RD-F08 — stop the daemon gracefully: SIGTERM first so the Node process can
/// flush + close its kuzu/lancedb handles, poll up to ~2s for it to exit, then
/// escalate to SIGKILL only if it's still alive. `std::process::Child::kill`
/// is an immediate SIGKILL on Unix, which can corrupt the embedded stores.
fn stop_child(mut child: Child) {
    #[cfg(unix)]
    {
        // RD-Mpgroup — the daemon leads its own process group (process_group(0)
        // at spawn), so signal the whole GROUP (negative pid) to also stop any
        // grandchildren, not just the node process.
        let pid = child.id() as i32;
        unsafe {
            libc::kill(-pid, libc::SIGTERM);
        }
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(100));
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
        }
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    // Non-unix, or still alive after the grace window → force kill.
    let _ = child.kill();
    let _ = child.wait();
}

const ATLAS_PORT: u16 = 3848;

/// True only if OUR Atlas daemon is already listening on the port (RD-R1).
///
/// A bare TCP connect proves *something* is on :3848, not that it is Atlas — a
/// trojan listener could otherwise hijack the reuse path. So we do an
/// authenticated /health handshake using only std: GET /health, then require
/// the response to be HTTP 200 AND carry Atlas's liveness signature
/// (`"status":"ok"` + `"uptime_ms"`). Anything that fails the handshake is
/// treated as "not our daemon" → we spawn our own instead of trusting it.
fn daemon_already_running() -> bool {
    let addr = match format!("127.0.0.1:{ATLAS_PORT}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /health HTTP/1.0\r\nHost: 127.0.0.1:{ATLAS_PORT}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut resp = String::new();
    // Bounded read — /health is tiny; cap to avoid a hostile listener streaming.
    let mut buf = [0u8; 2048];
    let mut total = 0usize;
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                resp.push_str(&String::from_utf8_lossy(&buf[..n]));
                total += n;
                if total >= 8192 {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let status_ok = resp.starts_with("HTTP/1.0 200") || resp.starts_with("HTTP/1.1 200");
    status_ok && resp.contains("\"status\":\"ok\"") && resp.contains("\"uptime_ms\"")
}

/// Resolve the Node runtime: ONLY a node binary bundled alongside the core.
///
/// RD-MF22 — fail closed. The previous fallback to bare `node` on PATH would
/// run an attacker-controlled binary earlier on PATH with the app's privileges.
/// We now require the bundled, self-contained node; if it is absent (or not an
/// executable regular file) we return None so the caller surfaces a clear
/// "reinstall Atlas" error instead of silently running something off PATH.
fn resolve_node(core_dir: &std::path::Path) -> Option<std::path::PathBuf> {
    for name in ["node", "node.exe"] {
        let bundled = core_dir.join(name);
        if !bundled.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            match std::fs::metadata(&bundled) {
                Ok(meta) if meta.permissions().mode() & 0o111 != 0 => return Some(bundled),
                _ => continue,
            }
        }
        #[cfg(not(unix))]
        {
            return Some(bundled);
        }
    }
    None
}

/// Locate the bundled core dir (the `dist-bundle/` shipped as the `atlas-core`
/// resource). Falls back to the repo root for `tauri dev`.
fn resolve_core_dir(app: &tauri::App) -> Option<std::path::PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("atlas-core");
        if bundled.join("dist").join("cli.js").exists() {
            return Some(bundled);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    if dev.join("dist").join("cli.js").exists() {
        return Some(dev);
    }
    None
}

/// Emit `daemon-spawn-failed` to every window so the frontend can surface the
/// REAL reason instead of an infinite "make sure Groundfloor Atlas is running" spinner
/// that never explains itself. Best-effort: if emit itself fails (e.g. no
/// window created yet), that failure is logged but never propagated — this
/// must not become a second point of silent failure.
fn emit_spawn_failed(app: &tauri::App, reason: String) {
    eprintln!("[atlas-app] {reason}");
    if let Err(e) = app.emit(DAEMON_SPAWN_FAILED_EVENT, DaemonSpawnFailed { reason }) {
        eprintln!("[atlas-app] failed to emit {DAEMON_SPAWN_FAILED_EVENT}: {e}");
    }
}

fn spawn_atlas_daemon(app: &tauri::App) -> Option<Child> {
    if daemon_already_running() {
        eprintln!("[atlas-app] reusing Atlas daemon already listening on :{ATLAS_PORT}");
        return None;
    }
    let core = match resolve_core_dir(app) {
        Some(c) => c,
        None => {
            emit_spawn_failed(
                app,
                "Atlas core files not found (bundled dist-bundle missing). Reinstall Atlas.".to_string(),
            );
            return None;
        }
    };
    let cli = core.join("dist").join("cli.js");
    let node = match resolve_node(&core) {
        Some(n) => n,
        None => {
            emit_spawn_failed(
                app,
                format!(
                    "no bundled Node.js binary found in {}. Atlas requires a bundled Node.js runtime. Reinstall Atlas.",
                    core.display()
                ),
            );
            return None;
        }
    };

    // Per-user data home for the embedded Lore (kuzu/lancedb/sqlite + config).
    let home = match app.path().app_data_dir() {
        Ok(d) => d.join("atlas-home"),
        Err(e) => {
            emit_spawn_failed(app, format!("could not resolve app data directory: {e}"));
            return None;
        }
    };
    let _ = std::fs::create_dir_all(&home);

    eprintln!(
        "[atlas-app] starting embedded Atlas core: {} {} serve (ATLAS_HOME={})",
        node.display(),
        cli.display(),
        home.display()
    );
    let mut cmd = Command::new(node);
    cmd.arg(&cli).arg("serve");
    // RD-Mpgroup — put the daemon in its OWN process group so we can signal the
    // whole subtree (node + any children it spawns) on shutdown, and so it is
    // never accidentally reaped/left attached to the GUI's group.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    // RD-M7env — start from an EMPTY environment, then add back only the few
    // vars the daemon actually needs. The previous spawn inherited the full
    // parent env, leaking unrelated secrets into the daemon (and onward into
    // the embedded Lore). PATH/HOME/TMPDIR are required for node + native
    // modules; everything else is set explicitly below.
    cmd.env_clear();
    #[cfg(unix)]
    {
        if let Ok(p) = std::env::var("PATH") { cmd.env("PATH", p); }
        if let Ok(h) = std::env::var("HOME") { cmd.env("HOME", h); }
        if let Ok(t) = std::env::var("TMPDIR") { cmd.env("TMPDIR", t); }
        if let Ok(l) = std::env::var("LANG") { cmd.env("LANG", l); }
    }
    #[cfg(windows)]
    {
        if let Ok(p) = std::env::var("PATH") { cmd.env("PATH", p); }
        if let Ok(d) = std::env::var("USERPROFILE") { cmd.env("USERPROFILE", d); }
        if let Ok(t) = std::env::var("TEMP") { cmd.env("TEMP", t); }
        if let Ok(sr) = std::env::var("SYSTEMROOT") { cmd.env("SYSTEMROOT", sr); }
    }
    cmd
        .env("ATLAS_HOME", &home)
        // B4 PART 1 (REVISED — RC security) — auth model for the app-owned daemon.
        //
        // We KEEP mcp-auth ON. The daemon mints <ATLAS_HOME>/mcp.token on boot
        // (ensureMcpAuthToken, mode 0600) and requires
        // `Authorization: Bearer <token>` on /mcp, /api/chat/stream, and
        // /api/fs/browse. The previous build forced ATLAS_MCP_AUTH=off here so
        // the frontend (which had no way to read the token) wouldn't 401 — but
        // that opened the FULL tool surface, /api/fs/browse, and
        // /api/chat/stream (which can spend a configured cloud LLM key) to ANY
        // co-resident local process. Host/Origin gates do NOT stop a local
        // process: it can spoof Host: 127.0.0.1:<port> and simply omit Origin
        // (native clients legitimately do). The bearer token is the only thing
        // that process cannot read (0600, owner-only) — so it is the real
        // defense and must stay ON.
        //
        // The frontend now reads the token via the `read_mcp_token` command
        // (see below) and attaches it in buildAtlasHeaders(). We deliberately do
        // NOT set ATLAS_MCP_AUTH at all, so the daemon uses its secure default
        // (mcpAuthEnabled() === true). ATLAS_HOME above pins the same home the
        // command resolves the token from, so the minted token and the read
        // token always match.
        //
        // Code intelligence never loads the embedding model; stay fully offline.
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_OFFLINE", "1")
        .spawn()
        .map_err(|e| emit_spawn_failed(app, format!("failed to start Atlas core: {e} (port {ATLAS_PORT} may be in use, or the spawn was rejected)")))
        .ok()
}

/// Resolve the bundled (or dev) Atlas core dir from an AppHandle (mirror of
/// resolve_core_dir, which takes &App; commands receive an AppHandle).
fn core_dir_from_handle(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("atlas-core");
        if bundled.join("dist").join("cli.js").exists() {
            return Some(bundled);
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
    if dev.join("dist").join("cli.js").exists() {
        return Some(dev);
    }
    None
}

/// One-click IDE connect/disconnect. Runs the Atlas CLI's connect/disconnect
/// (the shared per-client config writer in src/cli/ideConnect.ts) against the
/// embedded core, with ATLAS_HOME pointed at the app's data dir — so the token
/// it writes matches the daemon this app owns. Returns the command's output.
#[tauri::command]
fn atlas_connect(app: tauri::AppHandle, client: String, disconnect: bool) -> Result<String, String> {
    let core = core_dir_from_handle(&app).ok_or("Atlas core not found")?;
    let cli = core.join("dist").join("cli.js");
    let node = resolve_node(&core)
        .ok_or("Atlas requires a bundled Node.js binary. Reinstall Atlas.")?;
    let home = app.path().app_data_dir().map_err(|e| e.to_string())?.join("atlas-home");
    let verb = if disconnect { "disconnect" } else { "connect" };
    let out = Command::new(node)
        .arg(&cli).arg(verb).arg(&client)
        .env("ATLAS_HOME", &home)
        .output()
        .map_err(|e| format!("failed to run atlas {verb}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(if stdout.is_empty() { stderr } else { stdout })
    } else {
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

/// RC security — expose the daemon's inbound MCP bearer token to the frontend.
///
/// The app-owned daemon boots with mcp-auth ON (see spawn_atlas_daemon) and
/// mints `<ATLAS_HOME>/mcp.token` (mode 0600). The WebView frontend must send
/// `Authorization: Bearer <token>` on every /mcp, /api/chat/stream, and
/// /api/fs/browse call or the daemon returns 401. This command reads that token
/// so buildAtlasHeaders() can attach it.
///
/// ATLAS_HOME is resolved the SAME way we pass it to the spawned daemon
/// (`app_data_dir()/atlas-home`), so the file we read is the one the daemon
/// minted. We only READ — never mint — because minting belongs to the daemon
/// (a fresh token from here could race/replace the daemon's real one). If the
/// token file isn't there yet (daemon still booting on first launch), we return
/// an empty string and the frontend retries; a hard error is reserved for an
/// unresolvable home.
#[tauri::command]
fn read_mcp_token(app: tauri::AppHandle) -> Result<String, String> {
    // An explicit ATLAS_MCP_TOKEN override wins for both the daemon and us, so
    // honor it first to stay consistent with config.ts:ensureMcpAuthToken.
    if let Ok(t) = std::env::var("ATLAS_MCP_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }
    let home = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data directory: {e}"))?
        .join("atlas-home");
    let token_path = home.join("mcp.token");
    match std::fs::read_to_string(&token_path) {
        Ok(raw) => Ok(raw.trim().to_string()),
        // Not minted yet (daemon still starting) → empty string, frontend retries.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("failed to read mcp.token: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AtlasDaemon(Mutex::new(None)))
        .setup(|app| {
            if let Some(child) = spawn_atlas_daemon(app) {
                if let Ok(mut guard) = app.state::<AtlasDaemon>().0.lock() {
                    *guard = Some(child);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![atlas_connect, read_mcp_token])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // RD-Mpgroup — reap the daemon on BOTH ExitRequested (window close /
            // quit menu, fired before teardown) and Exit (final teardown). The
            // first take() that succeeds stops it; the other is a no-op. Without
            // ExitRequested, an abnormal quit path that never reaches Exit would
            // orphan the daemon (and its process group).
            let should_stop = matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            );
            if should_stop {
                if let Ok(mut guard) = app_handle.state::<AtlasDaemon>().0.lock() {
                    if let Some(child) = guard.take() {
                        stop_child(child);
                    }
                }
            }
        });
}
