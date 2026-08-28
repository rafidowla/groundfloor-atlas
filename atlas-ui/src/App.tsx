import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import WorkspaceLayout from './components/WorkspaceLayout';
import WorkspacesPage from './pages/WorkspacesPage';
import NewWorkspacePage from './pages/NewWorkspacePage';
import WorkspacePage from './pages/WorkspacePage';
import OnboardingPage from './pages/OnboardingPage';
import ChatPage from './pages/ChatPage';
import SettingsPage from './pages/SettingsPage';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/workspaces" replace />} />
        <Route element={<Layout />}>
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/new" element={<NewWorkspacePage />} />
          {/* B4 PART 2: graph + chat nest under WorkspaceLayout so the
              CitationProvider mounted there is a SHARED ancestor of both tabs.
              A citation set on /workspace/:id/chat therefore persists when the
              user switches to the graph tab (/workspace/:id). The graph is the
              index route; chat is a child. */}
          <Route path="/workspace/:id" element={<WorkspaceLayout />}>
            <Route index element={<WorkspacePage />} />
            <Route path="chat" element={<ChatPage />} />
          </Route>
          <Route path="/onboarding" element={<OnboardingPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Unknown URLs used to render the Layout chrome around an EMPTY
              main pane (no 404, no redirect). */}
          <Route path="*" element={<Navigate to="/workspaces" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
