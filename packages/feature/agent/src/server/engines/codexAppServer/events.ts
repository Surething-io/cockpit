/**
 * Translate app-server notifications into the exec-shaped events the existing
 * Codex adapter already consumes.
 *
 * The point of the shim is what it lets us NOT touch: `createCodexEventAdapter`
 * carries every tool-call, sub-agent, todo and diff behaviour this engine has,
 * and all of it keeps working unchanged if the events keep their old shape.
 * Only the text path is new, because only the text path is what the migration
 * was for.
 *
 * The two protocols describe the same items in different spellings:
 *
 *   exec  `{"type":"item.completed","item":{"type":"command_execution",
 *           "aggregated_output":"…","exit_code":0}}`
 *   app-server  `item/completed` with
 *          `{"item":{"type":"commandExecution","aggregatedOutput":"…","exitCode":0}}`
 *
 * So the conversion is mechanical: dots for slashes on the method, snake_case
 * for camelCase on every key. Doing it generically rather than field-by-field
 * means an item type this file has never heard of still arrives intact.
 */

import type { CodexNotification } from './client';

/** Shape-compatible with the engine's internal `CodexEvent`; kept structural on purpose. */
export interface ExecShapedEvent {
  type: string;
  thread_id?: string;
  item?: Record<string, unknown>;
  message?: string;
  error?: { message?: string };
  usage?: Record<string, number>;
}

export type ShimOutput =
  | { kind: 'event'; event: ExecShapedEvent }
  /** Incremental assistant text. Has no exec-side equivalent — that is the point. */
  | { kind: 'text-delta'; text: string };

const camelToSnake = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Keys whose VALUES are somebody else's data, not this protocol's shape.
 *
 * The rewrite below is a spelling change for protocol fields; applied to an MCP
 * tool's own arguments it silently corrupts them — a tool called with
 * `{ filePath }` would be displayed, and re-sent, as `{ file_path }`. These
 * subtrees are copied through untouched.
 */
const OPAQUE_VALUE_KEYS = new Set([
  'arguments',        // an MCP tool's own input object
  'structuredContent', // an MCP tool's own result payload
  'result',
  'agentsStates',     // keyed by agent thread id
  'input',
]);

/**
 * Recursive because item payloads nest (`changes[].movePath`,
 * `commandActions[].path`). Arrays are mapped, not treated as objects, so
 * indices survive.
 */
function snakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[camelToSnake(k)] = OPAQUE_VALUE_KEYS.has(k) ? v : snakeCaseKeys(v);
  }
  return out;
}

function normalizeItem(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const item = snakeCaseKeys(raw) as Record<string, unknown>;
  // The discriminator is a VALUE, not a key, so the generic key rewrite above
  // leaves it camelCased. Every downstream `switch (item.type)` compares
  // against the exec spelling, so converting it here is what makes the whole
  // shim work — and its absence is silent: unknown type, no bubble, no error.
  if (typeof item.type === 'string') item.type = camelToSnake(item.type);
  /**
   * Two spellings that the mechanical rewrite gets wrong, both of which cost a
   * whole feature when they silently miss.
   *
   * `collabAgentToolCall` snake-cases to `collab_agent_tool_call`, but the exec
   * name for the same item — the one the adapter switches on — is
   * `collab_tool_call`. Left unaliased, every sub-agent Task bubble's live path
   * is dead code and the rollout reader is silently doing all the work.
   *
   * And `item.tool` is a VALUE, so it stays camelCase (`spawnAgent`) while the
   * adapter compares against `spawn_agent`. Same class of bug as `item.type`,
   * one level down.
   */
  if (item.type === 'collab_agent_tool_call') item.type = 'collab_tool_call';
  if (item.type === 'collab_tool_call' && typeof item.tool === 'string') {
    item.tool = camelToSnake(item.tool);
  }

  /**
   * One place where the two protocols differ STRUCTURALLY, not just in
   * spelling, so the generic key rewrite cannot reach it: a file change's
   * `kind` is a bare string under exec (`"update"`) and a tagged object under
   * app-server (`{ type: "update", move_path: null }`).
   *
   * Left alone it renders as `[object Object] /path/to/file` in the patch
   * bubble and in its tool result — caught only by running a real apply_patch
   * turn, because every unit fixture in this file was written in the exec
   * spelling and so never carried the object form.
   */
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    item.changes = (item.changes as Array<Record<string, unknown>>).map((change) => {
      const kind = change.kind;
      if (kind && typeof kind === 'object' && typeof (kind as { type?: unknown }).type === 'string') {
        return { ...change, kind: (kind as { type: string }).type };
      }
      return change;
    });
  }
  return item;
}

