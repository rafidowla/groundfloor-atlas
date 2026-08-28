import { StrictMode, Component } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { ThemeProvider } from './contexts/ThemeContext';
import { ensureMcpToken } from './api/atlasApi';

// Apply stored theme before first paint to avoid flash
const storedTheme = localStorage.getItem('lb-theme') ?? 'dark';
document.documentElement.setAttribute('data-theme', storedTheme);

// RC security — capture the launch-URL bearer token (`?token=…`, the Jupyter
// model) SYNCHRONOUSLY, before React Router mounts. App.tsx redirects `/` →
// `/workspaces` via <Navigate replace>, which drops the query string; if the
// token is only read lazily on the first API call (after that redirect), it's
// already gone and every authenticated call 401s. ensureMcpToken()'s body is
// synchronous (a DOM read + history.replaceState — no await before the read),
// so this stores + scrubs the token before first render; the returned promise
// is intentionally not awaited.
void ensureMcpToken();

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ color: 'red', padding: '2rem', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          {'Groundfloor Atlas render error:\n' + (this.state.error as Error).message + '\n' + (this.state.error as Error).stack}
        </pre>
      );
    }
    return this.props.children;
  }
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
