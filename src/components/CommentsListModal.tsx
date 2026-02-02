'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

interface CodeComment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface CommentsListModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
  onNavigateToComment?: (comment: CodeComment) => void;
}

export function CommentsListModal({ isOpen, onClose, cwd, onNavigateToComment }: CommentsListModalProps) {
  const [comments, setComments] = useState<CodeComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Load all comments for the project
  const loadComments = useCallback(async () => {
    if (!cwd) return;
    setIsLoading(true);
    try {
      const response = await fetch(`/api/comments?cwd=${encodeURIComponent(cwd)}&all=true`);
      if (response.ok) {
        const data = await response.json();
        setComments(data.comments || []);
      }
    } catch (err) {
      console.error('Failed to load comments:', err);
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (isOpen) {
      loadComments();
    }
  }, [isOpen, loadComments]);

  const handleDelete = async (id: string) => {
    try {
      const response = await fetch(
        `/api/comments?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      if (response.ok) {
        setComments(prev => prev.filter(c => c.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  };

  // Group comments by file
  const commentsByFile = comments.reduce((acc, comment) => {
    if (!acc[comment.filePath]) {
      acc[comment.filePath] = [];
    }
    acc[comment.filePath].push(comment);
    return acc;
  }, {} as Record<string, CodeComment[]>);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!isOpen || !isMounted) return null;

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
          <h2 className="text-lg font-semibold text-foreground">所有评论</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              加载中...
            </div>
          ) : comments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <svg className="w-12 h-12 mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
              <span>暂无评论</span>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(commentsByFile).map(([filePath, fileComments]) => (
                <div key={filePath} className="border border-border rounded-lg overflow-hidden">
                  {/* File header */}
                  <div className="px-3 py-2 bg-secondary border-b border-border">
                    <span className="text-sm font-medium text-foreground font-mono">
                      {filePath}
                    </span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({fileComments.length} 条评论)
                    </span>
                  </div>
                  {/* Comments */}
                  <div className="divide-y divide-border">
                    {fileComments.map(comment => (
                      <div
                        key={comment.id}
                        className="px-3 py-2 hover:bg-accent/50 cursor-pointer group"
                        onClick={() => onNavigateToComment?.(comment)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="text-xs text-brand font-mono">
                                行 {comment.startLine === comment.endLine
                                  ? comment.startLine
                                  : `${comment.startLine}-${comment.endLine}`}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                ({comment.endLine - comment.startLine + 1} 行)
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {formatDate(comment.updatedAt)}
                              </span>
                            </div>
                            <p className="text-sm text-foreground line-clamp-2">
                              {comment.content || <span className="text-muted-foreground italic">（无内容）</span>}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(comment.id);
                            }}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground hover:text-red-9 transition-opacity"
                            title="删除"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-border bg-secondary flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            共 {comments.length} 条评论
          </span>
          <button
            onClick={async () => {
              if (comments.length === 0) return;
              for (const comment of comments) {
                await handleDelete(comment.id);
              }
            }}
            disabled={comments.length === 0}
            className="px-3 py-1.5 text-sm bg-red-9 text-white rounded hover:bg-red-10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            清空所有
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
