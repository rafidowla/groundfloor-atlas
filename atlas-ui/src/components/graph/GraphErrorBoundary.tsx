import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Bug #6: a render error inside the Sigma graph (a forwardRef component) with no
 * boundary unmounts the WHOLE app → blank page. This boundary keeps the rest of
 * the workspace (rail, inspector, chrome) alive and shows the failure inline,
 * instead of taking the app down with it.
 */
export class GraphErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[GraphErrorBoundary] graph render crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full items-center justify-center p-6">
          <div className="max-w-lg rounded-md border border-red-900/50 bg-red-950/30 p-4">
            <p className="text-sm font-semibold text-red-300">Graph failed to render</p>
            <p className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-red-400">
              {this.state.error.message}
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default GraphErrorBoundary;
