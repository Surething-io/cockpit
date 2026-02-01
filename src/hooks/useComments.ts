import { useState, useCallback, useEffect } from 'react';
import type { CodeComment } from '@/app/api/comments/route';

export type { CodeComment };

interface UseCommentsOptions {
  cwd: string;
  filePath: string;
}

interface UseCommentsReturn {
  comments: CodeComment[];
  isLoading: boolean;
  error: string | null;
  addComment: (startLine: number, endLine: number, content: string) => Promise<CodeComment | null>;
  updateComment: (id: string, content: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  getCommentsForLine: (line: number) => CodeComment[];
}

export function useComments({ cwd, filePath }: UseCommentsOptions): UseCommentsReturn {
  const [comments, setComments] = useState<CodeComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 加载评论
  const refresh = useCallback(async () => {
    if (!cwd || !filePath) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/comments?cwd=${encodeURIComponent(cwd)}&filePath=${encodeURIComponent(filePath)}`
      );
      if (response.ok) {
        const data = await response.json();
        setComments(data.comments || []);
      } else {
        setError('Failed to load comments');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [cwd, filePath]);

  // 初始加载
  useEffect(() => {
    refresh();
  }, [refresh]);

  // 添加评论
  const addComment = useCallback(async (
    startLine: number,
    endLine: number,
    content: string
  ): Promise<CodeComment | null> => {
    try {
      const response = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, filePath, startLine, endLine, content }),
      });

      if (response.ok) {
        const data = await response.json();
        setComments(prev => [...prev, data.comment]);
        return data.comment;
      }
    } catch (err) {
      console.error('Failed to add comment:', err);
    }
    return null;
  }, [cwd, filePath]);

  // 更新评论
  const updateComment = useCallback(async (id: string, content: string): Promise<boolean> => {
    try {
      const response = await fetch('/api/comments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, id, content }),
      });

      if (response.ok) {
        const data = await response.json();
        setComments(prev =>
          prev.map(c => (c.id === id ? data.comment : c))
        );
        return true;
      }
    } catch (err) {
      console.error('Failed to update comment:', err);
    }
    return false;
  }, [cwd]);

  // 删除评论
  const deleteComment = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(
        `/api/comments?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );

      if (response.ok) {
        setComments(prev => prev.filter(c => c.id !== id));
        return true;
      }
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
    return false;
  }, [cwd]);

  // 获取某行相关的评论（该行在评论范围内）
  const getCommentsForLine = useCallback((line: number): CodeComment[] => {
    return comments.filter(c => line >= c.startLine && line <= c.endLine);
  }, [comments]);

  return {
    comments,
    isLoading,
    error,
    addComment,
    updateComment,
    deleteComment,
    refresh,
    getCommentsForLine,
  };
}
