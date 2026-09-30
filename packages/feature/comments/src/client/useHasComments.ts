import { useState, useEffect } from 'react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { subscribeCommentsChange } from './useAllComments';
import { loadComments } from './effect/commentsClient';

/** Whether the project at `cwd` has any comments; re-checks on every comment change event. */
export function useHasComments(cwd: string | undefined): boolean {
  const [hasComments, setHasComments] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setHasComments(false);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const exit = await BrowserRuntime.runPromiseExit(loadComments(cwd));
      if (!cancelled && exit._tag === 'Success') {
        setHasComments((exit.value.comments?.length ?? 0) > 0);
      }
    };
    refresh();
    const unsubscribe = subscribeCommentsChange(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [cwd]);

  return hasComments;
}
