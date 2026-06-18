'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { fetchCurrentBranch } from '@cockpit/feature-explorer';

export interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;
  title?: string;
  lastUserMessage?: string;
  firstMessages?: string[];
  lastMessages?: string[];
}

interface GlobalSessionMonitorProps {
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  collapsed?: boolean;
  sessions: GlobalSession[];
}

export function GlobalSessionMonitor({ currentCwd, onSwitchProject, collapsed, sessions }: GlobalSessionMonitorProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Rich tooltip: which session is hovered + where to anchor it (fixed positioning
  // escapes the dropdown's overflow-y-auto clipping)
  const [tooltip, setTooltip] = useState<{ session: GlobalSession; top: number; left: number } | null>(null);
  // Per-cwd git branch cache (null = fetched, not a git repo / detached HEAD).
  // Lazily fetched on hover via the lightweight /api/git/current-branch (mirrors ProjectItem).
  const [branches, setBranches] = useState<Record<string, string | null>>({});

  const showTooltip = useCallback((session: GlobalSession, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const TOOLTIP_MAX_H = 260;
    let top = rect.top;
    if (top + TOOLTIP_MAX_H > window.innerHeight) {
      top = Math.max(8, window.innerHeight - TOOLTIP_MAX_H - 8);
    }
    setTooltip({ session, top, left: rect.right + 8 });
    // Fetch the branch once per cwd; reuse the cached value on subsequent hovers.
    setBranches((prev) => {
      if (session.cwd in prev) return prev;
      BrowserRuntime.runPromiseExit(fetchCurrentBranch(session.cwd)).then((exit) => {
        if (exit._tag === 'Success') {
          setBranches((cur) => ({ ...cur, [session.cwd]: exit.value.branch }));
        }
      });
      return { ...prev, [session.cwd]: null };
    });
  }, []);
  const hideTooltip = useCallback(() => setTooltip(null), []);

  // Drop the tooltip whenever the dropdown closes (e.g. outside click / blur)
  useEffect(() => {
    if (!isOpen) setTooltip(null);
  }, [isOpen]);

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
    setTooltip(null);
  }, [onSwitchProject]);

  const loadingCount = sessions.filter(s => s.status === 'loading').length;
  const unreadCount = sessions.filter(s => s.status === 'unread').length;

  // Format timestamp
  const formatTime = useCallback((timestamp: number) => {
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return t('common.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('common.hoursAgo', { count: hours });
    return t('common.daysAgo', { count: Math.floor(hours / 24) });
  }, [t, now]);

  // Get project name
  const getProjectName = (cwd: string) => cwd.split('/').pop() || cwd;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => { setNow(Date.now()); setIsOpen(!isOpen); }}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={t('sessions.recentSessions')}
      >
        {/* Lightning icon indicates active state */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.recentSessions')}</span>}
        {/* Badge: loading orange pulse + unread red static, displayed independently */}
        {loadingCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-orange-9 animate-pulse ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {loadingCount}
          </span>
        )}
        {unreadCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-red-500 ${
            collapsed && !loadingCount ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown list - pops up to the upper right */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 h-[450px] bg-popover border border-border rounded-lg shadow-lg z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg">
            <span className="text-sm font-medium">{t('sessions.recentSessions')}</span>
            {loadingCount > 0 && (
              <span className="ml-2 text-xs text-orange-11">({t('sessions.runningCount', { count: loadingCount })})</span>
            )}
            {unreadCount > 0 && (
              <span className="ml-2 text-xs text-red-500">({t('sessions.unreadCount', { count: unreadCount })})</span>
            )}
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
                  onMouseEnter={(e) => showTooltip(session, e)}
                  onMouseLeave={hideTooltip}
                  className={`w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-start gap-2 ${
                    index !== sessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${currentCwd === session.cwd ? 'bg-accent/50' : ''}`}
                >
                  {/* Status indicator: loading blinking orange dot / unread red static dot / normal gray dot */}
                  <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                    session.status === 'loading'
                      ? 'bg-orange-9 animate-pulse'
                      : session.status === 'unread'
                        ? 'bg-red-500'
                        : 'bg-muted-foreground/30'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {getProjectName(session.cwd)}
                      </span>
                      {session.status === 'loading' && (
                        <span className="text-xs text-orange-11 flex-shrink-0">{t('sessions.running')}</span>
                      )}
                      {session.status === 'unread' && (
                        <span className="text-xs text-red-500 flex-shrink-0">{t('sessions.done')}</span>
                      )}
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatTime(session.lastActive)}
                      </span>
                    </div>
                    {(session.lastUserMessage || session.title) && (
                      <div className="text-xs text-foreground/80 truncate">
                        {session.lastUserMessage || session.title}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Rich hover tooltip: cwd path + first/last user-message preview (mirrors ProjectSessionsModal cards) */}
      {tooltip && (
        <div
          className="fixed z-[60] w-72 max-h-[260px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lg p-3 pointer-events-none"
          style={{ top: tooltip.top, left: tooltip.left }}
        >
          <div className="text-xs font-medium text-foreground truncate">{getProjectName(tooltip.session.cwd)}</div>
          {branches[tooltip.session.cwd] && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground font-normal min-w-0">
              {/* git branch icon — signals this is a git branch */}
              <svg className="w-3 h-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="6" cy="6" r="2.5" />
                <circle cx="6" cy="18" r="2.5" />
                <circle cx="18" cy="7" r="2.5" />
                <path strokeLinecap="round" d="M6 8.5v7M8.5 6.5h4.5a3 3 0 013 3v0" />
              </svg>
              <span className="truncate">{branches[tooltip.session.cwd]}</span>
            </div>
          )}
          {((tooltip.session.firstMessages?.length ?? 0) > 0 || (tooltip.session.lastMessages?.length ?? 0) > 0) ? (
            <div className="space-y-0.5 text-xs border-t border-border/50 mt-2 pt-2">
              {tooltip.session.firstMessages?.map((msg, idx) => (
                <div key={`f-${idx}`} className="text-foreground/90 truncate">
                  <span className="text-slate-9 mr-1">•</span>
                  {msg}
                </div>
              ))}
              {(tooltip.session.lastMessages?.length ?? 0) > 0 && (
                <div className="text-slate-9 text-center py-0.5">···</div>
              )}
              {tooltip.session.lastMessages?.map((msg, idx) => (
                <div key={`l-${idx}`} className="text-foreground/90 truncate">
                  <span className="text-slate-9 mr-1">•</span>
                  {msg}
                </div>
              ))}
            </div>
          ) : (tooltip.session.lastUserMessage || tooltip.session.title) ? (
            /* Fallback (e.g. running sessions skipped on the WS path): show whatever message the item already has */
            <div className="text-xs text-foreground/90 border-t border-border/50 mt-2 pt-2 line-clamp-3 break-words">
              {tooltip.session.lastUserMessage || tooltip.session.title}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
