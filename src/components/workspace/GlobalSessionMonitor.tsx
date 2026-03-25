'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

export interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: string;
  title?: string;
  lastUserMessage?: string;
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
                  <div className="flex-1 min-w-0" title={session.cwd}>
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
    </div>
  );
}
