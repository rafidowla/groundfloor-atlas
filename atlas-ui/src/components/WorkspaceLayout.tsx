/**
 * WorkspaceLayout.tsx — B4 PART 2: the per-workspace shared-state boundary.
 *
 * This is a routeless <Outlet/> wrapper mounted at "/workspace/:id". Its ONLY
 * job is to host the CitationProvider ABOVE both the graph tab (index route)
 * and the chat tab (chat route) so a citation set on chat survives a switch to
 * the graph tab. Without this, those two routes were siblings under <Layout>
 * with no common ancestor that could hold the citation store.
 *
 * Keying the provider by the :id param means navigating to a DIFFERENT
 * workspace remounts a fresh store (no cross-workspace citation leakage), while
 * switching between this workspace's own chat/graph tabs keeps the same store.
 */

import { Outlet, useParams } from 'react-router-dom';
import { CitationProvider } from '../graph/CitationProvider';

export default function WorkspaceLayout() {
  const { id } = useParams<{ id: string }>();
  return (
    <CitationProvider key={id ?? ''}>
      <Outlet />
    </CitationProvider>
  );
}
