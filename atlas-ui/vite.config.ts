import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // Vite 8 (Rolldown) mistakes graphology's `import()` class-method definition
    // for a dynamic-import expression and wraps its first argument with
    // __vite__injectQuery(), producing `import(__vite__injectQuery(data,'import'),merge=false){`
    // which Chrome V8 rejects with SyntaxError. Pre-transform: rewrite the
    // method definition to computed-property bracket form so Vite never sees
    // a bare `import(` token that could be confused with an import expression.
    {
      name: 'patch-graphology-import-method',
      enforce: 'pre' as const,
      transform(code: string, id: string) {
        if (id.includes('/node_modules/graphology/')) {
          return code.replace(
            /\bimport\(data, merge = false\) \{/g,
            '["import"](data, merge = false) {',
          );
        }
      },
    },
    react(),
  ],
  resolve: {
    alias: {
      // Sprint 2: the single source of truth for node/edge display metadata
      // (colors, labels, sizes, vocab). Resolves to the backend's PURE-DATA
      // leaf `src/schema.display.ts`, which imports nothing from parser/ or
      // cli/, so the UI legend/filter colors match the rendered graph by
      // construction without bundling backend code. `import.meta.url` keeps
      // this resolution absolute without needing @types/node / __dirname.
      '@atlas-schema': fileURLToPath(
        new URL('../src/schema.display.ts', import.meta.url),
      ),
    },
  },
  // Vite 8 (Rolldown) incorrectly injects __vite__injectQuery() into graphology's
  // `import()` class method during dep pre-bundling, producing invalid JS that
  // Chrome V8 rejects with SyntaxError. Fix: exclude the graph packages from
  // pre-bundling so Vite serves them as native ESM (no injectQuery transform).
  // `events` must be force-included so graphology's `from 'events'` resolves to
  // the browser polyfill (pre-bundled) rather than the bare Node built-in.
  optimizeDeps: {
    exclude: ['graphology'],
    include: ['events'],
  },
  server: {
    port: 1421,
    strictPort: true,
    // Tauri's CSP (script-src 'self', no 'unsafe-inline') blocks the React Fast
    // Refresh preamble inline script, leaving $RefreshSig$ undefined and crashing
    // every component module before React can mount. hmr:false sets skipFastRefresh=true
    // in @vitejs/plugin-react so no preamble is injected. Full-page reload on save.
    hmr: false,
  },
  build: {
    outDir: 'dist',
    target: 'safari16',
    rollupOptions: {
      output: {
        // B4 PART 3: split the heavy graph-rendering vendors (sigma +
        // graphology + the react-sigma/layout wrappers) into their own chunk so
        // the main bundle drops under the 500 kB advisory and the graph code is
        // cached independently of app code.
        //
        // NOTE: vite 8 / rolldown rejects the object form of manualChunks
        // ("manualChunks is not a function"). The function form is the
        // supported API: route any module resolving into a graph-vendor
        // package into the shared `sigma` chunk.
        manualChunks(id: string) {
          if (
            /[\\/]node_modules[\\/](sigma|graphology|graphology-types|@react-sigma[\\/](?:core|layout-forceatlas2))[\\/]/.test(
              id,
            )
          ) {
            return 'sigma';
          }
          return undefined;
        },
      },
    },
  },
});
