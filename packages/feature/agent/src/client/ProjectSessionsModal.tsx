'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { MODAL_SHELL_CLASS_IN_PROJECT } from '@cockpit/shared-ui';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { BrowserRuntime } from '@cockpit/effect-runtime';
// Deep subpath, not the barrel — the barrel pulls in paths.ts (node fs/os/path).
import { encodePath } from '@cockpit/shared-utils/encodePath';
import { loadSessionsByProject } from './effect/agentClient';
import { EngineBadge } from './EngineBadge';
import { SessionNumberBadge } from './SessionNumberBadge';
import { SessionTranscriptPreview } from './SessionTranscriptPreview';
import { formatRelativeTime } from './SessionRowParts';
import type { SessionListItem } from '../shared/sessionDto';

/** Rows come straight from /api/sessions/projects/[encodedPath]. */
type SessionInfo = SessionListItem;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date groups, top to bottom. */
const DATE_GROUPS = [
  { key: 'today', labelKey: 'sessions.dateToday' },
  { key: 'yesterday', labelKey: 'sessions.dateYesterday' },
  { key: 'last7Days', labelKey: 'sessions.dateLast7Days' },
  { key: 'earlier', labelKey: 'sessions.dateEarlier' },
] as const;

export type DateGroupKey = (typeof DATE_GROUPS)[number]['key'];

/**
 * Which date group a timestamp falls in, by LOCAL calendar day — "yesterday" is
 * the day before today's midnight, not "24–48 hours ago". "Last 7 days" covers
 * the five days before yesterday, so the four groups never overlap.
 */
export function dateGroupOf(timestamp: number, now: number = Date.now()): DateGroupKey {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const startOfToday = midnight.getTime();
  if (timestamp >= startOfToday) return 'today';
  if (timestamp >= startOfToday - DAY_MS) return 'yesterday';
  if (timestamp >= startOfToday - 6 * DAY_MS) return 'last7Days';
  return 'earlier';
}

/** sessionId from the row, falling back to the transcript's file name. */
const sessionIdOf = (session: SessionInfo) =>
  session.sessionId || (session.path.split('/').pop() || '').replace('.jsonl', '');

interface ProjectSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
  /**
   * Only the id and title: the session's engine/mode/preferences are restored by the host
   * from session.json + the transcript's store, so this list does not carry them.
   */
  onSelectSession?: (sessionId: string, title?: string) => void;
  projectNumber?: number;
  openSessionIds?: Array<string | undefined>;
}

/**
 * ProjectSessionsModal — every session of ONE project (the tab bar's sessions
 * button), as the same list + preview board the sidebar boards use: date-grouped
 * list with search on the left, the selected session's transcript on the right.
 *
 * Not grouped by project — there is only one — but by local calendar day
 * (today / yesterday / last 7 days / earlier), since this list is the project's
 * whole history rather than a week-bounded slice.
 *
 * Click previews; double-click or "Open session" opens it, which is still
 * `onSelectSession` → a tab in this project. Sessions already open as a tab keep
 * their tab-number chip.
 *
 * Rendered inside the project iframe, hence MODAL_SHELL_CLASS_IN_PROJECT and
 * z-50 rather than the host window's boards' z-[70].
 */
