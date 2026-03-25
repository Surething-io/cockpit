'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodeComment } from '@/hooks/useComments';

// ============================================
// View Comment Card (for viewing existing comments)
// ============================================

interface ViewCommentCardProps {
  x: number;
  y: number;
  comment: CodeComment;
  container?: HTMLElement | null;
  onClose: () => void;
  onUpdateComment: (id: string, content: string) => Promise<boolean>;
  onDeleteComment: (id: string) => Promise<boolean>;
}

export function ViewCommentCard({
  x,
  y,
  comment,
  container,
  onClose,
  onUpdateComment,
  onDeleteComment,
}: ViewCommentCardProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Position adjustment relative to container
  useEffect(() => {
    if (cardRef.current && container) {
      const containerRect = container.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      // Calculate position relative to container
      let relX = x - containerRect.left;
      let relY = y - containerRect.top;
      // Avoid overflow
      if (relX + cardRect.width > containerRect.width - 16) relX = containerRect.width - cardRect.width - 16;
      if (relX < 16) relX = 16;
      if (relY + cardRect.height > containerRect.height - 16) relY = relY - cardRect.height - 8;
      if (relY < 16) relY = 16;
      queueMicrotask(() => setPosition({ x: relX, y: relY }));
    }
  }, [x, y, container]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSave = async () => {
    if (editContent.trim()) {
      await onUpdateComment(comment.id, editContent.trim());
      setIsEditing(false);
    }
  };

  const handleDelete = async () => {
    await onDeleteComment(comment.id);
    onClose();
  };

  return (
    <div
      ref={cardRef}
      className="absolute z-[200] w-96 bg-card border border-border rounded-lg shadow-lg overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="p-3">
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              rows={3}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSave();
                }
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  setEditContent(comment.content);
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setIsEditing(false); setEditContent(comment.content); }}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-foreground whitespace-pre-wrap">{comment.content}</p>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t('comments.lineRange', { start: comment.startLine, end: comment.endLine })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground"
                  title={t('common.edit')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={handleDelete}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-red-9"
                  title={t('common.delete')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
