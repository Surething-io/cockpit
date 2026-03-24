'use client';

import React, { useState, useRef, useEffect } from 'react';
import { modKey } from '@/lib/platform';
import type { CodeComment } from '@/hooks/useComments';

// ============================================
// Inline Comment Display
// ============================================

interface InlineCommentProps {
  comment: CodeComment;
  onEdit: (content: string) => void;
  onDelete: () => void;
}

export function InlineComment({ comment, onEdit, onDelete }: InlineCommentProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(comment.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (editContent.trim()) {
      onEdit(editContent.trim());
      setIsEditing(false);
    }
  };

  const handleCancel = () => {
    setEditContent(comment.content);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
    if (e.key === 'Escape') {
      handleCancel();
    }
  };

  const lineRange = comment.startLine === comment.endLine
    ? `L${comment.startLine}`
    : `L${comment.startLine}-${comment.endLine}`;

  return (
    <div className="bg-amber-3/50 dark:bg-amber-3/20 border-l-2 border-amber-9 mx-2 my-1 rounded-r">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-amber-6/30">
        <span className="text-xs text-amber-11 font-mono">{lineRange}</span>
        <div className="flex items-center gap-1">
          {!isEditing && (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="p-1 text-amber-11 hover:text-amber-12 hover:bg-amber-4 rounded transition-colors"
                title="编辑"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
              </button>
              <button
                onClick={onDelete}
                className="p-1 text-amber-11 hover:text-red-11 hover:bg-red-4 rounded transition-colors"
                title="删除"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
      <div className="px-3 py-2">
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              ref={textareaRef}
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded resize-none focus:outline-none focus:ring-2 focus:ring-amber-9"
              rows={3}
              placeholder="输入评论..."
            />
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!editContent.trim()}
                className="px-2 py-1 text-xs bg-amber-9 text-white rounded hover:bg-amber-10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-foreground whitespace-pre-wrap">{comment.content}</p>
        )}
      </div>
    </div>
  );
}

// ============================================
// Add Comment Form
// ============================================

interface AddCommentFormProps {
  startLine: number;
  endLine: number;
  onSubmit: (content: string) => void;
  onCancel: () => void;
}

export function AddCommentForm({ startLine, endLine, onSubmit, onCancel }: AddCommentFormProps) {
  const [content, setContent] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    onSubmit(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onCancel();
    }
  };

  const lineRange = startLine === endLine
    ? `L${startLine}`
    : `L${startLine}-${endLine}`;

  return (
    <div className="bg-blue-3/50 dark:bg-blue-3/20 border-l-2 border-blue-9 mx-2 my-1 rounded-r">
      <div className="flex items-center px-3 py-1.5 border-b border-blue-6/30">
        <span className="text-xs text-blue-11 font-mono">新评论 {lineRange}</span>
      </div>
      <div className="px-3 py-2 space-y-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full px-2 py-1.5 text-sm bg-card border border-border rounded resize-none focus:outline-none focus:ring-2 focus:ring-blue-9"
          rows={3}
          placeholder={`输入评论... (${modKey()}Enter 提交, Esc 取消)`}
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            className="px-2 py-1 text-xs bg-blue-9 text-white rounded hover:bg-blue-10"
          >
            提交
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Comment Icon (shown in line number gutter)
// ============================================

interface CommentIconProps {
  count: number;
  onClick: () => void;
}

export function CommentIcon({ count, onClick }: CommentIconProps) {
  return (
    <button
      onClick={onClick}
      className="absolute right-0 top-1/2 -translate-y-1/2 p-0.5 text-amber-9 hover:text-amber-11"
      title={`${count} 条评论`}
    >
      <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10z" />
      </svg>
    </button>
  );
}