export function ProjectSessionsModal({ isOpen, onClose, cwd, onSelectSession, projectNumber, openSessionIds = [] }: ProjectSessionsModalProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // When the list was loaded — the "now" the date groups are cut against. Taken
  // at load rather than at render, so the grouping is stable while the board is
  // open; every open reloads the list and moves it forward.
  const [loadedAt, setLoadedAt] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Which session the right-hand transcript follows (by sessionId).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Load the session list for the current project
  const loadSessions = useCallback(async () => {
    if (!cwd) return;

    setIsLoading(true);
    setError(null);

    // Encode cwd as directory name format. Must go through the shared helper —
    // this used to inline its own copy of the rule and drifted from the server.
    const encodedPath = encodePath(cwd);
    const exit = await BrowserRuntime.runPromiseExit(loadSessionsByProject<SessionInfo>(encodedPath));
    if (exit._tag === 'Success') {
      setSessions(exit.value as SessionInfo[]);
      setLoadedAt(Date.now());
    } else {
      setError('Failed to load sessions');
    }
    setIsLoading(false);
  }, [cwd]);

  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null);
      return;
    }
    loadSessions();
    // Focus and select the retained keyword so typing replaces it
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 100);
  }, [isOpen, loadSessions]);

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const openSession = (session: SessionInfo) => {
    const sessionId = sessionIdOf(session);

    if (onSelectSession) {
      // Use onSelectSession callback if provided (adds a new tab in TabManager)
      onSelectSession(sessionId, session.title);
      onClose();
    } else {
      // Otherwise notify parent Workspace to open
      publishTopic(Topics.OpenProject, { cwd, sessionId });
    }
  };

  // Newest first, then filtered. Match against the server-built full-text
  // corpus (title + summary + every user message, untruncated) so search isn't
  // limited by the truncated, 5+5-sampled display fields. Falls back to display
  // fields for older payloads.
  const filteredSessions = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    if (!searchKeyword) return sorted;
    const keyword = searchKeyword.toLowerCase();
    return sorted.filter((session) => {
      if (session.searchText !== undefined) return session.searchText.includes(keyword);
      return (
        session.title.toLowerCase().includes(keyword) ||
        session.firstMessages.some((msg) => msg.toLowerCase().includes(keyword)) ||
        session.lastMessages.some((msg) => msg.toLowerCase().includes(keyword))
      );
    });
  }, [sessions, searchKeyword]);

  const groups = useMemo(() => {
    const out: Record<DateGroupKey, SessionInfo[]> = { today: [], yesterday: [], last7Days: [], earlier: [] };
    for (const session of filteredSessions) out[dateGroupOf(Date.parse(session.modifiedAt), loadedAt)].push(session);
    return out;
  }, [filteredSessions, loadedAt]);

  const selected = selectedId ? sessions.find((s) => sessionIdOf(s) === selectedId) ?? null : null;

  // Auto-select the newest row so the board opens on a transcript. Only fills a
  // hole; never steals a selection the user made.
  useEffect(() => {
    if (!isOpen || selected) return;
    const first = filteredSessions[0];
    setSelectedId(first ? sessionIdOf(first) : null);
  }, [isOpen, selected, filteredSessions]);

  if (!isOpen) return null;

  const renderRow = (session: SessionInfo) => {
    const sessionId = sessionIdOf(session);
    const tabIndex = openSessionIds.indexOf(sessionId);
    const isSelected = sessionId === selectedId;
    const lastMessage = session.lastMessages[session.lastMessages.length - 1] ?? session.firstMessages[0];
    return (
      <div
        key={session.path}
        onClick={() => setSelectedId(sessionId)}
        onDoubleClick={() => openSession(session)}
        className={`rounded-md px-3 py-2 cursor-pointer transition-colors ${
          isSelected ? 'bg-brand/10' : 'hover:bg-hover'
        }`}
      >
        <div className="flex items-center gap-1.5">
          <EngineBadge engine={session.engine} />
          <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0">
            {session.title}
          </span>
          <span className="text-[10px] text-muted-foreground flex-shrink-0">
            {formatRelativeTime(t, Date.parse(session.modifiedAt))}
          </span>
          {projectNumber && tabIndex >= 0 && (
            <SessionNumberBadge projectNumber={projectNumber} sessionNumber={tabIndex + 1} bot={session.bot} />
          )}
        </div>
        {lastMessage && (
          <div className="text-xs text-muted-foreground truncate mt-0.5 pl-[22px]">{lastMessage}</div>
        )}
      </div>
    );
  };

  const listBody = () => {
    if (sessions.length === 0 && isLoading) {
      return <div className="text-xs text-muted-foreground text-center py-6">{t('sessions.loadingSessions')}</div>;
    }
    if (sessions.length === 0 && error) {
      return <div className="text-xs text-red-11 text-center py-6">{error}</div>;
    }
    if (filteredSessions.length === 0) {
      return (
        <div className="text-xs text-muted-foreground text-center py-6">
          {searchKeyword ? t('sessions.noMatchingSessions') : t('sessions.noSessionsYet')}
        </div>
      );
    }
    return DATE_GROUPS.map(({ key, labelKey }) => {
      const items = groups[key];
      // Empty groups render nothing at all — no header, no gap.
      if (items.length === 0) return null;
      return (
        /* One card per date group, same anatomy as the sidebar boards' project
           cards. No overflow-hidden here: it would make the card the sticky
           header's scroll container. */
        <div key={key} className="rounded-lg border border-border">
          <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
            <span>{t(labelKey)}</span>
            <span className="ml-auto tabular-nums text-foreground-subtle">{items.length}</span>
          </div>
          <div className="p-1 space-y-0.5">{items.map(renderRow)}</div>
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />

      {/* Modal */}
      <div className={MODAL_SHELL_CLASS_IN_PROJECT}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-foreground">
              {t('sessions.sessionList')}
            </h2>
            <p className="text-xs text-muted-foreground truncate" data-tooltip={cwd}>
              {cwd}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 ml-4 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content — search + date-grouped list on the left, transcript on the right */}
        <div className="flex-1 flex min-h-0">
          <div className="w-full md:w-[360px] min-h-0 flex-shrink-0 md:border-r border-border flex flex-col">
            {/* Own bottom padding + divider: the list scrolls below this line,
                so its sticky group label never butts up against the input. */}
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
                scrollport's padding edge as its inset. */}
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
                key={sessionIdOf(selected)}
                cwd={cwd}
                sessionId={sessionIdOf(selected)}
                subtitle={selected.title}
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
