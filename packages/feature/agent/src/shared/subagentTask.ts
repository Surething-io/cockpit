/**
 * Liveness of the background TASK a tool call spawned — as opposed to the tool call itself.
 *
 * Why this exists at all: `ToolCallInfo.isLoading` / `.result` answer "does this tool call have
 * a result yet". That used to double as "is the subagent still working", and stopped being true
 * the moment the CLI made subagents background by default: an `Agent` launch now answers within
 * ~30ms with a receipt
 *
 *     {"isAsync": true, "status": "async_launched", "agentId": "aeb1bd377987c761c", …}
 *
 * while the agent itself runs for minutes. Every `Agent` call in a measured transcript resolved
 * in ≤0.03s, so the old signal is not merely imprecise — under the current default it is wrong
 * essentially always. Keep the two separate: `isLoading` stays the tool call's own state, `task`
 * carries the spawned work's.
 *
 * The join key is `tool_use_id`, which `system/task_started`, `system/task_progress` and
 * `system/task_notification` all carry, and which the persisted `<task-notification>` block
 * repeats as `<tool-use-id>` — so the same status is derivable live and from disk, which is what
 * keeps a reload from contradicting the screen.
 *
 * Shared (not client-only) because both server transcript parsers build it too.
 */

/**
 * `running` is a CLAIM ABOUT RIGHT NOW and may only ever be written by a live event from the
 * process that owns the task — never reconstructed from a transcript. A launch receipt on disk
 * with no matching notification says the outcome was never recorded, which is `unknown`, not
 * `running`: the owning CLI process is long gone, so nothing it spawned can still be working.
 *
 * Collapsing those two is how a stale task comes back to life. An interrupted run leaves a
 * launch receipt with no notification; if that reloads as `running`, the row needs some other
 * signal to suppress it, and the only one in scope is session-level ("is ANY run active"), which
 * is true again the moment the user sends an unrelated next message. The task then re-spins and
 * re-polls a transcript that stopped growing hours ago. Keeping `unknown` distinct removes the
 * need for that second signal entirely.
 */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/** The spawned task's state, hung off the tool call that spawned it. */
export interface ToolCallTask {
  status: TaskStatus;
  /** SDK `task_id` — the CLI's `agentId` for a subagent task. */
  id?: string;
  /** `system/task_progress`: the tool the subagent is running right now. */
  lastToolName?: string;
  /** Cumulative counters from `system/task_progress`. */
  toolUses?: number;
  durationMs?: number;
  /** One-line progress (task_progress) or completion (task_notification) summary. */
  summary?: string;
}

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);

/** Narrow an untrusted `<status>` / `status` value to a terminal TaskStatus. */
export function asTerminalStatus(value: unknown): TaskStatus | null {
  return typeof value === 'string' && TERMINAL.has(value) ? (value as TaskStatus) : null;
}

/**
 * The `agentId` of a background launch, read from the tool_result's STRUCTURED payload
 * (`toolUseResult` on disk, `tool_use_result` on the wire) — never by pattern-matching the
 * receipt prose, which is model-facing text and free to change.
 *
 * Returns null for a synchronous call, so "has a task" and "is async" are the same question.
 */
export function asyncLaunchTaskId(toolUseResult: unknown): string | null {
  if (typeof toolUseResult !== 'object' || toolUseResult === null) return null;
  const r = toolUseResult as { isAsync?: unknown; status?: unknown; agentId?: unknown };
  if (r.isAsync !== true && r.status !== 'async_launched') return null;
  return typeof r.agentId === 'string' && r.agentId ? r.agentId : null;
}

/**
 * Parse a persisted `<task-notification>` block. `<tool-use-id>` is what links it back to the
 * spawning call; without it the notification can still render its own system row but cannot
 * settle a tool call, so callers must treat a missing id as "not mine".
 */
export function parseTaskNotification(raw: string): {
  taskId?: string;
  toolUseId?: string;
  status?: TaskStatus;
  summary?: string;
} | null {
  if (!raw.includes('<task-notification>')) return null;
  const pick = (tag: string) =>
    raw.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() || undefined;
  const status = asTerminalStatus(pick('status'));
  return {
    taskId: pick('task-id'),
    toolUseId: pick('tool-use-id'),
    ...(status ? { status } : {}),
    summary: pick('summary'),
  };
}
