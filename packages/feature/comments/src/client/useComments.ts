import { useState, useCallback, useEffect } from 'react';
import type { CodeComment } from '../server/api/comments';
import { subscribeCommentsChange } from './useAllComments';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadComments,
  addComment as addCommentEff,
  updateComment as updateCommentEff,
  deleteComment as deleteCommentEff,
} from './effect/commentsClient';

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

    const exit = await BrowserRuntime.runPromiseExit(loadComments(cwd, filePath));
    if (exit._tag === 'Success') {
      setComments((exit.value.comments ?? []) as CodeComment[]);
    } else {
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      setError(inner instanceof Error ? inner.message : 'Failed to load comments');
    }
    setIsLoading(false);
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
    const exit = await BrowserRuntime.runPromiseExit(
      addCommentEff({
        cwd,
        filePath,
        startLine,
        endLine,
        content,
        ...(selectedText ? { selectedText } : {}),
      })
    );
    if (exit._tag === 'Success' && exit.value.comment) {
      const created = exit.value.comment;
      setComments(prev => [...prev, created]);
      return created;
    }
    if (exit._tag === 'Failure') {
      console.error('Failed to add comment:', exit.cause);
    }
    return null;
  }, [cwd, filePath]);

  // Update comment
  const updateComment = useCallback(async (id: string, content: string): Promise<boolean> => {
    const exit = await BrowserRuntime.runPromiseExit(updateCommentEff(cwd, id, content));
    if (exit._tag === 'Success' && exit.value.comment) {
      const updated = exit.value.comment;
      setComments(prev => prev.map(c => (c.id === id ? updated : c)));
      return true;
    }
    if (exit._tag === 'Failure') {
      console.error('Failed to update comment:', exit.cause);
    }
    return false;
  }, [cwd]);

  // Delete comment
  const deleteComment = useCallback(async (id: string): Promise<boolean> => {
    const exit = await BrowserRuntime.runPromiseExit(deleteCommentEff(cwd, id));
    if (exit._tag === 'Success') {
      setComments(prev => prev.filter(c => c.id !== id));
      return true;
    }
    console.error('Failed to delete comment:', exit.cause);
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
