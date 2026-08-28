import { NavLink, Outlet, useParams } from 'react-router-dom';
import { FolderOpen, GitGraph, MessageSquare, Settings, Sun, Moon, AlertOctagon, X } from 'lucide-react';
import StatusBar from './StatusBar';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { useTheme } from '../contexts/ThemeContext';
import { useDaemonSpawnError } from '../hooks/useDaemonSpawnError';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
}

function DagIcon() {
  return (
    <svg width="15" height="12" viewBox="0 0 32 24" fill="none"
      stroke="var(--lb-accent)" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="4" cy="12" r="2.5" />
      <circle cx="13" cy="5" r="2.5" />
      <circle cx="13" cy="19" r="2.5" />
      <circle cx="28" cy="12" r="2.5" />
      <line x1="6.4" y1="11" x2="10.6" y2="6.2" />
      <line x1="6.4" y1="13" x2="10.6" y2="17.8" />
      <line x1="15.4" y1="5.8" x2="25.5" y2="11.1" />
      <line x1="15.4" y1="18.2" x2="25.5" y2="12.9" />
    </svg>
  );
}

function NavItem({ to, icon, label }: NavItemProps) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] transition-colors ${
          isActive
            ? 'bg-[var(--lb-nav-active)] text-[var(--lb-fg)]'
            : 'text-[var(--lb-dim)] hover:bg-[var(--lb-nav-hover)] hover:text-[var(--lb-body)]'
        }`
      }
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const params = useParams<{ id: string }>();
  const workspaceName = params.id;
  const { theme, toggle } = useTheme();
  // UX-truth site #5: the embedded daemon's spawn failure (missing bundled
  // node, missing core dist, or the OS spawn call itself erroring — e.g. a
  // port conflict) used to be invisible to the frontend, which just saw
  // :3848 never answer and showed the same infinite "make sure Groundfloor Atlas is
  // running" spinner as an ordinary slow start. This surfaces the REAL,
  // actionable reason as a global banner the instant Rust reports it.
  const { spawnError, clear: clearSpawnError } = useDaemonSpawnError();

  return (
    <div className="flex h-screen bg-[var(--lb-bg)] text-[var(--lb-fg)] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[200px] shrink-0 flex flex-col bg-[var(--lb-sidebar)] border-r border-[var(--lb-border)]">
        {/* Wordmark */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-[var(--lb-border)] shrink-0">
          <DagIcon />
          <span className="text-[13px] font-semibold text-[var(--lb-fg)] tracking-tight">Groundfloor Atlas</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 overflow-y-auto space-y-0.5">
          <NavItem to="/workspaces" icon={<FolderOpen className="w-3.5 h-3.5" />} label="Workspaces" />
          <NavItem to="/settings" icon={<Settings className="w-3.5 h-3.5" />} label="Settings" />

          {workspaceName && (
            <div className="mt-4 pt-3 border-t border-[var(--lb-border)] space-y-0.5">
              <WorkspaceSwitcher currentWorkspace={workspaceName} />
              <NavItem
                to={`/workspace/${workspaceName}`}
                icon={<GitGraph className="w-3.5 h-3.5" />}
                label="Graph"
              />
              <NavItem
                to={`/workspace/${workspaceName}/chat`}
                icon={<MessageSquare className="w-3.5 h-3.5" />}
                label="Chat"
              />
            </div>
          )}
        </nav>

        {/* Theme toggle — pb-8 clears the h-7 fixed StatusBar */}
        <div className="px-2 pb-8 pt-2 border-t border-[var(--lb-border)]">
          <button
            onClick={toggle}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-md text-[13px] text-[var(--lb-dim)] hover:bg-[var(--lb-nav-hover)] hover:text-[var(--lb-body)] transition-colors"
          >
            {theme === 'dark'
              ? <Sun className="w-3.5 h-3.5 shrink-0 opacity-80" />
              : <Moon className="w-3.5 h-3.5 shrink-0 opacity-80" />
            }
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </aside>

      {/* Main content — pb-7 clears the h-7 fixed StatusBar */}
      <main className="flex-1 overflow-hidden flex flex-col pb-7">
        {/* UX-truth site #5: actionable daemon-spawn-failure banner. Distinct
            from the per-page daemon-unreachable states (WorkspacePage,
            AddProjectModal) — those mean "no one answered on :3848 yet";
            this means Rust told us EXACTLY why it never even tried spawning
            one, so it's shown globally above every page. */}
        {spawnError && (
          <div className="shrink-0 flex items-start gap-2 px-4 py-2.5 bg-red-950/40 border-b border-red-900/60 text-red-300">
            <AlertOctagon size={14} className="shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">Groundfloor Atlas daemon failed to start</p>
              <p className="text-[11px] text-red-400/80 mt-0.5 break-words">{spawnError}</p>
            </div>
            <button
              onClick={clearSpawnError}
              className="p-0.5 rounded text-red-400/70 hover:text-red-200 hover:bg-red-900/40 transition-colors shrink-0"
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        )}
        <Outlet />
      </main>

      <StatusBar workspaceName={workspaceName} />
    </div>
  );
}
