'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 统一的 Portal 组件，内置 SSR 安全守卫。
 * 用法：<Portal>{children}</Portal>
 * 替代散落各处的 createPortal(content, document.body) + isMounted 模式。
 */
export function Portal({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(document.body);
  }, []);

  if (!container) return null;
  return createPortal(children, container);
}
