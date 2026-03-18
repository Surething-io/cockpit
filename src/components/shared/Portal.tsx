'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * 统一的 Portal 组件，内置 SSR 安全守卫。
 * 用法：<Portal>{children}</Portal>
 *
 * 使用 useSyncExternalStore 替代 useState+useEffect，
 * 确保客户端首次渲染即同步获取 document.body，
 * 不产生额外渲染周期，避免子组件 ref 时序问题。
 */

const noop = () => () => {};
const getBody = () => document.body;
const getNull = () => null as HTMLElement | null;

export function Portal({ children }: { children: ReactNode }) {
  const container = useSyncExternalStore(noop, getBody, getNull);

  if (!container) return null;
  return createPortal(children, container);
}
