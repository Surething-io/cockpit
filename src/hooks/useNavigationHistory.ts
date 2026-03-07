import { useCallback, useRef } from 'react';

export interface NavEntry {
  filePath: string;
  lineNumber: number;
}

const MAX_HISTORY = 50;

/**
 * 导航历史栈（Go Back / Go Forward）
 * 仅记录 Cmd+Click 跳转前的位置
 */
export function useNavigationHistory() {
  // 后退栈：最新的在末尾
  const backStackRef = useRef<NavEntry[]>([]);
  // 前进栈：最新的在末尾
  const forwardStackRef = useRef<NavEntry[]>([]);

  /**
   * 跳转前调用：把当前位置压入后退栈，清空前进栈
   */
  const push = useCallback((entry: NavEntry) => {
    backStackRef.current.push(entry);
    // 限制栈深度
    if (backStackRef.current.length > MAX_HISTORY) {
      backStackRef.current = backStackRef.current.slice(-MAX_HISTORY);
    }
    // 新跳转后前进栈失效
    forwardStackRef.current = [];
  }, []);

  /**
   * Go Back：弹出后退栈，把当前位置压入前进栈
   * @param currentEntry 当前位置（会压入前进栈）
   * @returns 要跳回的位置，或 null（栈空）
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
   * Go Forward：弹出前进栈，把当前位置压入后退栈
   * @param currentEntry 当前位置（会压入后退栈）
   * @returns 要跳到的位置，或 null（栈空）
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
