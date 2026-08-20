'use client';

import { useCallback, useState } from 'react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { fetchCurrentBranch } from '@cockpit/feature-explorer';
import type { RecentSessionInfo } from './effect/agentClient';

/**
 * SessionRowParts — the pieces every cross-project session list row is made of.
 *
 * There are two such lists in the sidebar, one above the other: "recent
 * sessions" (GlobalSessionMonitor, live from the global-state socket) and
 * "pinned sessions" (PinnedSessionsPanel, a user-curated subset). They point at
 * the same objects, so a row that looks and behaves differently between them
 * reads as a bug in the app rather than a difference between the lists — the
 * pinned list used to show a bare project name and an 8-char session id while
 * the row directly above it showed the engine, the status, when it last ran and
 * what was last said to it.
 *
 * So the row anatomy lives here once: status dot, relative time, and the rich
 * hover card. What stays local to each panel is what genuinely differs — the
 * pinned list owns drag-to-reorder, inline rename and unpin; the recent list
 * owns search and the running/unread counts.
 */

/** The shape both lists' items converge on: the API's own session type with
 *  everything past the two ids made optional, because a pinned row may point at
 *  a session that has aged out of the state file and has no live data left. */
export type SessionRowInfo = Partial<RecentSessionInfo> & Pick<RecentSessionInfo, 'cwd' | 'sessionId'>;

/** Last path segment — the name a project is actually known by. */
export const projectNameOf = (cwd: string) => cwd.split('/').pop() || cwd;

/**
 * Status indicator: orange (running) / red (unread) / grey (idle).
 *
 * Solid at the `-11` step, not washed like the pills — an 8px dot has no room
 * to carry a 20% tint. It does NOT pulse: the round session-number chip on the
 * right is the one blinking thing per row, and this dot is what still reports
 * the state before the numbers finish resolving.
 */
export function SessionStatusDot({ status, className = '' }: { status?: string; className?: string }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${
        status === 'loading'
          ? 'bg-orange-11'
          : status === 'unread'
            ? 'bg-red-11'
            : 'bg-muted-foreground/30'
      } ${className}`}
    />
  );
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "3 minutes ago". Read from the clock at render — these lists live in a
 *  dropdown that is open for seconds, so there is nothing to tick and nothing
 *  to stamp. */
export function formatRelativeTime(t: Translate, timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return t('common.justNow');
  if (minutes < 60) return t('common.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.hoursAgo', { count: hours });
  return t('common.daysAgo', { count: Math.floor(hours / 24) });
}

/** Translated state name. Not printed as a row label — it rides along as the
 *  session chip's tooltip / aria text, since the colour is the whole label. */
export function statusLabelOf(t: Translate, status?: string): string | undefined {
  if (status === 'loading') return t('sessions.running');
  if (status === 'unread') return t('sessions.done');
  return undefined;
}

interface HoverCardState {
  session: SessionRowInfo;
  top: number;
  left: number;
}

/**
 * Rich hover card state: which row is hovered, where to anchor the card, and
 * the git branch of that row's project.
 *
 * The card is positioned `fixed` from the row's own rect so it escapes the
 * dropdown's `overflow-y-auto` clipping. The branch is fetched lazily, once per
 * cwd, and cached for the lifetime of the panel — hovering a list of ten rows
 * from the same project must not fire ten requests.
 */
export function useSessionHoverCard() {
  const [card, setCard] = useState<HoverCardState | null>(null);
  const [branches, setBranches] = useState<Record<string, string | null>>({});

  const show = useCallback((session: SessionRowInfo, e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const CARD_MAX_H = 260;
    let top = rect.top;
    if (top + CARD_MAX_H > window.innerHeight) {
      top = Math.max(8, window.innerHeight - CARD_MAX_H - 8);
    }
    setCard({ session, top, left: rect.right + 8 });
    setBranches((prev) => {
      if (session.cwd in prev) return prev;
      BrowserRuntime.runPromiseExit(fetchCurrentBranch(session.cwd)).then((exit) => {
        if (exit._tag === 'Success') {
          setBranches((cur) => ({ ...cur, [session.cwd]: exit.value.branch }));
        }
      });
      // Seed with null so a second hover does not re-fetch while the first is
      // still in flight; the real value replaces it when it lands.
      return { ...prev, [session.cwd]: null };
    });
  }, []);

  const hide = useCallback(() => setCard(null), []);

  return { card, branch: card ? branches[card.session.cwd] ?? null : null, show, hide };
}

/** The card itself — project, title, full path, branch, message preview. */
export function SessionHoverCard({ card, branch }: Pick<ReturnType<typeof useSessionHoverCard>, 'card' | 'branch'>) {
  if (!card) return null;
  const { session } = card;
  const hasMessages = (session.firstMessages?.length ?? 0) > 0 || (session.lastMessages?.length ?? 0) > 0;

  return (
    <div
      className="fixed z-[60] w-72 max-h-[260px] overflow-y-auto bg-popover border border-border rounded-lg shadow-lv2 p-3 pointer-events-none"
      style={{ top: card.top, left: card.left }}
    >
      <div className="text-xs font-medium text-foreground truncate">{projectNameOf(session.cwd)}</div>
      {session.title && (
        <div className="text-xs font-medium text-foreground truncate mt-0.5">{session.title}</div>
      )}
      {/* Full path: the pinned list used to expose this as the row's plain
          tooltip, and two same-named checkouts are indistinguishable without
          it. */}
      <div className="text-[10px] text-foreground-faint truncate mt-0.5">{session.cwd}</div>
      {branch && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground font-normal min-w-0">
          {/* git branch icon — signals this is a git branch */}
          <svg className="w-3 h-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="7" r="2.5" />
            <path strokeLinecap="round" d="M6 8.5v7M8.5 6.5h4.5a3 3 0 013 3v0" />
          </svg>
          <span className="truncate">{branch}</span>
        </div>
      )}
      {hasMessages ? (
        <div className="space-y-0.5 text-xs border-t border-border/50 mt-2 pt-2">
          {session.firstMessages?.map((msg, idx) => (
            <div key={`f-${idx}`} className="text-foreground/90 truncate">
              <span className="text-foreground-subtle mr-1">•</span>
              {msg}
            </div>
          ))}
          {(session.lastMessages?.length ?? 0) > 0 && (
            <div className="text-foreground-subtle text-center py-0.5">···</div>
          )}
          {session.lastMessages?.map((msg, idx) => (
            <div key={`l-${idx}`} className="text-foreground/90 truncate">
              <span className="text-foreground-subtle mr-1">•</span>
              {msg}
            </div>
          ))}
        </div>
      ) : session.lastUserMessage ? (
        /* Fallback (e.g. running sessions skipped on the WS path): show whatever
           message the item already has */
        <div className="text-xs text-foreground/90 border-t border-border/50 mt-2 pt-2 line-clamp-3 break-words">
          {session.lastUserMessage}
        </div>
      ) : null}
    </div>
  );
}
