'use client';

import type React from 'react';
import { useRef } from 'react';
import { useWebSocket } from '@cockpit/shared-ui';
import type { ChatMessage, ChatEngine } from './types';
import { applyStreamEvent, type StreamEvent } from './applyStreamEvent';

// #10 viewer hook: tail /ws/session-stream for `sessionId` and render live through the
// SAME reducer the originator uses (applyStreamEvent) → engine-agnostic, zero per-engine
// code. The registry stores the SSE events every route emits; the viewer creates the
// assistant bubble on `system.init` (universal turn-start) and feeds the rest through
// applyStreamEvent. The user bubble is the synthetic `_human` event the run seeds.
//
// The session-stream SNAPSHOT is the source of truth for "is a run live", NOT the
// global-state broadcast (which races a freshly-loaded tab and is delivered once over a
// shared connection): connect whenever this tab is viewing the session, and let the
// snapshot's `status` decide. An idle snapshot → render nothing (disk history is
// authoritative); a running snapshot → replay + tail. opts.onRunningChange drives the
// "thinking" indicator / input lock; opts.onComplete fires on the turn's result so the
// caller can reconcile from disk.
export function useLiveStream(
  sessionId: string | null,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  enabled: boolean,
  engine?: ChatEngine,
  opts?: { onRunningChange?: (running: boolean) => void; onComplete?: () => void }
): void {
  const curAssistantId = useRef<string | null>(null);
  const seq = useRef(0);

  const newPlaceholder = (): string => {
    const id = `live-asst-${++seq.current}`;
    curAssistantId.current = id;
    setMessages((prev) => [...prev, { id, role: 'assistant', content: '', isStreaming: true } as ChatMessage]);
    return id;
  };

  const apply = (ev: StreamEvent) => {
    if (ev.type === 'system' && ev.subtype === 'init') {
      newPlaceholder(); // turn-start → new assistant bubble
      return;
    }
    // Synthetic human-prompt event → render the new user bubble live. (Seeded by
    // startRun; the prompt is on no engine's SSE stream.) Dedup against the last
    // message so an originator that refreshed mid-run — and thus already loaded the
    // user message from disk — doesn't show it twice.
    if (ev.type === 'user' && ev._human) {
      const c = ev.message?.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b as { text?: string })?.text || '').join('')
          : '';
      const id = `live-user-${++seq.current}`;
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'user' && last.content === text) return prev;
        return [...prev, { id, role: 'user', content: text } as ChatMessage];
      });
      return;
    }
    // content events need a current bubble (init normally comes first; be safe)
    const assistantId = curAssistantId.current ?? newPlaceholder();
    setMessages((prev) => applyStreamEvent(prev, ev, { engine, assistantId }));
  };

  useWebSocket({
    url: sessionId ? `/ws/session-stream?sessionId=${encodeURIComponent(sessionId)}` : '/ws/session-stream',
    enabled: enabled && !!sessionId,
    onMessage: (data) => {
      const msg = data as {
        type?: string;
        status?: string;
        events?: unknown[];
        message?: Record<string, unknown>;
      };
      if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
        // Idle run → nothing to stream; the disk history already loaded is authoritative.
        if (msg.status !== 'running') {
          opts?.onRunningChange?.(false);
          return;
        }
        // Authoritative replay of the in-flight turn. The snapshot owns this turn, so drop:
        //   • any prior temp live bubbles (handles reconnect), and
        //   • the in-flight turn's DISK version when a viewer joined mid-run and the initial
        //     history load already rendered it — this is what prevents the "2 user + 2
        //     assistant" double-render. Identify it precisely by the synthetic _human prompt
        //     so a reconnect (where the in-flight turn is live-*, and base's last turn is a
        //     COMPLETED prior turn) does NOT wipe a real prior turn.
        const humanEv = msg.events.find(
          (e) => (e as StreamEvent)?.type === 'user' && (e as StreamEvent)?._human
        ) as StreamEvent | undefined;
        const hc = humanEv?.message?.content;
        const humanText = typeof hc === 'string' ? hc : '';
        setMessages((prev) => {
          const base = prev.filter((m) => !(typeof m.id === 'string' && m.id.startsWith('live-')));
          // Cut the in-flight turn's disk image ONLY when it is the exact tail shape we know
          // it has mid-run: a trailing USER bubble whose text matches the in-flight prompt,
          // with nothing after it (the assistant hasn't been flushed to disk yet). The
          // snapshot then re-renders that turn from live events.
          //
          // Anchor on POSITION (must be the very last message), not just text. The old
          // backward scan cut at the last user message that matched — but if the in-flight
          // turn wasn't on disk yet, that "last user" was a COMPLETED PRIOR turn that merely
          // shared the prompt text (a repeated "continue"/"go on"), and `slice(0,i)` deleted
          // it AND everything after → real history vanished. If a completed assistant already
          // follows the matching user, this is a prior turn: never delete it — accept a
          // transient double-render that onComplete reconciles instead.
          if (humanText) {
            const last = base[base.length - 1];
            if (last && last.role === 'user' && last.content === humanText) {
              return base.slice(0, base.length - 1);
            }
          }
          return base;
        });
        curAssistantId.current = null;
        seq.current = 0;
        for (const ev of msg.events) apply(ev as StreamEvent);
        opts?.onRunningChange?.(true);
      } else if (msg.type === 'run-event' && msg.message) {
        // 'run-ended' is the single definitive end signal — engines may emit several
        // intermediate 'result's (codex = one per turn), so end only on run-ended.
        if (msg.message.type === 'run-ended') {
          opts?.onRunningChange?.(false);
          opts?.onComplete?.();
          return;
        }
        apply(msg.message as StreamEvent);
        opts?.onRunningChange?.(true);
      } else if (msg.type === 'run-idle') {
        opts?.onRunningChange?.(false);
      }
      // ping: nothing to do
    },
  });
}
