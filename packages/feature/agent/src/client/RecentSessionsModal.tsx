'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadRecentSessions, type RecentSessionInfo } from './effect/agentClient';

interface RecentSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitchProject: (cwd: string, sessionId: string) => void;
}

/**
 * RecentSessionsModal — a searchable, cross-project view of every persisted
 * recent session (week-bounded, 15–100). Opened from the GlobalSessionMonitor
 * search button; complements the sidebar dropdown which only shows the top 15.
 *
 * Visually aligned with ProjectSessionsModal (same modal shell + grid card
 * layout + absolute timestamps + first/last message preview). The only
 * cross-project additions are the project name and the status dot, since this
 * panel spans projects whereas ProjectSessionsModal is single-project.
 *
 * Uses a full-viewport `fixed inset-0` overlay so it escapes the three-panel
 * SwipeableViewContainer boundaries (see CLAUDE.md UI layout notes).
 */
export function RecentSessionsModal({ isOpen, onClose, onSwitchProject }: RecentSessionsModalProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<RecentSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadRecentSessions());
    if (exit._tag === 'Success') {
      setSessions([...exit.value]);
    } else {
      setError(t('sessions.loadSessionsFailed'));
    }
    setIsLoading(false);
  }, [t]);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
      // Focus and select the retained keyword so typing replaces it
      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 100);
    }
  }, [isOpen, loadSessions]);

  // Close on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSessionClick = (session: RecentSessionInfo) => {
    onSwitchProject(session.cwd, session.sessionId);
    onClose();
  };

  const getProjectName = (cwd: string) => cwd.split('/').pop() || cwd;

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Match against the server-built full-text corpus (cwd + title + summary +
  // every user message, untruncated) so search isn't limited by the truncated,
  // 5+5-sampled display fields. Falls back to the display fields if an older
  // payload lacks searchText.
  const filteredSessions = sessions.filter((session) => {
    if (!searchKeyword) return true;
    const keyword = searchKeyword.toLowerCase();
    if (session.searchText !== undefined) {
      return session.searchText.includes(keyword);
    }
    return (
      session.cwd.toLowerCase().includes(keyword) ||
      (session.title?.toLowerCase().includes(keyword) ?? false) ||
      (session.lastUserMessage?.toLowerCase().includes(keyword) ?? false) ||
      (session.firstMessages?.some((m) => m.toLowerCase().includes(keyword)) ?? false) ||
      (session.lastMessages?.some((m) => m.toLowerCase().includes(keyword)) ?? false)
    );
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative w-full max-w-7xl h-[90vh] mx-4 bg-card rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-foreground">
              {t('sessions.recentSessions')}
            </h2>
          </div>
          <div className="flex items-center gap-3 ml-4">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t('sessions.searchSessions')}
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="px-2 py-1 pr-6 text-xs border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              {searchKeyword && (
                <button
                  onClick={() => {
                    setSearchKeyword('');
                    searchInputRef.current?.focus();
                  }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                  title={t('fileBrowser.clear')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{t('sessions.loadingSessions')}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-red-11">{error}</div>
            </div>
          )}

          {!isLoading && !error && filteredSessions.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-muted-foreground">
                {searchKeyword ? t('sessions.noMatchingSessions') : t('sessions.noSessions')}
              </div>
            </div>
          )}

          {!isLoading && !error && filteredSessions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredSessions.map((session) => (
                <div
                  key={`${session.cwd}-${session.sessionId}`}
                  onClick={() => handleSessionClick(session)}
                  className="p-3 bg-secondary rounded border border-border hover:border-brand hover:shadow-md cursor-pointer transition-all"
                >
                  {/* Project name + status dot + engine badge */}
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      session.status === 'loading'
                        ? 'bg-orange-9 animate-pulse'
                        : session.status === 'unread'
                          ? 'bg-red-500'
                          : 'bg-muted-foreground/30'
                    }`} />
                    {session.engine && session.engine !== 'claude' && (
                      <span className={`shrink-0 px-1 py-0.5 text-[10px] leading-none font-medium rounded ${
                        session.engine === 'claude2' ? 'bg-orange-500/15 text-orange-11' :
                        session.engine === 'ollama' ? 'bg-blue-500/15 text-blue-11' :
                        session.engine === 'codex' ? 'bg-green-500/15 text-green-11' :
                        session.engine === 'kimi' ? 'bg-purple-500/15 text-purple-11' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {session.engine}
                      </span>
                    )}
                    <h4 className="text-xs font-medium text-foreground truncate flex-1" title={session.cwd}>
                      {getProjectName(session.cwd)}
                    </h4>
                    {session.status === 'loading' && (
                      <span className="text-[10px] text-orange-11 flex-shrink-0">{t('sessions.running')}</span>
                    )}
                    {session.status === 'unread' && (
                      <span className="text-[10px] text-red-500 flex-shrink-0">{t('sessions.done')}</span>
                    )}
                  </div>

                  {/* Session title (ai-title / summary / first user message) */}
                  {session.title && (
                    <div className="text-xs font-medium text-foreground truncate mb-1" title={session.title}>
                      {session.title}
                    </div>
                  )}

                  {/* Session time (absolute, aligned with ProjectSessionsModal) */}
                  <div className="text-xs text-muted-foreground mb-2">
                    {formatDate(session.lastActive)}
                  </div>

                  {/* Messages preview: first/last user messages */}
                  {((session.firstMessages?.length ?? 0) > 0 || (session.lastMessages?.length ?? 0) > 0) ? (
                    <div className="space-y-0.5 text-xs">
                      {session.firstMessages?.map((msg, idx) => (
                        <div key={`first-${idx}`} className="text-foreground truncate" title={msg}>
                          <span className="text-slate-9 mr-1">•</span>
                          {msg}
                        </div>
                      ))}
                      {(session.lastMessages?.length ?? 0) > 0 && (
                        <div className="text-slate-9 text-center py-0.5">···</div>
                      )}
                      {session.lastMessages?.map((msg, idx) => (
                        <div key={`last-${idx}`} className="text-foreground truncate" title={msg}>
                          <span className="text-slate-9 mr-1">•</span>
                          {msg}
                        </div>
                      ))}
                    </div>
                  ) : session.lastUserMessage ? (
                    <div className="text-xs text-foreground truncate" title={session.lastUserMessage}>
                      <span className="text-slate-9 mr-1">•</span>
                      {session.lastUserMessage}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
