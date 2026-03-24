import { useState, useCallback, useEffect } from 'react';
import type { CodeComment } from '@/app/api/comments/route';
import { subscribeCommentsChange } from './useAllComments';

export type { CodeComment };

interface UseCommentsOptions {
  cwd: string;
  filePath: string;
}

interface UseCommentsReturn {
  comments: CodeComment[];
  isLoading: boolean;
  error: string | null;
  addComment: (startLine: number, endLine: number, content: string, selectedText?: string) => Promise<CodeComment | null>;
  updateComment: (id: string, content: string) => Promise<boolean>;
  deleteComment: (id: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  getCommentsForLine: (line: number) => CodeComment[];
}

export function useComments({ cwd, filePath }: UseCommentsOptions): UseCommentsReturn {
  const [comments, setComments] = useState<CodeComment[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load comments
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

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to global comment change events
  useEffect(() => {
    return subscribeCommentsChange(() => {
      refresh();
    });
  }, [refresh]);

  // Add comment
  const addComment = useCallback(async (
    startLine: number,
    endLine: number,
    content: string,
    selectedText?: string
  ): Promise<CodeComment | null> => {
    try {
      const response = await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, filePath, startLine, endLine, content, ...(selectedText ? { selectedText } : {}) }),
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

  // Update comment
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

  // Delete comment
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

  // Get comments associated with a given line (line falls within the comment range)
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
