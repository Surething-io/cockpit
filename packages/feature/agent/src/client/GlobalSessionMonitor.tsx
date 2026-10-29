'use client';

import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import { sessionNumberClass } from '@cockpit/shared-ui';
import { RecentSessionsModal } from './RecentSessionsModal';
import type { GlobalSessionInfo } from '../shared/sessionDto';

/** The session rows this panel renders. Field list: shared/sessionDto.ts — the
 *  same declaration the server builds the payload against. */
export type GlobalSession = GlobalSessionInfo;

interface GlobalSessionMonitorProps {
  /** Sidebar project order and the active project — the board's group chips. */
  projectOrder: readonly string[];
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onResolveSessionNumbers: () => Promise<Record<string, string>>;
  collapsed?: boolean;
  sessions: GlobalSession[];
}

/**
 * GlobalSessionMonitor — the sidebar "recent sessions" entry: the button with
 * its live running/unread badges, and the RecentSessionsModal board it opens
 * (list + transcript preview + search, fed by `sessions` live).
 */
export function GlobalSessionMonitor({ projectOrder, currentCwd, onSwitchProject, onResolveSessionNumbers, collapsed, sessions }: GlobalSessionMonitorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [sessionNumbers, setSessionNumbers] = useState<Record<string, string>>({});
  const numberRequestRef = useRef(0);

  const handleOpen = useCallback(() => {
    setIsOpen(true);
    const request = ++numberRequestRef.current;
    setSessionNumbers({});
    void onResolveSessionNumbers().then((numbers) => {
      if (numberRequestRef.current === request) setSessionNumbers(numbers);
    });
  }, [onResolveSessionNumbers]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    numberRequestRef.current += 1;
  }, []);

  const loadingCount = sessions.filter(s => s.status === 'loading').length;
  const unreadCount = sessions.filter(s => s.status === 'unread').length;

  return (
    <>
      <button
        onClick={handleOpen}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('sessions.recentSessions') : undefined}
      >
        {/* History, not a lightning bolt: the bolt reads as "quick action" and is
            already the chat/console quick-instructions mark, which is on screen at
            the same time as this rail. Liveness is carried by the badges below
            (spinning orange ring = running, solid orange = unread), so the icon is free to say
            what the label says — recent. */}
        <History className="w-5 h-5 flex-shrink-0" />
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.recentSessions')}</span>}
        {/* Badge: loading orange spinner + unread static wash, displayed independently.
            A tinted pill with a coloured numeral rather than white-on-saturated-fill:
            same family as the session number badges, still loud enough to catch. */}
        {loadingCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-xs font-medium rounded-full flex items-center justify-center ${sessionNumberClass('loading', false)} ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {loadingCount}
          </span>
        )}
        {unreadCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 bg-orange-11/15 text-orange-11 text-xs font-medium rounded-full flex items-center justify-center ${
            collapsed && !loadingCount ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        )}
      </button>

      <RecentSessionsModal
        isOpen={isOpen}
        onClose={handleClose}
        onSwitchProject={onSwitchProject}
        sessionNumbers={sessionNumbers}
        projectOrder={projectOrder}
        currentCwd={currentCwd}
        liveSessions={sessions}
      />
    </>
  );
}
