'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MODAL_SHELL_CLASS } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadRecentSessions, type RecentSessionInfo } from './effect/agentClient';
import { EngineBadge } from './EngineBadge';
import { SessionNumberBadge, badgeStatus } from './SessionNumberBadge';
import { SessionTranscriptPreview } from './SessionTranscriptPreview';
import { sortSessionsForDisplay } from './sessionOrder';
import { formatRelativeTime, statusLabelOf, groupByProject, ProjectGroupHeader } from './SessionRowParts';

const keyOf = (cwd: string, sessionId: string) => `${cwd}\n${sessionId}`;

interface RecentSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  sessionNumbers?: Record<string, string>;
  /** Sidebar project order — numbers each group's chip like the project list. */
  projectOrder: readonly string[];
  /** Project of the active tab — its group chip is drawn active. */
  currentCwd?: string;
  /** The live /ws/global-state feed (top 20). Overlaid on the fetched list so
   *  status, title and last message keep moving while the board is open. */
  liveSessions: readonly RecentSessionInfo[];
}

/**
 * RecentSessionsModal — the board the sidebar "recent sessions" entry opens:
 * every persisted recent session (week-bounded, 20–100) on the left, grouped
 * by project, and the selected session's transcript on the right.
 *
 * Grouping runs over the status-sorted list (sessionOrder: unread → running →
 * most recent) in order of first appearance, so a project holding an unread
 * session floats to the top, then one with a running session, then by recency;
 * rows inside a group follow the same order. The urgent-first property of the
 * old status groups survives without a second level of nesting. Same shell and split as PinnedSessionsPanel and
 * ScheduledTasksPanel — look first, then open.
 *
 * Two sources, one list:
 * - `/api/global-state`, fetched once per open: the full list plus `searchText`
 *   (cwd + title + summary + every user message, untruncated) for search.
 * - the live socket feed (`liveSessions`, top 20): wins field-by-field on the
 *   sessions it carries, so a run finishing while the board is open moves its
 *   row into "done · unread" without a refetch. Sessions it carries that the
 *   fetch predates are included too.
 *
 * Previewing does NOT mark a session read; only opening it does (the switch
 * path writes status=normal). The board auto-selects its first row, which is
 * usually the unread one — reading on select would clear it unseen.
 *
 * Uses a full-viewport `fixed inset-0` overlay so it escapes the three-panel
 * SwipeableViewContainer boundaries (see CLAUDE.md UI layout notes).
 */
