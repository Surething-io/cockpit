'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useWebSocket, sessionNumberClass, type SessionNumberStatus } from '@cockpit/shared-ui';
import { fetchCurrentBranch } from '@cockpit/feature-explorer';

/** One clickable session badge in a project row. `label` is the session's live
 *  position in that project's tab bar, or '·' when the project's iframe has not
 *  been mounted yet and its tab order is therefore unknown. */
export interface ProjectSessionBadge {
  sessionId: string;
  label: string;
  status: Exclude<SessionNumberStatus, 'normal'>;
}

interface ProjectItemProps {
  index: number;
  name: string;
  cwd: string;
  isActive: boolean;
  collapsed: boolean;
  hasUnread?: boolean;
  isLoading?: boolean;
  /** Right-aligned session badges (already sorted and capped by the caller). */
  sessionBadges?: ProjectSessionBadge[];
  onClick: () => void;
  onSelectSession?: (sessionId: string) => void;
  onRemove: () => void;
  onOpenNote?: () => void;
}

// Project number: rounded square distinguishes projects from circular session tabs.
// Collapsed rows have no room for the session badges, so the square itself takes
// over the aggregate status colour there (same palette as the badges).
function NumberIcon({ number, status, isActive }: { number: number; status: SessionNumberStatus; isActive: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[4px] border font-mono text-[10px] font-medium leading-none tabular-nums transition-colors ${sessionNumberClass(status, isActive)}`}
      aria-hidden="true"
    >
      {number}
    </span>
  );
}

// Session badge: circle, matching the tab bar's session numbers. Clicking one
// jumps straight to that session — the number is the shortest path from
// "something is running over there" to actually looking at it.
function SessionBadge({ badge, onSelect }: { badge: ProjectSessionBadge; onSelect: (sessionId: string) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(badge.sessionId);
      }}
      className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border font-mono text-[9px] font-medium leading-none tabular-nums transition-transform hover:scale-125 ${sessionNumberClass(badge.status, false)}`}
      title={badge.label}
    >
      {badge.label}
    </button>
  );
}

const EMPTY_BADGES: ProjectSessionBadge[] = [];
const noop = () => {};

export function ProjectItem({
  index,
  name,
  cwd,
  isActive,
  collapsed,
  hasUnread,
  isLoading,
  sessionBadges,
  onClick,
  onSelectSession,
  onRemove,
  onOpenNote,
}: ProjectItemProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  // Current git branch for this project (null = not a git repo / detached HEAD).
  const [branch, setBranch] = useState<string | null>(null);

  // Fetch via the lightweight /api/git/current-branch (just `rev-parse`).
  const loadBranch = useCallback(() => {
    BrowserRuntime.runPromiseExit(fetchCurrentBranch(cwd)).then((exit) => {
      if (exit._tag === 'Success') setBranch(exit.value.branch);
    });
  }, [cwd]);

  useEffect(() => {
    loadBranch();
  }, [loadBranch]);

  // Dynamic refresh: the per-cwd file watcher already emits a debounced/throttled
  // `git` event on .git/HEAD or refs changes (branch switch, checkout, commit).
  // Re-fetch only this project's branch — no polling, no full-list refresh.
  const onWatchMessage = useCallback((msg: unknown) => {
    const m = msg as { type?: string; data?: Array<{ type?: string }> };
    if (m?.type === 'watch' && Array.isArray(m.data) && m.data.some((e) => e.type === 'git')) {
      loadBranch();
    }
  }, [loadBranch]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: onWatchMessage,
  });

  // Tooltip text. With a branch: expanded shows just the branch (the name is
  // already visible in the row), collapsed shows "name / branch" (the row is
  // icon-only). No branch (not a git repo / detached HEAD) → the cwd path.
  // Expanded rows spell the status out one session at a time; collapsed rows
  // (w-12, icon only) have nowhere to put badges, so the project square carries
  // the aggregate status there.
  const badges = sessionBadges ?? EMPTY_BADGES;
  const collapsedStatus: SessionNumberStatus = !collapsed
    ? 'normal'
    : isLoading
      ? 'loading'
      : hasUnread && !isActive
        ? 'unread'
        : 'normal';

  const tooltipText = branch
    ? collapsed
      ? `${name} · ${branch}`
      : branch
    : cwd;

  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors relative ${
        collapsed ? 'justify-center' : ''
      } ${
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      data-tooltip={tooltipText}
    >
      <NumberIcon number={index + 1} status={collapsedStatus} isActive={isActive} />

      {!collapsed && (
        <>
          <span className={`flex-1 truncate text-sm ${isActive ? 'text-brand' : ''}`}>{name}</span>

          {/* Action buttons on hover. In flow and BEFORE the badges rather than
              absolutely pinned to the right edge: as an overlay they landed on
              top of the session numbers, which is both unreadable and a stolen
              click. The numbers keep the rightmost column in every state. */}
          {isHovered && (
            <div className="flex items-center gap-0.5 flex-shrink-0">
              {/* Note button */}
              {onOpenNote && (
                <button
                  className="p-1 rounded hover:bg-hover text-muted-foreground hover:text-foreground transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenNote();
                  }}
                  title={t('workspace.projectNotes')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
              )}
              {/* Close button */}
              <button
                className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-11 transition-colors"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove();
                }}
                title={t('workspace.closeProject')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* Session badges — always the rightmost column */}
          {badges.length > 0 ? (
            <div className="flex items-center gap-1 flex-shrink-0">
              {badges.map((badge) => (
                <SessionBadge
                  key={badge.sessionId}
                  badge={badge}
                  onSelect={onSelectSession ?? noop}
                />
              ))}
            </div>
          ) : isActive ? (
            <span className="w-2 h-2 rounded-full bg-brand flex-shrink-0" />
          ) : null}
        </>
      )}
    </div>
  );
}
