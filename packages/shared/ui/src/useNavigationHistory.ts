import { useCallback, useRef } from 'react';

export interface NavEntry {
  filePath: string;
  lineNumber: number;
}

const MAX_HISTORY = 50;

/**
 * Navigation history stack (Go Back / Go Forward)
 * Only records the position before a Cmd+Click jump
 */
export function useNavigationHistory() {
  // Back stack: newest entry at the end
  const backStackRef = useRef<NavEntry[]>([]);
  // Forward stack: newest entry at the end
  const forwardStackRef = useRef<NavEntry[]>([]);

  /**
   * Call before navigating: push the current position onto the back stack and clear the forward stack
   */
  const push = useCallback((entry: NavEntry) => {
    backStackRef.current.push(entry);
    // Limit stack depth
    if (backStackRef.current.length > MAX_HISTORY) {
      backStackRef.current = backStackRef.current.slice(-MAX_HISTORY);
    }
    // A new navigation invalidates the forward stack
    forwardStackRef.current = [];
  }, []);

  /**
   * Go Back: pop from the back stack and push the current position onto the forward stack
   * @param currentEntry Current position (will be pushed onto the forward stack)
   * @returns The position to jump back to, or null if the stack is empty
   */
  const goBack = useCallback((currentEntry: NavEntry): NavEntry | null => {
    if (backStackRef.current.length === 0) return null;
    const target = backStackRef.current.pop()!;
    forwardStackRef.current.push(currentEntry);
    if (forwardStackRef.current.length > MAX_HISTORY) {
      forwardStackRef.current = forwardStackRef.current.slice(-MAX_HISTORY);
    }
    return target;
  }, []);

  /**
   * Go Forward: pop from the forward stack and push the current position onto the back stack
   * @param currentEntry Current position (will be pushed onto the back stack)
   * @returns The position to jump forward to, or null if the stack is empty
   */
  const goForward = useCallback((currentEntry: NavEntry): NavEntry | null => {
    if (forwardStackRef.current.length === 0) return null;
    const target = forwardStackRef.current.pop()!;
    backStackRef.current.push(currentEntry);
    if (backStackRef.current.length > MAX_HISTORY) {
      backStackRef.current = backStackRef.current.slice(-MAX_HISTORY);
    }
    return target;
  }, []);

  const canGoBack = useCallback(() => backStackRef.current.length > 0, []);
  const canGoForward = useCallback(() => forwardStackRef.current.length > 0, []);

  return { push, goBack, goForward, canGoBack, canGoForward };
}
