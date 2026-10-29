'use client';

import type { ReactNode } from 'react';
import { ProjectNumberChip } from '@cockpit/shared-ui';
import type { RecentSessionInfo } from './effect/agentClient';

/**
 * SessionRowParts — the pieces every cross-project session list row is made of.
 *
 * There are two such lists in the sidebar, one above the other: "recent
 * sessions" (RecentSessionsModal, live from the global-state socket) and
 * "pinned sessions" (PinnedSessionsPanel, a user-curated subset). They point at
 * the same objects, so a row that looks and behaves differently between them
 * reads as a bug in the app rather than a difference between the lists — the
 * pinned list used to show a bare project name and an 8-char session id while
 * the row directly above it showed the engine, the status, when it last ran and
 * what was last said to it.
 *
 * So the shared row anatomy lives here once: project name, relative time and
 * status label. What stays local to each board is what genuinely differs — the
 * pinned list owns drag-to-reorder, inline rename and unpin; the recent list
 * owns search and the status groups.
 */

/** The shape both lists' items converge on: the API's own session type with
 *  everything past the two ids made optional, because a pinned row may point at
 *  a session that has aged out of the state file and has no live data left. */
export type SessionRowInfo = Partial<RecentSessionInfo> & Pick<RecentSessionInfo, 'cwd' | 'sessionId'>;

/** Last path segment — the name a project is actually known by. */
export const projectNameOf = (cwd: string) => cwd.split('/').pop() || cwd;

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "3 minutes ago". Read from the clock at render — these lists live in a
 *  board that is open for seconds, so there is nothing to tick and nothing
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

/** One project's slice of a session list. */
export interface ProjectGroup<T> {
  cwd: string;
  items: T[];
}

/**
 * Group rows by project, in order of each project's FIRST appearance. The input
 * order therefore decides everything: a status-sorted list puts the project
 * with the most urgent row first, a user-ordered list keeps the user's order.
 * Rows keep their relative order inside a group.
 */
export function groupByProject<T extends { cwd: string }>(items: readonly T[]): ProjectGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.cwd);
    if (list) list.push(item);
    else groups.set(item.cwd, [item]);
  }
  return [...groups].map(([cwd, groupItems]) => ({ cwd, items: groupItems }));
}

/**
 * Sticky header of a project group card — the same anatomy as the terminals
 * board: the sidebar's project number chip (absent for a project that is not
 * open in the sidebar), the project name, then whatever the board appends.
 */
export function ProjectGroupHeader({
  cwd,
  projectOrder,
  currentCwd,
  children,
}: {
  cwd: string;
  projectOrder: readonly string[];
  currentCwd?: string;
  children?: ReactNode;
}) {
  const number = projectOrder.indexOf(cwd) + 1;
  return (
    <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5">
      {number > 0 && <ProjectNumberChip number={number} isActive={cwd === currentCwd} />}
      <span className="truncate" data-tooltip={cwd}>{projectNameOf(cwd)}</span>
      {children}
    </div>
  );
}
