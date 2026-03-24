'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { clearAllComments, emitCommentsChange, fetchAllCommentsWithCode, CHAT_COMMENT_FILE } from '@/hooks/useAllComments';
import { Portal } from '../shared/Portal';
import { toast } from '../shared/Toast';

interface CodeComment {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  selectedText?: string;
  createdAt: number;
  updatedAt?: number;
}

interface CommentsListModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
  onNavigateToComment?: (comment: CodeComment) => void;
}

// Comment data structure for copying
interface CopyableComment {
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  codeContent: string;
}

// Format comments as copy text
function formatCommentsForCopy(comments: CopyableComment[]): string {
  if (comments.length === 0) return '';

  const parts: string[] = ['代码引用:', ''];

  const chatComments = comments.filter(c => c.filePath === CHAT_COMMENT_FILE);
  const fileComments = comments.filter(c => c.filePath !== CHAT_COMMENT_FILE);

  if (fileComments.length > 0) {
    fileComments.forEach((comment, index) => {
      parts.push(`[${index + 1}] ${comment.filePath}:${comment.startLine}-${comment.endLine}`);
      parts.push('```');
      parts.push(comment.codeContent);
      parts.push('```');
      if (comment.content) {
        parts.push(`备注: ${comment.content}`);
      }
      parts.push('');
    });
  }

  for (const comment of chatComments) {
    const quoted = comment.codeContent.split('\n').map((l: string) => `> ${l}`).join('\n');
    parts.push(quoted);
    if (comment.content) {
      parts.push(comment.content);
    }
    parts.push('');
  }

  return parts.join('\n').trim();
}

export function CommentsListModal({ isOpen, onClose, cwd, onNavigateToComment }: CommentsListModalProps) {
  const [comments, setComments] = useState<CodeComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [copyingId, setCopyingId] = useState<string | null>(null); // ID of the comment being copied
  const [copyingAll, setCopyingAll] = useState(false); // Whether copying all comments

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
        // Trigger global refresh so comment bubbles in file browser sync
        emitCommentsChange();
      }
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  };

  // Copy a single comment
  const handleCopySingle = async (comment: CodeComment) => {
    setCopyingId(comment.id);
    try {
      let codeContent = '';

      if (comment.selectedText) {
        // Comments with selectedText (e.g., AI message bubbles) use it directly
        codeContent = comment.selectedText;
      } else {
        // Read code content from file
        const fileResponse = await fetch(
          `/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(comment.filePath)}`
        );
        if (!fileResponse.ok) {
          throw new Error('Failed to read file');
        }
        const fileData = await fileResponse.json();
        const lines = (fileData.content || '').split('\n');
        codeContent = lines.slice(comment.startLine - 1, comment.endLine).join('\n');
      }

      const copyable: CopyableComment = {
        filePath: comment.filePath,
        startLine: comment.startLine,
        endLine: comment.endLine,
        content: comment.content,
        codeContent,
      };

      const text = formatCommentsForCopy([copyable]);
      await navigator.clipboard.writeText(text);
      toast('已复制评论');
    } catch (err) {
      console.error('Failed to copy comment:', err);
    } finally {
      setCopyingId(null);
    }
  };

  // Copy all comments
  const handleCopyAll = async () => {
    if (comments.length === 0) return;
    setCopyingAll(true);
    try {
      const commentsWithCode = await fetchAllCommentsWithCode(cwd);
      const text = formatCommentsForCopy(commentsWithCode);
      await navigator.clipboard.writeText(text);
      toast('已复制全部评论');
    } catch (err) {
      console.error('Failed to copy all comments:', err);
    } finally {
      setCopyingAll(false);
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

  const formatDate = (timestamp: number | undefined) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!isOpen) return null;

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
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">所有评论</h2>
            {comments.length > 0 && (
              <button
                onClick={handleCopyAll}
                disabled={copyingAll}
                className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                title="复制全部评论"
              >
                {copyingAll ? (
                  <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            )}
          </div>
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
                      {filePath === CHAT_COMMENT_FILE ? 'AI 回复' : filePath}
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
                              {(comment.startLine > 0 || comment.endLine > 0) ? (
                                <>
                                  <span className="text-xs text-brand font-mono">
                                    行 {comment.startLine === comment.endLine
                                      ? comment.startLine
                                      : `${comment.startLine}-${comment.endLine}`}
                                  </span>
                                  <span className="text-xs text-muted-foreground">
                                    ({comment.endLine - comment.startLine + 1} 行)
                                  </span>
                                </>
                              ) : comment.selectedText ? (
                                <span className="text-xs text-muted-foreground italic truncate max-w-[200px]">
                                  &ldquo;{comment.selectedText.slice(0, 50)}{comment.selectedText.length > 50 ? '...' : ''}&rdquo;
                                </span>
                              ) : null}
                              <span className="text-xs text-muted-foreground">
                                {formatDate(comment.updatedAt || comment.createdAt)}
                              </span>
                            </div>
                            <p className="text-sm text-foreground line-clamp-2">
                              {comment.content || <span className="text-muted-foreground italic">（无内容）</span>}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopySingle(comment);
                            }}
                            disabled={copyingId === comment.id}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground transition-opacity disabled:opacity-50"
                            title="复制"
                          >
                            {copyingId === comment.id ? (
                              <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            )}
                          </button>
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
              const success = await clearAllComments(cwd);
              if (success) {
                setComments([]);
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

  return <Portal>{modalContent}</Portal>;
}
