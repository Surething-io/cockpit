'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, useEscToClose, MODAL_SHELL_CLASS_IN_PROJECT } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadUserMessageIndex, type UserMessageIndexEntry } from './effect/agentClient';

// Migrated from src/components/project/UserMessagesModal.tsx.
//
// The list is served by /api/session/user-messages, NOT by the `messages` array
// on screen. That array is a paginated suffix (10 turns), so feeding the modal
// from it made the list silently incomplete and made a click on anything above
// the window a no-op — scrollToMessage queries the DOM, and an unloaded message
// has no node. Each row therefore carries its `turnIndex`, and selecting one
// hands that back so the chat can page the turn in before jumping.

interface UserMessagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd?: string;
  /**
   * The session file currently rendered (`loadedSessionId`) — never the live
   * `sessionId`, which is reassigned on every SDK `system.init`. An index read
   * from a different file would list ids that are nowhere in the chat.
   */
  sessionId?: string | null;
  /** Bring the message on screen. Awaited so the row can show a pending state. */
  onSelectMessage: (entry: UserMessageIndexEntry) => void | Promise<void>;
}

// Format an ISO timestamp to a human-readable label.
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // If not today, show date and time
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Collapse whitespace/newlines so the summary stays on a single line;
// CSS handles the actual truncation dynamically based on available width.
function cleanContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

// Hover text for a row. Newlines are kept (the tooltip renders pre-wrap), but the
// length is not: TooltipProvider caps width, never height, so a pasted diff or
// stack trace would grow a popover taller than the viewport.
const TOOLTIP_MAX_CHARS = 500;

function tooltipContent(content: string): string {
  const text = content.trim();
  return text.length > TOOLTIP_MAX_CHARS
    ? `${text.slice(0, TOOLTIP_MAX_CHARS)}…`
    : text;
}

export function UserMessagesModal({ isOpen, onClose, cwd, sessionId, onSelectMessage }: UserMessagesModalProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<UserMessageIndexEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [jumpingId, setJumpingId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // ESC key to close (blurs the trigger so it doesn't keep a stuck focus ring)
  useEscToClose(onClose, isOpen);

  // Fetch on open, discard on close.
  //
  // Deliberately uncached, and NOT because it is cheap — the whole jsonl is
  // reparsed per call, measured at 60-87ms for 2.3-2.5k-line sessions, which is
  // why the list shows a loading state rather than appearing instantly. It is
  // uncached because `turnIndex` is a CURSOR: serving a stale index after the
  // session grew would jump the user to the wrong turn, which is worse than a
  // short wait. Cache this only behind the fingerprint check session-by-path uses.
  useEffect(() => {
    if (!isOpen) {
      setEntries(null);
      setFailed(false);
      setQuery('');
      setJumpingId(null);
      return;
    }
    if (!cwd || !sessionId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    void BrowserRuntime.runPromiseExit(loadUserMessageIndex(cwd, sessionId)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success') {
        setEntries(exit.value.messages);
      } else {
        console.error('Failed to load user message index:', exit.cause);
        setFailed(true);
        setEntries([]);
      }
    });
    return () => { cancelled = true; };
  }, [isOpen, cwd, sessionId]);

  // Keep the ordinal of the FULL list on every row: it is the only stable handle
  // the user has on a message, so it must not renumber as the filter narrows.
  const rows = useMemo(() => {
    if (!entries) return [];
    const numbered = entries.map((entry, index) => ({ entry, ordinal: index + 1 }));
    const needle = query.trim().toLowerCase();
    if (!needle) return numbered;
    return numbered.filter((row) => row.entry.content.toLowerCase().includes(needle));
  }, [entries, query]);

  // Land on the newest message, matching where the chat itself sits on open.
  // Only for the unfiltered list — a search result set reads from the top.
  const isFiltered = query.trim().length > 0;
  useEffect(() => {
    if (!isOpen || isFiltered || !entries) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [isOpen, isFiltered, entries]);

  const handleSelect = useCallback(async (entry: UserMessageIndexEntry) => {
    setJumpingId(entry.id);
    try {
      await onSelectMessage(entry);
    } finally {
      setJumpingId(null);
    }
    onClose();
  }, [onSelectMessage, onClose]);

  if (!isOpen) return null;

  const isLoading = entries === null;

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      onClick={onClose}
    >
      {/* Same board geometry as the session lists — width tracks the display
          instead of stopping at a breakpoint, height is fixed so filtering does
          not make the dialog jump. Chat mounts inside the per-project iframe,
          hence the IN_PROJECT variant (see modalShell.ts). */}
      <div
        className={MODAL_SHELL_CLASS_IN_PROJECT}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — search sits inline with the close button, matching
            RecentSessionsModal / ProjectSessionsModal. */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-foreground">
              {t('userMessages.title')}
            </h3>
            {entries && entries.length > 0 && (
              <p className="text-xs text-muted-foreground truncate">
                {t('userMessages.count', { shown: rows.length, total: entries.length })}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 ml-4">
            <div className="relative">
              <input
                ref={searchInputRef}
                type="text"
                autoFocus
                placeholder={t('userMessages.searchPlaceholder')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="px-2 py-1 pr-6 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
              {query && (
                <button
                  onClick={() => {
                    setQuery('');
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
            <button
              onClick={onClose}
              className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {t('common.loading')}
            </div>
          ) : failed ? (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              {t('userMessages.loadFailed')}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t('userMessages.noMessages')}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              {t('userMessages.noResults')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rows.map(({ entry, ordinal }) => {
                const timeStr = entry.timestamp ? formatTime(entry.timestamp) : '';

                return (
                  <button
                    key={entry.id}
                    onClick={() => { void handleSelect(entry); }}
                    className="w-full px-4 py-3 text-left hover:bg-hover transition-colors"
                    data-tooltip={tooltipContent(entry.content)}
                  >
                    <div className="flex items-start gap-3">
                      {/* Index */}
                      <span className="text-xs text-muted-foreground font-mono w-6 shrink-0 pt-0.5">
                        {ordinal}.
                      </span>
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground truncate">
                          {cleanContent(entry.content)}
                        </p>
                        {jumpingId === entry.id && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {t('userMessages.jumping')}
                          </p>
                        )}
                      </div>
                      {/* Time */}
                      {timeStr && (
                        <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
                          {timeStr}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
