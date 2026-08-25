'use client';

import type React from 'react';
import { useRef } from 'react';
import { useWebSocket } from '@cockpit/shared-ui';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import type { ChatMessage, ChatEngine, LiveOutputTokens } from './types';
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
  opts?: {
    onRunningChange?: (running: boolean) => void;
    onComplete?: () => void;
    onLiveOutputTokens?: (tokens: LiveOutputTokens | null) => void;
    onRunStartedAt?: (startedAt: number | null) => void;
  }
): void {
  const curAssistantId = useRef<string | null>(null);
  const seq = useRef(0);
  const fallbackOutputTokens = useRef(0);
  const sawServerUsageUpdate = useRef(false);
  const sawResult = useRef(false);
  // Whether a turn is actively producing (between system.init and its result). Used to tell a
  // BACKGROUND task's notification (arrives while idle, after a result) from a foreground
  // subagent's (arrives mid-turn, already shown as its tool call).
  const turnActive = useRef(false);

  // The dispatch runId of the turn being watched, taken from the seeded
  // `_human` event (startRun stamps it, and that event precedes the engine's
  // `system.init`). Stamped onto every bubble this turn produces so the diff
  // viewer can scope snapshot lookups to one turn — see ChatMessage.runId.
  const curTurnId = useRef<string | undefined>(undefined);

  const newPlaceholder = (): string => {
    const id = `live-asst-${++seq.current}`;
    curAssistantId.current = id;
    setMessages((prev) => [
      ...prev,
      { id, role: 'assistant', content: '', isStreaming: true, runId: curTurnId.current } as ChatMessage,
    ]);
    return id;
  };

  const apply = (ev: StreamEvent) => {
    const publishOutputProgress = (tokens: number) => {
      opts?.onLiveOutputTokens?.({
        outputTokens: Math.max(0, Math.round(tokens)),
      });
    };
    const bumpOutputProgress = (text: unknown) => {
      if (sawServerUsageUpdate.current || typeof text !== 'string' || !text) return;
      fallbackOutputTokens.current += estimateOutputUnits(text);
      publishOutputProgress(fallbackOutputTokens.current);
    };

    if (ev.type === 'system' && ev.subtype === 'init') {
      const isFollowUpTurn = sawResult.current;
      turnActive.current = true;
      if (!isFollowUpTurn) {
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        opts?.onLiveOutputTokens?.(null);
        opts?.onRunStartedAt?.(Date.now());
      }
      newPlaceholder(); // turn-start → new assistant bubble
      return;
    }
    if (ev.type === 'usage_update') {
      if (typeof ev.output_tokens === 'number' && Number.isFinite(ev.output_tokens)) {
        sawServerUsageUpdate.current = true;
        fallbackOutputTokens.current = Math.max(fallbackOutputTokens.current, Math.round(ev.output_tokens));
        publishOutputProgress(fallbackOutputTokens.current);
      }
      return;
    }
    if (ev.type === 'stream_event') {
      const raw = ev.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (raw?.type === 'content_block_delta' && raw.delta?.type === 'text_delta') {
        bumpOutputProgress(raw.delta.text);
      }
    }
    // Background task reporting back. When it arrives while idle (after a result, before the next
    // turn) it's a real background completion → render a muted system-event bar live, matching the
    // disk-reload view. A notification that arrives mid-turn is a foreground subagent (already
    // shown as its tool call) → skip.
    if (ev.type === 'system' && ev.subtype === 'task_notification') {
      if (!turnActive.current) {
        const id = `live-tasknotif-${ev.task_id || ++seq.current}`;
        const detail =
          `<task-notification>\n` +
          (ev.task_id ? `<task-id>${ev.task_id}</task-id>\n` : '') +
          (ev.status ? `<status>${ev.status}</status>\n` : '') +
          (ev.summary ? `<summary>${ev.summary}</summary>\n` : '') +
          (ev.output_file ? `<output-file>${ev.output_file}</output-file>\n` : '') +
          `</task-notification>`;
        setMessages((prev) => [
          ...prev,
          {
            id,
            role: 'system',
            content: ev.summary || '',
            systemEvent: { kind: 'task-notification', ...(ev.status ? { status: ev.status } : {}), detail },
          } as ChatMessage,
        ]);
      }
      return;
    }
    // Synthetic human-prompt event → render the new user bubble live. (Seeded by
    // startRun; the prompt is on no engine's SSE stream.) Two dedup layers, both
    // identity/time-based — NOT text-based, so repeated identical prompts ("继续")
    // can never suppress a genuinely new turn's bubble:
    //   1. `_turnId` (the dispatch runId): this turn's live bubble already exists → skip.
    //   2. `_ts` (startedAt) vs the most-recent user bubble's disk timestamp: written
    //      at/after run start ⇒ it IS this turn's disk copy (originator refreshed
    //      mid-run, or a scheduled task raced the incremental load) → skip.
    // Text equality remains only as the fallback for untimestamped transcripts (codex).
    if (ev.type === 'user' && ev._human) {
      const c = ev.message?.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((b) => (b as { text?: string })?.text || '').join('')
          : '';
      const turnId = typeof ev._turnId === 'string' ? ev._turnId : null;
      if (turnId) curTurnId.current = turnId;
      const startedAt = typeof ev._ts === 'number' ? ev._ts : null;
      const id = turnId ? `live-user-${turnId}` : `live-user-${++seq.current}`;
      setMessages((prev) => {
        // Layer 1 — identity: this turn's live bubble was already rendered.
        if (turnId && prev.some((m) => m.id === id)) return prev;
        // Layer 2 — disk copy: check the MOST-RECENT user bubble (scanning past trailing
        // assistant placeholders). Only SUPPRESSES a duplicate add; never deletes, so it
        // can't wipe real history.
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role !== 'user') continue;
          const ts = prev[i].timestamp ? Date.parse(prev[i].timestamp as string) : NaN;
          if (startedAt !== null && !Number.isNaN(ts)) {
            if (ts >= startedAt) return prev; // this turn's disk copy → skip
            // older than this run → a prior turn (even if the text matches) → render
          } else if (prev[i].content === text) {
            return prev; // no timestamp to classify by → legacy text fallback
          }
          break;
        }
        return [...prev, { id, role: 'user', content: text } as ChatMessage];
      });
      return;
    }
    // A result ends the active turn — after it, an incoming task_notification is a background one.
    if (ev.type === 'result') {
      turnActive.current = false;
      sawResult.current = true;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as Array<{ text?: string; name?: string; input?: unknown }>) {
        if (block.text) bumpOutputProgress(block.text);
        else if (block.name) bumpOutputProgress(`${block.name} ${JSON.stringify(block.input ?? {})}`);
      }
    }
    if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as Array<{ content?: unknown }>) {
        bumpOutputProgress(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''));
      }
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
        startedAt?: number;
        runId?: string;
        events?: unknown[];
        outputTokens?: number;
        message?: Record<string, unknown>;
      };
      if (msg.type === 'run-snapshot' && Array.isArray(msg.events)) {
        // Authoritative turn identity, and the only source for an images-only
        // turn (which seeds no `_human` event). Set before the replay below so
        // every bubble it creates is stamped.
        if (typeof msg.runId === 'string' && msg.runId) curTurnId.current = msg.runId;
        // Idle run → nothing to stream; the disk history already loaded is authoritative.
        if (msg.status !== 'running') {
          opts?.onRunningChange?.(false);
          opts?.onLiveOutputTokens?.(null);
          opts?.onRunStartedAt?.(null);
          fallbackOutputTokens.current = 0;
          sawServerUsageUpdate.current = false;
          sawResult.current = false;
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
        // Fingerprint THIS turn from the snapshot. The registry buffers only the current
        // in-flight turn (a fresh events[] per startRun), so its top-level uuids and tool_use
        // ids uniquely identify the turn's disk image — a prior completed turn that merely
        // shares the prompt text carries different uuids/tool ids and won't match.
        const snapUuids = new Set<string>();
        const snapToolIds = new Set<string>();
        for (const e of msg.events as StreamEvent[]) {
          const u = (e as { uuid?: string })?.uuid;
          if (typeof u === 'string') snapUuids.add(u);
          if (e?.type === 'assistant' && Array.isArray(e.message?.content)) {
            for (const b of e.message.content as Array<{ name?: string; id?: string }>) {
              if (b?.name && typeof b.id === 'string') snapToolIds.add(b.id);
            }
          }
        }
        const startedAt = typeof msg.startedAt === 'number' ? msg.startedAt : null;
        setMessages((prev) => {
          const base = prev.filter((m) => !(typeof m.id === 'string' && m.id.startsWith('live-')));
          // Drop the in-flight turn's DISK image when a viewer joined mid-run and the initial
          // history load already rendered it — this is what prevents the "2 user + 2 assistant"
          // double-render. The snapshot then re-renders that turn from live events.
          //
          // PRIMARY — time boundary: the in-flight turn's disk image is exactly the trailing
          // messages stamped at/after the run's startedAt (same machine, same clock; the
          // engine flushes the user line only after startRun). Content-independent, so a
          // repeated "继续" prompt can never cut a prior turn, and it needs no in-memory ids
          // — it survives a mid-run refresh. Only applies when the tail is timestamped
          // (claude/deepseek/codex/new-ollama transcripts all are).
          const lastMsg = base[base.length - 1];
          const lastTs = lastMsg?.timestamp ? Date.parse(lastMsg.timestamp) : NaN;
          if (startedAt !== null && !Number.isNaN(lastTs)) {
            let cut = base.length;
            while (cut > 0) {
              const m = base[cut - 1];
              const ts = m.timestamp ? Date.parse(m.timestamp) : NaN;
              if (!Number.isNaN(ts) && ts >= startedAt) cut--;
              else break;
            }
            // cut === base.length ⇒ the in-flight turn isn't on disk → nothing to remove.
            return cut < base.length ? base.slice(0, cut) : base;
          }
          // FALLBACK — untimestamped tail (codex transcripts): locate by prompt text, confirm
          // by snapshot fingerprint (pre-startedAt behavior, unchanged).
          if (!humanText) return base;
          // Only the MOST-RECENT user bubble can be this turn's prompt. If it doesn't match the
          // in-flight prompt text, the in-flight user isn't on disk → nothing to cut. (This also
          // skips a repeated "continue"/"go on" whose matching user is an OLDER completed turn.)
          let ui = -1;
          for (let i = base.length - 1; i >= 0; i--) {
            if (base[i].role === 'user') {
              if (base[i].content === humanText) ui = i;
              break;
            }
          }
          if (ui === -1) return base;
          // Cut [matching user … end] ONLY when everything after that user is THIS turn's
          // already-flushed assistant — verified by uuid / tool_use id membership in the
          // snapshot (which holds only the current turn). A Claude turn flushes its
          // "text + tool_use" assistant message to the jsonl BEFORE the run ends, so the disk
          // tail mid-run is `user → assistant(+tools)`, not just a bare trailing user; the old
          // last-only check missed that assistant and double-rendered it. Anything that does NOT
          // match the snapshot is real prior history → left untouched (the live turn still
          // renders fresh, and onComplete reconciles any transient overlap).
          const after = base.slice(ui + 1);
          const isInflightTail = after.every(
            (m) =>
              m.role === 'assistant' &&
              ((typeof m.id === 'string' && snapUuids.has(m.id)) ||
                (!!m.toolCalls?.length && m.toolCalls.every((tc) => snapToolIds.has(tc.id))))
          );
          return isInflightTail ? base.slice(0, ui) : base;
        });
        curAssistantId.current = null;
        seq.current = 0;
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        sawResult.current = false;
        turnActive.current = false;
        const snapshotOutputTokens = typeof msg.outputTokens === 'number' && Number.isFinite(msg.outputTokens)
          ? Math.max(0, Math.round(msg.outputTokens))
          : null;
        if (snapshotOutputTokens !== null) {
          fallbackOutputTokens.current = snapshotOutputTokens;
          sawServerUsageUpdate.current = true;
          opts?.onLiveOutputTokens?.({ outputTokens: snapshotOutputTokens });
        }
        for (const ev of msg.events) {
          apply(ev as StreamEvent);
        }
        opts?.onRunningChange?.(true);
        opts?.onRunStartedAt?.(typeof msg.startedAt === 'number' ? msg.startedAt : Date.now());
      } else if (msg.type === 'run-event' && msg.message) {
        // 'run-ended' is the single definitive end signal — engines may emit several
        // intermediate 'result's (codex = one per turn), so end only on run-ended.
        if (msg.message.type === 'run-ended') {
          opts?.onRunningChange?.(false);
          opts?.onLiveOutputTokens?.(null);
          opts?.onRunStartedAt?.(null);
          fallbackOutputTokens.current = 0;
          sawServerUsageUpdate.current = false;
          sawResult.current = false;
          opts?.onComplete?.();
          return;
        }
        apply(msg.message as StreamEvent);
        opts?.onRunningChange?.(true);
      } else if (msg.type === 'run-idle') {
        opts?.onRunningChange?.(false);
        opts?.onLiveOutputTokens?.(null);
        opts?.onRunStartedAt?.(null);
        fallbackOutputTokens.current = 0;
        sawServerUsageUpdate.current = false;
        sawResult.current = false;
      }
      // ping: nothing to do
    },
  });
}
