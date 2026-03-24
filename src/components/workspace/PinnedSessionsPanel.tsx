'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { PinnedSession } from '@/hooks/usePinnedSessions';

interface PinnedSessionsPanelProps {
  collapsed?: boolean;
  pinnedSessions: PinnedSession[];
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onUnpin: (sessionId: string) => void;
  onUpdateTitle: (sessionId: string, title: string) => void;
  onReorder: (sessions: PinnedSession[]) => void;
}

export function PinnedSessionsPanel({
  collapsed,
  pinnedSessions,
  onSwitchProject,
  onUnpin,
  onUpdateTitle,
  onReorder,
}: PinnedSessionsPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Drag-to-reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

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

  // Auto-focus in edit mode
  useEffect(() => {
    if (editingId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingId]);

  const getProjectName = (cwd: string) => cwd.split('/').pop() || cwd;

  const handleSessionClick = useCallback((session: PinnedSession) => {
    if (editingId) return; // Do not navigate while editing
    onSwitchProject(session.cwd, session.sessionId);
    setIsOpen(false);
  }, [onSwitchProject, editingId]);

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

  // Drag-to-reorder
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

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
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title="常用会话"
      >
        {/* Star icon */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">常用会话</span>}
        {/* Show count badge in collapsed state */}
        {collapsed && pinnedSessions.length > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-accent">
            {pinnedSessions.length}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 max-h-[450px] bg-popover border border-border rounded-lg shadow-lg z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg">
            <span className="text-sm font-medium">常用会话</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {pinnedSessions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                暂无常用会话，在 Tab 栏点击图钉可添加
              </div>
            ) : (
              pinnedSessions.map((session, index) => (
                <div
                  key={session.sessionId}
                  draggable
                  onDragStart={() => handleDragStart(index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDrop={() => handleDrop(index)}
                  onDragEnd={handleDragEnd}
                  onClick={() => handleSessionClick(session)}
                  className={`group w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-start gap-2 cursor-pointer ${
                    index !== pinnedSessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${dragIndex === index ? 'opacity-50' : ''} ${
                    dragOverIndex === index ? 'border-t-2 border-brand' : ''
                  }`}
                >
                  {/* Drag handle */}
                  <span className="mt-1.5 text-muted-foreground/30 flex-shrink-0 cursor-grab">
                    <svg className="w-3 h-3" viewBox="0 0 10 16" fill="currentColor">
                      <circle cx="3" cy="2" r="1.5"/><circle cx="7" cy="2" r="1.5"/>
                      <circle cx="3" cy="8" r="1.5"/><circle cx="7" cy="8" r="1.5"/>
                      <circle cx="3" cy="14" r="1.5"/><circle cx="7" cy="14" r="1.5"/>
                    </svg>
                  </span>
                  <div className="flex-1 min-w-0" title={session.cwd}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {getProjectName(session.cwd)}
                      </span>
                    </div>
                    {editingId === session.sessionId ? (
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
                      <div className="text-xs text-foreground/80 truncate">
                        {session.customTitle || session.sessionId.slice(0, 8)}
                      </div>
                    )}
                  </div>
                  {/* Hover action buttons */}
                  {editingId !== session.sessionId && (
                    <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                      {/* Edit */}
                      <button
                        onClick={(e) => startEdit(session, e)}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="编辑标题"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                        </svg>
                      </button>
                      {/* Delete */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onUnpin(session.sessionId); }}
                        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                        title="移除"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
