'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { MODAL_SHELL_CLASS } from '@cockpit/shared-ui';
import type { PinnedSession } from './usePinnedSessions';
import { SessionNumberBadge, badgeStatus } from './SessionNumberBadge';
import { EngineBadge } from './EngineBadge';
import { SessionTranscriptPreview } from './SessionTranscriptPreview';
import { loadRecentSessions } from './effect/agentClient';
import {
  formatRelativeTime,
  statusLabelOf,
  groupByProject,
  ProjectGroupHeader,
  type SessionRowInfo,
} from './SessionRowParts';

const keyOf = (cwd: string, sessionId: string) => `${cwd}\n${sessionId}`;

interface PinnedSessionsPanelProps {
  collapsed?: boolean;
  pinnedSessions: PinnedSession[];
  /** Live "project.session" coordinates keyed `${cwd}\n${sessionId}`. A pinned
   *  session whose project has no open tab for it simply has no coordinate. */
  sessionNumbers?: Record<string, string>;
  /** Sidebar project order — numbers each group's chip like the project list. */
  projectOrder: readonly string[];
  /** Project of the active tab — its group chip is drawn active. */
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onUnpin: (sessionId: string) => void;
  onUpdateTitle: (sessionId: string, title: string) => void;
  onReorder: (sessions: PinnedSession[]) => void;
}

/**
 * PinnedSessionsPanel — the sidebar star button plus the full-viewport board it
 * opens: the user-curated list on the left, the selected session's transcript
 * on the right. Same shell and split as ScheduledTasksPanel, so the two
 * neighbouring sidebar entries behave alike — look first, then open.
 *
 * The list is grouped by project, groups in order of each project's first
 * appearance in the user's own list, rows in the user's order inside a group.
 * Dragging reorders within a group only — a row cannot be dropped into another
 * project's group. A drop rewrites the stored list group-contiguous (groupwise
 * flatten), so the group order the user sees is exactly what gets saved and
 * cannot jump on the next render.
 *
 * Rows are built from the same parts as the recent list (SessionRowParts):
 * engine mark, project name, relative time, status-tinted session chip, title,
 * last-message preview. The detail comes from one fetch of `/api/global-state`
 * per open (the full persisted list, week-bounded, 20-100; local IO <10ms — see
 * CLAUDE.md); the transcript pane polls its own session for live updates.
 *
 * A session favourited months ago has aged out of that list entirely. Such a
 * row degrades to what the stored record itself holds (project + custom title)
 * rather than inventing a status or a timestamp it cannot know.
 *
 * Naming: the UI says "favorite" everywhere (star icon, `sessions.*Favorite*`
 * copy), while the code and storage still say "pin" — the component name, the
 * `isPinned`/`onTogglePin` props, `/api/pinned-sessions` and the file it
 * persists to. That split is deliberate: renaming the route would orphan every
 * existing user's saved list. Do not "fix" one half of it in isolation.
 *
 * Uses a full-viewport `fixed inset-0` overlay so it escapes the three-panel
 * SwipeableViewContainer boundaries (see CLAUDE.md UI layout notes).
 */
