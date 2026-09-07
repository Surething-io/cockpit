'use client';

/**
 * Live state of every task this session has spawned, keyed by the `tool_use_id` that spawned it
 * — INCLUDING the ones no rendered message can hold.
 *
 * `applyStreamEvent` already folds `system/task_*` onto the matching tool call, which covers a
 * top-level Agent row. It cannot cover a sub-agent's own sub-agent: that spawning call lives in
 * the sub-agent's transcript, a separate jsonl only SubagentTranscriptModal ever renders, and
 * that modal keeps its own message array fed purely by disk polling. So the event arrives, finds
 * nothing to attach to, and is dropped — which is why a nested agent shows no state at any
 * depth, forever.
 *
 * Disk cannot answer it either. In a SUB-agent's transcript the CLI writes neither half of the
 * metadata it writes in the main one: the async launch receipt carries `toolUseResult: null`
 * (the agentId appears only in prose the tool result explicitly forbids quoting), and no
 * `<task-notification>` is ever recorded — verified on a finished depth-1 agent whose five
 * children all completed. So for depth >= 2 the live stream is the ONLY source there is.
 *
 * Hence a store beside the message tree rather than inside it, read by tool_use_id at any depth.
 *
 * Two properties it must keep, both inherited from ToolCallTask's contract:
 *
 *  - It is LIVE-ONLY. Nothing here survives a reload, and nothing reconstructs it from a
 *    transcript. `running` stays a claim made by the process that owns the task.
 *  - `settleRunning()` on run end, exactly like settleRunningTasks does for messages. The owning
 *    process is gone, so nothing it spawned is still working.
 *
 * Subscription rather than a context value: a `task_progress` tick would otherwise re-render
 * every tool row in the session (a context update bypasses the memo on MessageBubble). Each row
 * subscribes for its own id and re-renders only when THAT id's entry changes — which holds
 * because entries are replaced per key, so untouched keys keep their object identity and
 * useSyncExternalStore bails out on Object.is.
 */

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { mergeTaskEvent, type StreamEvent } from './applyStreamEvent';
import type { ToolCallTask } from './types';

export interface TaskStore {
  /** Record one `system/task_*` event. No-op for ambient housekeeping or an unkeyed event. */
  applyEvent(ev: StreamEvent): void;
  /** Current state of the task spawned by `toolUseId`, or undefined if none was ever seen. */
  getTask(toolUseId: string): ToolCallTask | undefined;
  /** Run ended → demote every `running` entry to `unknown`. */
  settleRunning(): void;
  subscribe(listener: () => void): () => void;
}

export function createTaskStore(): TaskStore {
  const tasks = new Map<string, ToolCallTask>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());

  return {
    applyEvent(ev) {
      const id = ev.tool_use_id;
      if (!id || ev.ambient) return;
      const next = mergeTaskEvent(tasks.get(id), ev);
      tasks.set(id, next);
      emit();
    },
    getTask: (toolUseId) => tasks.get(toolUseId),
    settleRunning() {
      let changed = false;
      for (const [id, task] of tasks) {
        if (task.status !== 'running') continue;
        tasks.set(id, { ...task, status: 'unknown' });
        changed = true;
      }
      if (changed) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Default for hosts that render message bubbles outside a live session — ScheduledTaskPreview,
 * and any future read-only surface. Every read misses, so those rows fall back to whatever the
 * transcript reconstructed, which is the correct answer there.
 */
const INERT: TaskStore = {
  applyEvent: () => {},
  getTask: () => undefined,
  settleRunning: () => {},
  subscribe: () => () => {},
};

export const TaskStoreContext = createContext<TaskStore>(INERT);

/**
 * The live task spawned by this tool call, or undefined.
 *
 * Callers prefer this over `toolCall.task`: both describe the same task, but this one was
 * observed on the wire while the other was reconstructed from a transcript, so it is never the
 * staler of the two.
 */
export function useLiveTask(toolUseId: string | undefined): ToolCallTask | undefined {
  const store = useContext(TaskStoreContext);
  const getSnapshot = useCallback(
    () => (toolUseId ? store.getTask(toolUseId) : undefined),
    [store, toolUseId]
  );
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