export function RecentSessionsModal({ isOpen, onClose, onSwitchProject, sessionNumbers = {}, projectOrder, currentCwd, liveSessions }: RecentSessionsModalProps) {
  const { t } = useTranslation();
  const [fetched, setFetched] = useState<RecentSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Which session the right-hand transcript follows, keyed `${cwd}\n${sessionId}`.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadRecentSessions());
    if (exit._tag === 'Success') {
      setFetched([...exit.value]);
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
    } else {
      setSelectedKey(null);
    }
  }, [isOpen, loadSessions]);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Fetched list with the live feed laid over it (see header comment). The live
  // snapshot carries no searchText, so the fetched one is kept for search.
  const sessions = useMemo(() => {
    const live = new Map(liveSessions.map((s) => [keyOf(s.cwd, s.sessionId), s]));
    const merged = fetched.map((s) => {
      const l = live.get(keyOf(s.cwd, s.sessionId));
      if (!l) return s;
      live.delete(keyOf(s.cwd, s.sessionId));
      return { ...s, ...l, searchText: l.searchText ?? s.searchText };
    });
    return sortSessionsForDisplay([...merged, ...live.values()]);
  }, [fetched, liveSessions]);

  // Match against the server-built full-text corpus so search isn't limited by
  // the truncated display fields. Falls back to the display fields for rows
  // that lack searchText (live-only rows, older payloads).
  const filteredSessions = useMemo(() => {
    if (!searchKeyword) return sessions;
    const keyword = searchKeyword.toLowerCase();
    return sessions.filter((session) => {
      if (session.searchText !== undefined) return session.searchText.includes(keyword);
      return (
        session.cwd.toLowerCase().includes(keyword) ||
        (session.title?.toLowerCase().includes(keyword) ?? false) ||
        (session.lastUserMessage?.toLowerCase().includes(keyword) ?? false) ||
        (session.firstMessages?.some((m) => m.toLowerCase().includes(keyword)) ?? false) ||
        (session.lastMessages?.some((m) => m.toLowerCase().includes(keyword)) ?? false)
      );
    });
  }, [sessions, searchKeyword]);

  const groups = useMemo(() => groupByProject(filteredSessions), [filteredSessions]);
  const runningCount = sessions.filter((s) => s.status === 'loading').length;
  const unreadCount = sessions.filter((s) => s.status === 'unread').length;

  const selected = selectedKey
    ? sessions.find((s) => keyOf(s.cwd, s.sessionId) === selectedKey) ?? null
    : null;

  // Auto-select the first row in board order, so opening shows a transcript
  // without a click. Only fills a hole; never steals a selection the user made.
  useEffect(() => {
    if (!isOpen || selected) return;
    const first = filteredSessions[0];
    setSelectedKey(first ? keyOf(first.cwd, first.sessionId) : null);
  }, [isOpen, selected, filteredSessions]);

  // The switch path marks the session read (iframe SWITCH_SESSION handler
  // writes state.json status=normal).
  const openSession = useCallback((session: RecentSessionInfo) => {
    onSwitchProject(session.cwd, session.sessionId);
    onClose();
  }, [onSwitchProject, onClose]);

  const titleOf = (session: RecentSessionInfo) => session.title || session.sessionId;

  const renderCard = (session: RecentSessionInfo) => {
    const key = keyOf(session.cwd, session.sessionId);
    const isSelected = key === selectedKey;
    return (
      <div
        key={key}
        onClick={() => setSelectedKey(key)}
        onDoubleClick={() => openSession(session)}
        className={`rounded-md px-3 py-2 cursor-pointer transition-colors ${
          isSelected ? 'bg-brand/10' : 'hover:bg-hover'
        }`}
      >
        {/* The project is the group header now, so the row leads with the title. */}
        <div className="flex items-center gap-1.5">
          <EngineBadge engine={session.engine} />
          <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0" data-tooltip={titleOf(session)}>
            {titleOf(session)}
          </span>
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {formatRelativeTime(t, session.lastActive)}
          </span>
          {/* Running/done is carried by the round session chip. When its
              coordinate is unknown it uses the project-list `·` marker. */}
          <SessionNumberBadge
            coordinate={sessionNumbers[key]}
            status={badgeStatus(session.status)}
            statusLabel={statusLabelOf(t, session.status)}
            bot={session.bot}
          />
        </div>
        {session.lastUserMessage && (
          <div className="text-xs text-muted-foreground truncate mt-0.5 pl-[22px]" data-tooltip={session.lastUserMessage}>
            {session.lastUserMessage}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  const listBody = () => {
    // The live feed can fill the list before the fetch lands, so loading and
    // error only take over while there is nothing at all to show.
    if (sessions.length === 0 && isLoading) {
      return <div className="text-xs text-muted-foreground text-center py-6">{t('sessions.loadingSessions')}</div>;
    }
    if (sessions.length === 0 && error) {
      return <div className="text-xs text-red-11 text-center py-6">{error}</div>;
    }
    if (filteredSessions.length === 0) {
      return (
        <div className="text-xs text-muted-foreground text-center py-6">
          {searchKeyword ? t('sessions.noMatchingSessions') : t('sessions.noSessions')}
        </div>
      );
    }
    return groups.map((group) => {
      const running = group.items.filter((s) => s.status === 'loading').length;
      const unread = group.items.filter((s) => s.status === 'unread').length;
      return (
        /* One card per project. No overflow-hidden here: it would make the
           card the sticky header's scroll container. */
        <div key={group.cwd} className="rounded-lg border border-border">
          <ProjectGroupHeader cwd={group.cwd} projectOrder={projectOrder} currentCwd={currentCwd}>
            {unread > 0 && <span className="text-orange-11">· {t('sessions.unreadCount', { count: unread })}</span>}
            {running > 0 && <span className="text-orange-11">· {t('sessions.runningCount', { count: running })}</span>}
            <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
          </ProjectGroupHeader>
          <div className="p-1 space-y-0.5">{group.items.map(renderCard)}</div>
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />

      {/* Modal */}
      <div className={MODAL_SHELL_CLASS}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-medium text-foreground">{t('sessions.recentSessions')}</h2>
            {runningCount > 0 && (
              <span className="text-xs text-orange-11">{t('sessions.runningCount', { count: runningCount })}</span>
            )}
            {unreadCount > 0 && (
              <span className="text-xs text-orange-11">{t('sessions.unreadCount', { count: unreadCount })}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — search + grouped list on the left, transcript on the right */}
        <div className="flex-1 flex min-h-0">
          <div className="w-full md:w-[360px] min-h-0 flex-shrink-0 md:border-r border-border flex flex-col">
            {/* Own bottom padding + divider: the list scrolls below this line,
                so its sticky group label never butts up against the input or
                clips its focus ring. */}
            <div className="p-3 flex-shrink-0 border-b border-border">
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  placeholder={t('sessions.searchSessions')}
                  value={searchKeyword}
                  onChange={(e) => setSearchKeyword(e.target.value)}
                  className="w-full px-2 py-1 pr-6 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
                {searchKeyword && (
                  <button
                    onClick={() => {
                      setSearchKeyword('');
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                    title={t('fileBrowser.clear')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {/* Keep padding off the scroll node: a sticky group label uses the
                scrollport's padding edge as its inset, which would leave a strip
                of old cards visible above it while scrolling. */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="p-3 space-y-3">{listBody()}</div>
            </div>
          </div>

          {/* Right: the selected session's transcript. Below `md` it is dropped
              and the list takes the full width (double-click opens). */}
          <div className="hidden md:flex flex-1 min-w-0">
            {selected ? (
              <SessionTranscriptPreview
                // Remount per session: transcript, fingerprint and scroll
                // position only make sense for one session.
                key={keyOf(selected.cwd, selected.sessionId)}
                cwd={selected.cwd}
                sessionId={selected.sessionId}
                subtitle={titleOf(selected)}
                emptyText={t('sessions.noSessionMessages')}
                onOpenSession={() => openSession(selected)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                {t('sessions.selectSessionHint')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