/**
 * `turn/completed` carries no usage; the running totals arrive separately on
 * `thread/tokenUsage/updated`. Holding the last one lets the terminal event
 * report the same numbers the exec transport did.
 */
export class CodexEventShim {
  private lastUsage: Record<string, number> | undefined;
  private threadId: string | null = null;
  private planSeq = 0;
  /**
   * Turns in flight, by thread. Recorded for EVERY thread including the
   * sub-agents this shim otherwise filters out, because interrupting a run
   * needs their ids: a parent's `turn/interrupt` does not cascade — measured,
   * the children kept working for the twelve seconds the probe watched.
   */
  private readonly liveTurns = new Map<string, string>();

  /** The turn this connection started. Its own `turn/started` arrives too, but
   *  a stop must work even if it has not yet. */
  noteOwnTurn(threadId: string, turnId: string): void {
    this.liveTurns.set(threadId, turnId);
  }

  /** Threads with a turn in flight, children first: a parent interrupted while
   *  its children still run leaves them orphaned. */
  activeTurns(): Array<{ threadId: string; turnId: string }> {
    const out: Array<{ threadId: string; turnId: string }> = [];
    for (const [threadId, turnId] of this.liveTurns) {
      if (threadId !== this.threadId) out.push({ threadId, turnId });
    }
    const own = this.threadId && this.liveTurns.get(this.threadId);
    if (this.threadId && own) out.push({ threadId: this.threadId, turnId: own });
    return out;
  }

  /**
   * Name the thread this turn belongs to. Everything from any other thread is
   * dropped — see `handle`.
   */
  bindThread(threadId: string): void {
    this.threadId = threadId;
  }

