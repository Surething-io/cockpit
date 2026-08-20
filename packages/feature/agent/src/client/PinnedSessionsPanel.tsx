'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import type { PinnedSession } from './usePinnedSessions';
import { SessionNumberBadge, badgeStatus } from './SessionNumberBadge';
import { EngineBadge } from './EngineBadge';
import { loadRecentSessions } from './effect/agentClient';
import {
  SessionStatusDot,
  SessionHoverCard,
  useSessionHoverCard,
  formatRelativeTime,
  statusLabelOf,
  projectNameOf,
  type SessionRowInfo,
} from './SessionRowParts';

const keyOf = (cwd: string, sessionId: string) => `${cwd}\n${sessionId}`;

interface PinnedSessionsPanelProps {
  collapsed?: boolean;
  pinnedSessions: PinnedSession[];
  /** Live "project.session" coordinates keyed `${cwd}\n${sessionId}`. A pinned
   *  session whose project has no open tab for it simply has no coordinate. */
  sessionNumbers?: Record<string, string>;
  /** Project of the active tab — highlighted the same way the recent list does. */
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onUnpin: (sessionId: string) => void;
  onUpdateTitle: (sessionId: string, title: string) => void;
  onReorder: (sessions: PinnedSession[]) => void;
}

/**
 * PinnedSessionsPanel — the user-curated list, directly below the recent list
 * in the sidebar.
 *
 * Rows are built from the same parts as the recent list (SessionRowParts):
 * status dot, engine mark, project name, relative time, status-tinted session
 * chip, title, last-message preview, and the rich hover card with the path,
 * branch and message excerpt. Pinning a session must not cost you the
 * information you had about it one list up.
 *
 * The detail comes from one fetch of `/api/global-state` per open (the full
 * persisted list, week-bounded, 15-100; local IO <10ms — see CLAUDE.md). A
 * dropdown that is open for seconds does not also need the live socket feed:
 * nobody watches a run finish from in here, that is what the list above is for.
 *
 * A session pinned months ago has aged out of that list entirely. Such a row
 * degrades to what the pin record itself holds (project + custom title) rather
 * than inventing a status or an engine it cannot know.
 */
