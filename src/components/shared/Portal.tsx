'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Unified Portal component with built-in SSR safety guard.
 * Usage: <Portal>{children}</Portal>
 *
 * Uses useSyncExternalStore instead of useState+useEffect to
 * synchronously obtain document.body on first client render,
 * avoiding extra render cycles and child ref timing issues.
 */

const noop = () => () => {};
const getBody = () => document.body;
const getNull = () => null as HTMLElement | null;

export function Portal({ children }: { children: ReactNode }) {
  const container = useSyncExternalStore(noop, getBody, getNull);

  if (!container) return null;
  return createPortal(children, container);
}