export function PinnedSessionsPanel({
  collapsed,
  pinnedSessions,
  sessionNumbers,
  projectOrder,
  currentCwd,
  onSwitchProject,
  onUnpin,
  onUpdateTitle,
  onReorder,
}: PinnedSessionsPanelProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Which favorite the right-hand transcript follows. Reset on close so every
  // open lands on the top of the list again.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? pinnedSessions.find(s => s.sessionId === selectedId) ?? null : null;

  const groups = useMemo(() => groupByProject(pinnedSessions), [pinnedSessions]);

  // Drag-to-reorder state, by sessionId. `dragCwd` limits drops to one group.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragCwd = dragId ? pinnedSessions.find(s => s.sessionId === dragId)?.cwd : undefined;

  // Row detail, keyed `${cwd}\n${sessionId}`; empty until the first open.
  const [fetched, setFetched] = useState<Record<string, SessionRowInfo>>({});

  useEffect(() => {
    if (!isOpen) return;
    BrowserRuntime.runPromise(
      loadRecentSessions().pipe(
        Effect.match({
          onSuccess: (list) =>
            setFetched(Object.fromEntries(list.map((s) => [keyOf(s.cwd, s.sessionId), s]))),
          // Best-effort enrichment: on failure the rows simply stay bare.
          onFailure: () => {},
        })
      )
    );
  }, [isOpen]);

  // Auto-select the first row so opening the board shows a transcript without a
  // click. Only fills a hole (nothing selected, or the selection was unpinned);
  // it never steals a selection the user made.
  useEffect(() => {
    if (!isOpen || selected) return;
    setSelectedId(pinnedSessions[0]?.sessionId ?? null);
  }, [isOpen, selected, pinnedSessions]);

  const closeBoard = useCallback(() => {
    setIsOpen(false);
    setSelectedId(null);
    setEditingId(null);
  }, []);

  // Close on ESC — unless a title is being edited: the input handles its own ESC
  // (cancel the edit), and that must not also close the board under it.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editingId) return;
      closeBoard();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, editingId, closeBoard]);

  // Auto-focus in edit mode
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const openSession = useCallback((session: PinnedSession) => {
    onSwitchProject(session.cwd, session.sessionId);
    closeBoard();
  }, [onSwitchProject, closeBoard]);

  const startEdit = useCallback((session: PinnedSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(session.sessionId);
    setEditValue(session.customTitle || '');
  }, []);

  const saveEdit = useCallback(() => {
    if (editingId && editValue.trim()) {
      onUpdateTitle(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, onUpdateTitle]);

  // Drag-to-reorder, within one project group
  const handleDragStart = useCallback((session: PinnedSession) => {
    setDragId(session.sessionId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, session: PinnedSession) => {
    // Not calling preventDefault is what refuses the drop: the browser shows the
    // no-drop cursor over another project's rows.
    if (session.cwd !== dragCwd) return;
    e.preventDefault();
    setDragOverId(session.sessionId);
  }, [dragCwd]);

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((target: PinnedSession) => {
    if (!dragId || dragId === target.sessionId || target.cwd !== dragCwd) {
      handleDragEnd();
      return;
    }
    const reordered = groups.flatMap((group) => {
      if (group.cwd !== target.cwd) return group.items;
      const items = [...group.items];
      const from = items.findIndex(s => s.sessionId === dragId);
      const to = items.findIndex(s => s.sessionId === target.sessionId);
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      return items;
    });
    onReorder(reordered);
    handleDragEnd();
  }, [dragId, dragCwd, groups, onReorder, handleDragEnd]);

  /** The pin record's own title wins — it is the name the user chose. Only when
   *  there is none do we fall back to the live title, and only then to the id. */
  const titleOf = (session: PinnedSession) =>
    session.customTitle || fetched[keyOf(session.cwd, session.sessionId)]?.title || session.sessionId;

  const renderRow = (session: PinnedSession) => {
    const info = fetched[keyOf(session.cwd, session.sessionId)];
    const isEditing = editingId === session.sessionId;
    const isSelected = session.sessionId === selectedId;
    return (
      <div
        key={session.sessionId}
        draggable={!isEditing}
        onDragStart={() => handleDragStart(session)}
        onDragOver={(e) => handleDragOver(e, session)}
        onDrop={() => handleDrop(session)}
        onDragEnd={handleDragEnd}
        onClick={() => { if (!isEditing) setSelectedId(session.sessionId); }}
        onDoubleClick={() => { if (!isEditing) openSession(session); }}
        className={`group rounded-md px-2 py-2 cursor-pointer transition-colors flex items-start gap-1.5 ${
          isSelected ? 'bg-brand/10' : 'hover:bg-hover'
        } ${dragId === session.sessionId ? 'opacity-50' : ''} ${
          dragOverId === session.sessionId && dragId !== session.sessionId ? 'ring-1 ring-inset ring-brand' : ''
        }`}
      >
        {/* Drag handle */}
        <span className="mt-1 text-muted-foreground/30 flex-shrink-0 cursor-grab">
          <svg className="w-3 h-3" viewBox="0 0 10 16" fill="currentColor">
            <circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/>
            <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
            <circle cx="3" cy="14" r="1.5"/><circle cx="7" cy="14" r="1.5"/>
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          {/* The project is the group header now, so the row leads with the title. */}
          <div className="flex items-center gap-1.5">
            {/* Unconditional, exactly like the recent list. `engine` is attached
                at read time only for sessions the project's engines map names,
                and Claude — the default — is usually absent from it, so gating
                on it left every Claude row with a blank where the row above had
                a mark. `undefined` means Claude across the whole app;
                EngineBadge resolves it. */}
            <EngineBadge engine={info?.engine} />
            {isEditing ? (
              <input
                ref={editInputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === 'Enter') saveEdit();
                  if (e.key === 'Escape') setEditingId(null);
                }}
                onBlur={saveEdit}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 text-xs px-1 py-0.5 border border-border rounded bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            ) : (
              <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0" data-tooltip={titleOf(session)}>
                {titleOf(session)}
              </span>
            )}
            {!isEditing && info?.lastActive ? (
              <span className="text-[10px] text-muted-foreground flex-shrink-0 group-hover:hidden">
                {formatRelativeTime(t, info.lastActive)}
              </span>
            ) : null}
            <SessionNumberBadge
              coordinate={sessionNumbers?.[keyOf(session.cwd, session.sessionId)]}
              status={badgeStatus(info?.status)}
              statusLabel={statusLabelOf(t, info?.status)}
              bot={info?.bot}
            />
            {/* Hover action buttons */}
            {!isEditing && (
              <div className="flex-shrink-0 hidden group-hover:flex items-center gap-0.5">
                {/* Edit */}
                <button
                  onClick={(e) => startEdit(session, e)}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                  title={t('sessions.editTitle')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                {/* Unfavorite */}
                <button
                  onClick={(e) => { e.stopPropagation(); onUnpin(session.sessionId); }}
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                  title={t('sessions.removeFavorite')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          {!isEditing && info?.lastUserMessage && (
            <div className="text-xs text-muted-foreground truncate mt-0.5 pl-[22px]" data-tooltip={info.lastUserMessage}>
              {info.lastUserMessage}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('sessions.favorites') : undefined}
      >
        {/* Star, the same mark the composer puts on its favorite action. Outlined
            here because this is a list entry, not the current session's state. */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.favorites')}</span>}
        {/* Show count badge in collapsed state */}
        {collapsed && pinnedSessions.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-popover border border-border">
            {pinnedSessions.length}
          </span>
        )}
      </button>

      {/* Favorites board */}
      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-scrim" onClick={closeBoard} />

          {/* Modal */}
          <div className={MODAL_SHELL_CLASS}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t('sessions.favorites')}</h2>
                {pinnedSessions.length > 0 && (
                  <span className="text-xs text-muted-foreground">{pinnedSessions.length}</span>
                )}
              </div>
              <button
                onClick={closeBoard}
                className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content — favorites on the left, transcript on the right */}
            <div className="flex-1 flex min-h-0">
              {pinnedSessions.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-xs text-muted-foreground">{t('sessions.noFavorites')}</div>
                </div>
              ) : (
                <>
                  {/* Left: fixed width because the right pane renders real
                      message bubbles and needs the remaining space. Below `md`
                      the preview is dropped and the list takes the full width.
                      Padding stays off the scroll node so the sticky group
                      header does not leave a strip of rows visible above it. */}
                  <div className="w-full md:w-[360px] min-h-0 flex-shrink-0 md:border-r border-border overflow-y-auto">
                    <div className="p-3 space-y-3">
                      {groups.map((group) => (
                        /* One card per project. No overflow-hidden here: it would
                           make the card the sticky header's scroll container. */
                        <div key={group.cwd} className="rounded-lg border border-border">
                          <ProjectGroupHeader cwd={group.cwd} projectOrder={projectOrder} currentCwd={currentCwd}>
                            <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
                          </ProjectGroupHeader>
                          <div className="p-1 space-y-0.5">{group.items.map(renderRow)}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right: the selected favorite's transcript */}
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
                        {t('sessions.selectFavoriteHint')}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