export function PinnedSessionsPanel({
  collapsed,
  pinnedSessions,
  sessionNumbers,
  currentCwd,
  onSwitchProject,
  onUnpin,
  onUpdateTitle,
  onReorder,
}: PinnedSessionsPanelProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Row anatomy shared with GlobalSessionMonitor — see SessionRowParts.
  const hover = useSessionHoverCard();
  const { show: showCard, hide: hideCard } = hover;

  // Drag-to-reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

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

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setEditingId(null);
      }
    };
    const handleBlur = () => {
      setIsOpen(false);
      setEditingId(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);

  // Drop the hover card whenever the dropdown closes
  useEffect(() => {
    if (!isOpen) hideCard();
  }, [isOpen, hideCard]);

  // Auto-focus in edit mode
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const handleSessionClick = useCallback((session: PinnedSession) => {
    if (editingId) return; // Do not navigate while editing
    onSwitchProject(session.cwd, session.sessionId);
    setIsOpen(false);
  }, [onSwitchProject, editingId]);

  const startEdit = useCallback((session: PinnedSession, e: React.MouseEvent) => {
    e.stopPropagation();
    hideCard();
    setEditingId(session.sessionId);
    setEditValue(session.customTitle || '');
  }, [hideCard]);

  const saveEdit = useCallback(() => {
    if (editingId && editValue.trim()) {
      onUpdateTitle(editingId, editValue.trim());
    }
    setEditingId(null);
  }, [editingId, editValue, onUpdateTitle]);

  // Drag-to-reorder
  const handleDragStart = useCallback((index: number) => {
    hideCard();
    setDragIndex(index);
  }, [hideCard]);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const newSessions = [...pinnedSessions];
    const [moved] = newSessions.splice(dragIndex, 1);
    newSessions.splice(index, 0, moved);
    onReorder(newSessions);
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, pinnedSessions, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('sessions.pinnedSessions') : undefined}
      >
        {/* Star, the same mark the tab bar puts on a favourited tab. Outlined
            here because this is a list entry, not a state — the filled amber
            version means "this session is favourited" and only the tab bar gets
            to say that. */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('sessions.pinnedSessions')}</span>}
        {/* Show count badge in collapsed state */}
        {collapsed && pinnedSessions.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-popover border border-border">
            {pinnedSessions.length}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 max-h-[450px] bg-popover border border-border rounded-lg shadow-lv2 z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg">
            <span className="text-sm font-medium">{t('sessions.pinnedSessions')}</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {pinnedSessions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                {t('sessions.noPinnedSessions')}
              </div>
            ) : (
              pinnedSessions.map((session, index) => {
                const info = fetched[keyOf(session.cwd, session.sessionId)];
                const isEditing = editingId === session.sessionId;
                return (
                <div
                  key={session.sessionId}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  onClick={() => handleSessionClick(session)}
                  onMouseEnter={(e) => {
                    if (!isEditing) showCard(info ?? { cwd: session.cwd, sessionId: session.sessionId, title: session.customTitle }, e);
                  }}
                  onMouseLeave={hideCard}
                  className={`group w-full px-3 py-2 text-left hover:bg-hover transition-colors flex items-start gap-2 cursor-pointer ${
                    index !== pinnedSessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${currentCwd === session.cwd ? 'bg-accent/50' : ''} ${
                    dragIndex === index ? 'opacity-50' : ''
                  } ${dragOverIndex === index ? 'border-t-2 border-brand' : ''}`}
                >
                  {/* Drag handle */}
                  <span className="mt-1.5 text-muted-foreground/30 flex-shrink-0 cursor-grab">
                    <svg className="w-3 h-3" viewBox="0 0 10 16" fill="currentColor">
                      <circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/>
                      <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
                      <circle cx="3" cy="14" r="1.5"/><circle cx="7" cy="14" r="1.5"/>
                    </svg>
                  </span>
                  <SessionStatusDot status={info?.status} className="mt-1.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {/* Only when we actually know it — an unknown engine must
                          not render as the default Claude mark. */}
                      {info?.engine && <EngineBadge engine={info.engine} />}
                      <span className="font-medium text-sm truncate">
                        {projectNameOf(session.cwd)}
                      </span>
                      {info?.lastActive ? (
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {formatRelativeTime(t, info.lastActive)}
                        </span>
                      ) : null}
                      <SessionNumberBadge
                        coordinate={sessionNumbers?.[keyOf(session.cwd, session.sessionId)]}
                        status={badgeStatus(info?.status)}
                        statusLabel={statusLabelOf(t, info?.status)}
                        className="ml-auto"
                      />
                    </div>
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
                        className="w-full text-xs px-1 py-0.5 border border-border rounded bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-ring mt-0.5"
                      />
                    ) : (
                      /* The pin record's own title wins — it is the name the
                         user chose. Only when there is none do we fall back to
                         the live title, and only then to the raw id. */
                      <div className="text-xs font-medium text-foreground truncate">
                        {session.customTitle || info?.title || session.sessionId.slice(0, 8)}
                      </div>
                    )}
                    {!isEditing && info?.lastUserMessage && (
                      <div className="text-xs text-foreground/80 truncate">
                        {info.lastUserMessage}
                      </div>
                    )}
                  </div>
                  {/* Hover action buttons */}
                  {!isEditing && (
                    <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
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
                      {/* Delete */}
                      <button
                        onClick={(e) => { e.stopPropagation(); hideCard(); onUnpin(session.sessionId); }}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                        title={t('sessions.remove')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Rich hover card: path + branch + first/last user-message preview */}
      <SessionHoverCard {...hover} />
    </div>
  );
}