  handle(n: CodexNotification): ShimOutput[] {
    /**
     * Sub-agents are FULL THREADS under app-server, with their own turns, and
     * they publish onto the same connection as their parent. Two consequences,
     * both of which cost a real run before this guard existed:
     *
     *   1. A child finishing emits `turn/completed`. Read as the parent's
     *      terminal it ends the run and tears the process down — killing the
     *      parent mid-`wait_agent` and any sibling still working.
     *   2. A child's `item/agentMessage/delta` would stream the sub-agent's
     *      prose into the parent's own bubble.
     *
     * The exec transport surfaced no child traffic at all, so the parent's view
     * of its sub-agents is built entirely from `collab_tool_call` items on its
     * OWN thread plus the rollout reader. Dropping foreign threads is what
     * keeps that true.
     *
     * Notifications with no `threadId` (account/rate-limit and other global
     * chatter) fall through and are ignored by the default branch anyway.
     */
    const from = n.params.threadId;

    // Before the filter: a child's turn ids are exactly what the filter drops,
    // and exactly what a clean stop needs.
    if (typeof from === 'string') {
      if (n.method === 'turn/started') {
        const turnId = (n.params.turn as { id?: string } | undefined)?.id;
        if (turnId) this.liveTurns.set(from, turnId);
      } else if (n.method === 'turn/completed') {
        this.liveTurns.delete(from);
      }
    }

    if (this.threadId !== null && typeof from === 'string' && from !== this.threadId) return [];

    switch (n.method) {
      case 'item/agentMessage/delta': {
        const text = typeof n.params.delta === 'string' ? n.params.delta : '';
        return text ? [{ kind: 'text-delta', text }] : [];
      }

      case 'item/started':
      case 'item/completed': {
        const item = normalizeItem(n.params.item);
        if (!item) return [];
        // The user's own turn comes back as an item. Cockpit rendered it
        // optimistically before the request left the browser; echoing it would
        // duplicate the bubble.
        if (item.type === 'user_message') return [];
        // Assistant prose already went out delta by delta. Forwarding the
        // completed item too would append the whole message a second time —
        // the exact double-count that the `engine === 'codex'` branch in
        // applyStreamEvent exists to arbitrate.
        if (item.type === 'agent_message') return [];
        return [
          {
            kind: 'event',
            event: {
              type: n.method === 'item/started' ? 'item.started' : 'item.completed',
              ...(typeof n.params.threadId === 'string' ? { thread_id: n.params.threadId } : {}),
              item,
            },
          },
        ];
      }

      /**
       * The plan. There is no `todoList` item type in this protocol — the
       * bubble the adapter still knows how to draw is fed by a notification
       * instead, so without this a Codex turn simply loses its todo list.
       *
       * A fresh id per update mirrors what the exec transport did (one item per
       * plan revision, one bubble each) rather than inventing an update-in-place
       * the renderer has no path for.
       */
      case 'turn/plan/updated': {
        const plan = n.params.plan as Array<{ step?: string; status?: string }> | undefined;
        if (!plan?.length) return [];
        this.planSeq += 1;
        const turnId = typeof n.params.turnId === 'string' ? n.params.turnId : 'turn';
        return [
          {
            kind: 'event',
            event: {
              type: 'item.completed',
              item: {
                type: 'todo_list',
                id: `plan-${turnId}-${this.planSeq}`,
                // Three states, carried through: the checklist renders
                // in-progress differently from not-yet-started.
                items: plan.map((s) => ({
                  text: s.step ?? '',
                  status: camelToSnake(s.status ?? 'pending'),
                })),
              },
            },
          },
        ];
      }

      case 'thread/tokenUsage/updated': {
        const usage = (n.params.tokenUsage as { total?: Record<string, number> } | undefined)?.total;
        if (usage) {
          this.lastUsage = {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cached_input_tokens: usage.cachedInputTokens ?? 0,
            cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0,
          };
        }
        return [];
      }

      /**
       * There is no `turn/failed` notification — the protocol has exactly one
       * terminal, and failure rides on it as `turn.status`. Reading only the
       * method name (as this did) reports a failed or interrupted turn as a
       * clean success: the run ends, the spinner stops, and nothing anywhere
       * says why.
       */
      case 'turn/completed': {
        const turn = n.params.turn as
          | { status?: string; error?: { message?: string; additionalDetails?: string | null } }
          | undefined;
        const status = turn?.status;
        /**
         * `interrupted` is NOT a failure. It is the terminal a turn gets when
         * someone asked it to stop — which, in this client, is always the user
         * pressing stop. Reporting it as an error marked every deliberate stop
         * as a failed run.
         *
         * `failed` is the one that carries a reason worth surfacing.
         */
        if (status === 'failed') {
          const detail = turn?.error?.additionalDetails;
          const message =
            [turn?.error?.message, detail].filter(Boolean).join(' — ') || 'Codex turn failed';
          return [{ kind: 'event', event: { type: 'turn.failed', error: { message } } }];
        }
        return [{ kind: 'event', event: { type: 'turn.completed', ...(this.lastUsage ? { usage: this.lastUsage } : {}) } }];
      }

      /**
       * `{ error: { message, additionalDetails }, willRetry }` — the message is
       * NESTED, and reading a top-level `message` (as this did) always fell
       * through to a generic string.
       *
       * `willRetry` is the load-bearing half: the server is about to try again,
       * so surfacing this as an error would both lie to the user and — because
       * the adapter latches `terminated` on an error — go deaf to the retry's
       * events, leaving the turn to hang until it is aborted by hand.
       */
      case 'error': {
        if (n.params.willRetry === true) return [];
        const error = n.params.error as { message?: string; additionalDetails?: string | null } | undefined;
        const message =
          [error?.message, error?.additionalDetails].filter(Boolean).join(' — ') || 'Codex error';
        return [{ kind: 'event', event: { type: 'error', message } }];
      }

      default:
        // 72 server notification methods exist and Cockpit consumes a handful.
        // Ignoring the rest is deliberate: the protocol is marked experimental,
        // so an unknown method has to be survivable, not fatal.
        return [];
    }
  }
}
