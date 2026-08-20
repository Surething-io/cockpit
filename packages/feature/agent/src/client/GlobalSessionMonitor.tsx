'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { RecentSessionsModal } from './RecentSessionsModal';
import { EngineBadge } from './EngineBadge';
import { SessionNumberBadge, badgeStatus } from './SessionNumberBadge';
import {
  SessionStatusDot,
  SessionHoverCard,
  useSessionHoverCard,
  formatRelativeTime,
  statusLabelOf,
  projectNameOf,
} from './SessionRowParts';

export interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;
  title?: string;
  lastUserMessage?: string;
  firstMessages?: string[];
  lastMessages?: string[];
  engine?: string;
}

interface GlobalSessionMonitorProps {
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onResolveSessionNumbers: () => Promise<Record<string, string>>;
  collapsed?: boolean;
  sessions: GlobalSession[];
}

export function GlobalSessionMonitor({ currentCwd, onSwitchProject, onResolveSessionNumbers, collapsed, sessions }: GlobalSessionMonitorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sessionNumbers, setSessionNumbers] = useState<Record<string, string>>({});
  const numberRequestRef = useRef(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Row anatomy shared with PinnedSessionsPanel — see SessionRowParts.
  const hover = useSessionHoverCard();
  const { show: showCard, hide: hideCard } = hover;

  // Drop the hover card whenever the dropdown closes (e.g. outside click / blur)
  useEffect(() => {
    if (!isOpen) hideCard();
  }, [isOpen, hideCard]);

  // Close on outside click (including clicking into an iframe)
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    // Clicking an iframe causes the parent window to lose focus
    const handleBlur = () => {
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);

  // Switch to the specified session (iframe SWITCH_SESSION handler writes state.json status=normal)
  const handleSessionClick = useCallback((session: GlobalSession) => {
    onSwitchProject(session.cwd, session.sessionId);
    setIsOpen(false);
  }, [onSwitchProject]);

  const handleToggle = useCallback(() => {
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      const request = ++numberRequestRef.current;
      setSessionNumbers({});
      void onResolveSessionNumbers().then((numbers) => {
        if (numberRequestRef.current === request) setSessionNumbers(numbers);
      });
    } else {
      numberRequestRef.current += 1;
    }
  }, [isOpen, onResolveSessionNumbers]);

  const loadingCount = sessions.filter(s => s.status === 'loading').length;
  const unreadCount = sessions.filter(s => s.status === 'unread').length;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleToggle}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('sessions.recentSessions') : undefined}
      >
        {/* Lightning icon indicates active state */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.recentSessions')}</span>}
        {/* Badge: loading orange pulse + unread red static, displayed independently.
            A tinted pill with a coloured numeral rather than white-on-saturated-fill:
            same family as the session number badges, still loud enough to catch. */}
        {loadingCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-foreground text-xs font-medium rounded-full flex items-center justify-center bg-orange-11/20 animate-pulse ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {loadingCount}
          </span>
        )}
        {unreadCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-foreground text-xs font-medium rounded-full flex items-center justify-center bg-red-9/55 ${
            collapsed && !loadingCount ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown list - pops up to the upper right */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 h-[600px] bg-popover border border-border rounded-lg shadow-lv2 z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg flex items-center">
            <span className="text-sm font-medium">{t('sessions.recentSessions')}</span>
            {loadingCount > 0 && (
              <span className="ml-2 text-xs text-orange-11">({t('sessions.runningCount', { count: loadingCount })})</span>
            )}
            {unreadCount > 0 && (
              <span className="ml-2 text-xs text-red-11">({t('sessions.unreadCount', { count: unreadCount })})</span>
            )}
            {/* Expand into the full searchable recent-sessions panel (up to 100) */}
            <button
              onClick={() => { setIsOpen(false); setSearchOpen(true); }}
              className="ml-auto flex items-center gap-1 p-1 -mr-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
              title={t('sessions.searchRecentSessions')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m21 21-4.35-4.35m2.35-5.4a7.75 7.75 0 1 1-15.5 0 7.75 7.75 0 0 1 15.5 0Z" />
              </svg>
              <span className="text-xs">{t('sessions.search')}</span>
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                {t('sessions.noSessions')}
              </div>
            ) : (
              sessions.map((session, index) => (
                <button
                  key={`${session.cwd}-${session.sessionId}`}
                  onClick={() => handleSessionClick(session)}
                  onMouseEnter={(e) => showCard(session, e)}
                  onMouseLeave={hideCard}
                  className={`w-full px-3 py-2 text-left hover:bg-hover transition-colors flex items-start gap-2 ${
                    index !== sessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${currentCwd === session.cwd ? 'bg-accent/50' : ''}`}
                >
                  <SessionStatusDot status={session.status} className="mt-1.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <EngineBadge engine={session.engine} />
                      <span className="font-medium text-sm truncate">
                        {projectNameOf(session.cwd)}
                      </span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatRelativeTime(t, session.lastActive)}
                      </span>
                      {/* Running/done is carried by the round session chip (pulsing wash /
                          solid red) instead of a word — the label repeated what the dot
                          already said and cost the project name its truncation budget. */}
                      <SessionNumberBadge
                        coordinate={sessionNumbers[`${session.cwd}\n${session.sessionId}`]}
                        status={badgeStatus(session.status)}
                        statusLabel={statusLabelOf(t, session.status)}
                        className="ml-auto"
                      />
                    </div>
                    {session.title && (
                      <div className="text-xs font-medium text-foreground truncate" data-tooltip={session.title}>
                        {session.title}
                      </div>
                    )}
                    {session.lastUserMessage && (
                      <div className="text-xs text-foreground/80 truncate">
                        {session.lastUserMessage}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Rich hover card: path + branch + first/last user-message preview */}
      <SessionHoverCard {...hover} />

      {/* Searchable full recent-sessions panel (up to 100) */}
      <RecentSessionsModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSwitchProject={onSwitchProject}
        sessionNumbers={sessionNumbers}
      />
    </div>
  );
}
