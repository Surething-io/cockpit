'use client';

import { useState, useCallback } from 'react';
import { MobileSessionList, type OpenableSession } from './MobileSessionList';
import { MobileChat } from './MobileChat';

// Root of the mobile experience (/m). Two screens — recent-session list and a
// single chat — with no desktop 3-panel layout or iframe. Self-paced view state;
// the URL is not deep-linked beyond the initial cwd/sessionId.
interface MobileAppProps {
  // Optional deep-link from the redirect (preserved query params).
  initialCwd?: string;
  initialSessionId?: string;
}

interface OpenSession {
  cwd: string;
  sessionId: string;
  title?: string;
}

export function MobileApp({ initialCwd, initialSessionId }: MobileAppProps) {
  const [active, setActive] = useState<OpenSession | null>(
    initialCwd && initialSessionId
      ? { cwd: initialCwd, sessionId: initialSessionId }
      : null,
  );

  const handleOpen = useCallback((session: OpenableSession) => {
    setActive({ cwd: session.cwd, sessionId: session.sessionId, title: session.title });
  }, []);

  const handleBack = useCallback(() => setActive(null), []);

  // Escape hatch: remember the choice so boot.js stops auto-redirecting, then
  // navigate to the desktop workspace.
  const handleUseDesktop = useCallback(() => {
    try { localStorage.setItem('cockpit-force-desktop', '1'); } catch { /* ignore */ }
    window.location.href = '/';
  }, []);

  if (active) {
    return (
      <MobileChat
        key={`${active.cwd}-${active.sessionId}`}
        cwd={active.cwd}
        initialSessionId={active.sessionId}
        initialTitle={active.title}
        onBack={handleBack}
      />
    );
  }

  return <MobileSessionList onOpen={handleOpen} onUseDesktop={handleUseDesktop} />;
}
