'use client';

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from './types';
import type { HistoryReference } from '../shared/historyReference';
import type { HistoryJumpResult } from './useChatHistory';

export type NavigationResult = { status: 'scrolled' | 'cancelled' | 'failed' | 'missing' | 'stale' };
interface Target { id: string; turnIndex: number; sourceRef?: HistoryReference }

function findTarget(messages: ChatMessage[], target: Target, id = target.id) {
  const reference = target.sourceRef;
  return messages.find((message) => reference
    ? reference.sourceId ? message.sourceRef?.sourceId === reference.sourceId
      : message.id === reference.id && message.sourceRef?.prefix === reference.prefix
    : message.id === id);
}

/** Data loading and viewport acknowledgement are separate stages of one user operation. */
export function useMessageNavigation(
  sessionKey: string, messages: ChatMessage[], isActive: boolean,
  ensure: (index: number, target?: HistoryReference) => Promise<HistoryJumpResult>,
  scroll: (id: string) => boolean,
  cancelLoad?: () => void,
) {
  const messagesRef = useRef(messages);
  // Scroll against the committed list, never an in-progress React render.
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const pending = useRef<{ id: string; loading: boolean; target: Target; finish: (result: NavigationResult) => void } | null>(null);
  const [ready, setReady] = useState(0);
  const cancel = useCallback(() => {
    cancelLoad?.();
    pending.current?.finish({ status: 'cancelled' });
    pending.current = null;
  }, [cancelLoad]);
  useLayoutEffect(() => cancel, [sessionKey, cancel]);
  useLayoutEffect(() => {
    const operation = pending.current;
    if (!operation || operation.loading || !isActive) return;
    // Run after the list's own layout work; IO waiting never consumes animation frames.
    const frame = requestAnimationFrame(() => {
      if (pending.current !== operation) return;
      const row = findTarget(messagesRef.current, operation.target, operation.id);
      // History can replace an ordinal ID between data readiness and this frame.
      // A missing native reference must never fall back to that reused ID.
      const status = row ? scroll(row.id) ? 'scrolled' : 'failed'
        : operation.target.sourceRef && !operation.target.sourceRef.sourceId ? 'stale' : 'missing';
      operation.finish({ status });
      pending.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, isActive, ready, scroll]);
  const navigate = useCallback((target: Target): Promise<NavigationResult> => {
    cancel();
    return new Promise<NavigationResult>((finish) => {
      const operation = { id: target.id, loading: true, target, finish };
      pending.current = operation;
      const loaded = findTarget(messagesRef.current, target);
      const loading: Promise<HistoryJumpResult> = loaded ? Promise.resolve({ status: 'ready', messageId: loaded.id }) : ensure(target.turnIndex, target.sourceRef);
      void loading.then((result) => {
        if (pending.current !== operation) return;
        if (result.status !== 'ready') { pending.current = null; finish(result); return; }
        operation.id = result.messageId ?? target.id;
        operation.loading = false;
        setReady((version) => version + 1);
      }, () => { if (pending.current === operation) { pending.current = null; finish({ status: 'failed' }); } });
    });
  }, [ensure, cancel]);
  return useMemo(() => Object.assign(navigate, { cancel }), [navigate, cancel]);
}
