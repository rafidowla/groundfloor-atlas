/**
 * ChatPage.tsx — the full-page Chat tab.
 *
 * All chat logic now lives in components/chat/ChatPanel (so the graph page can
 * dock the SAME chat in a side panel). This page is a thin route wrapper that
 * renders the panel full-bleed.
 */

import { useParams } from 'react-router-dom';
import ChatPanel from '../components/chat/ChatPanel';

export default function ChatPage() {
  const { id: workspaceName = '' } = useParams<{ id: string }>();
  return <ChatPanel workspaceName={workspaceName} />;
}
