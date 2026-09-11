import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import { CodexAppServerClient, type CodexNotification } from './codexAppServer/client';
import { CodexEventShim } from './codexAppServer/events';
import { sanitizedSpawnEnv, findCodexSessionPath } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EngineSpec, ImageData, RunCtx } from './types';
import { mergeStashedCodexRollout, stashCodexRollout } from './shared/noHistoryRollout';
import {
  CODEX_AGENT_MESSAGE_TYPE,
  CODEX_IMAGE_ONLY_TEXT,
  CODEX_SPAWN_FN_NAME,
  CODEX_TOOL_NAMES,
  codexAgentResultText,
  codexItemBubble,
  parseCodexAgentMessage,
  parseCodexAgentsStates,
  parseCodexSpawnInput,
  parseCodexSpawnOutput,
  parseCodexSubAgentActivity,
} from '../api/session/codexTools';

// Codex app-server event adapter. Translates Codex events into the same event
// shapes the other engines emit.
//
// Spelled out rather than imported from the SDK's `ModelReasoningEffort`: the
// SDK is gone, and this list is a Cockpit-side contract anyway — `codexParams`
// forwards whatever survives `resolveCodexReasoningEffort`, so an unknown value
// is dropped here rather than rejected by the server mid-turn.
type CodexReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const MEDIA_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** Write base64 images to temp files, return file paths. Caller must clean up. */
function writeImagesToTemp(images: ImageData[]): string[] {
  const dir = join(tmpdir(), 'cockpit-codex-images');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return images.map((img, i) => {
    const ext = MEDIA_EXT[img.media_type] || '.png';
    const filePath = join(dir, `img-${Date.now()}-${i}${ext}`);
    writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    return filePath;
  });
}

interface CodexItem {
  id?: string;
  call_id?: string;
  // 'agent_message' | 'reasoning' | 'command_execution' | 'file_change' | 'error'
  // | 'collab_tool_call' | 'mcp_tool_call' | 'web_search' | 'todo_list'
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>; // file_change (apply_patch) items
  // --- collab_tool_call (multi-agent) fields. The app-server spelling is
  //     `collabAgentToolCall`; the shim aliases it onto this exec name. ---
  /** 'spawn_agent' | 'wait' | 'close_agent' | 'send_input' | 'resume_agent' */
  tool?: string;
  sender_thread_id?: string;
  /** Sub-agent thread ids. EMPTY on a spawn's item.started — only item.completed has it. */
  receiver_thread_ids?: string[];
  prompt?: string | null;
  /** Live per-agent state. A DIFFERENT encoding from the rollout's wait output. */
  agents_states?: Record<string, { status?: string; message?: string | null }>;
  // --- mcp_tool_call ---
  server?: string;
  /** `tool` is shared with collab_tool_call; disambiguated by `item.type`. */
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string } | null;
  // --- web_search --- (`id` is a stable `ws_…`, matching the rollout's call_id).
  //     `action` is the exec shape; app-server sends `results` instead, which is
  //     not plumbed through — the bubble degrades to the bare query.
  query?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  // --- todo_list ---
  items?: Array<{ text?: string; completed?: boolean }>;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  message?: string;
  error?: { message?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number };
}

export function codexToolUseId(item: CodexItem): string {
  return item.call_id || item.id || `tool-${randomUUID()}`;
}

/**
 * A `spawn_agent` call. `agentId`/`nickname` are only known once codex appends the
 * paired `function_call_output`, so they arrive on a later read than `callId`.
 */
export interface RolloutSpawnCall {
  callId?: string;
  args: Record<string, unknown>;
  agentId?: string;
  nickname?: string;
  /** The sub-agent's path (`/root/cr_static`); no nickname is published here. */
  agentPath?: string;
}
/**
 * A sub-agent's final report (0.147+ `response_item`/agent_message). Keyed by the
 * author's agent path, which is what sub_agent_activity also stamps onto the spawn
 * that created it — the two together route a report to its Task bubble.
 */
export interface RolloutAgentReport { author: string; text: string }
/**
 * What the rollout still has to supply.
 *
 * It used to also carry ordered exec / patch / mcp call lists, whose only job
 * was to translate a live tool id into the persistent one. app-server hands us
 * the persistent id directly (see `toolUseIdFor`), so those lists are gone and
 * with them the ordinal matching they existed for. Sub-agents remain, for two
 * reasons neither of which is identity: the spawn's own arguments and the
 * agent's nickname are not on the live item, and a sub-agent's report is
 * published on the CHILD's thread, which this connection filters out.
 */
export interface RolloutCalls {
  spawn: ReadonlyArray<RolloutSpawnCall>;
  reports: ReadonlyArray<RolloutAgentReport>;
}


/** Parse exec_command, apply_patch, spawn_agent, MCP calls and sub-agent reports out of complete JSONL lines. */
function parseCallLines(
  text: string,
  spawns: RolloutSpawnCall[],
  reports: RolloutAgentReport[],
): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { payload?: {
      type?: string; name?: string; namespace?: string; call_id?: string;
      arguments?: string; input?: string; output?: string;
      event_id?: string; agent_thread_id?: string; agent_path?: string;
      author?: string; recipient?: string; content?: unknown;
    } };
    try { entry = JSON.parse(line); } catch { continue; }
    const p = entry.payload;
    if (!p) continue;
    if (p.type === 'function_call' && p.name === CODEX_SPAWN_FN_NAME) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(p.arguments || '{}') as Record<string, unknown>; } catch { /* ignore */ }
      spawns.push({ callId: p.call_id, args });
    } else if (p.type === CODEX_AGENT_MESSAGE_TYPE) {
      // 0.147+: the sub-agent's report. wait_agent's output no longer carries it, and
      // the live stream never mentions it, so this line is the only thing that can
      // close a Task bubble mid-turn.
      const report = parseCodexAgentMessage(p);
      if (report?.final && report.text) reports.push({ author: report.author, text: report.text });
    } else if (p.type === 'function_call_output' && p.call_id) {
      // Back-fill the sub-agent's thread id onto its spawn call. The output lands on a
      // later line (and often a later read) than the call, so this cannot be done above.
      const target = spawns.find((s) => s.callId === p.call_id && !s.agentId);
      if (target) {
        const parsed = parseCodexSpawnOutput(p.output || '');
        if (parsed) { target.agentId = parsed.agentId; target.nickname = parsed.nickname; }
      }
    } else {
      // 0.147+ back-fills the same fields from this event line instead: spawn_agent's
      // output stopped naming the thread it created (see codexTools). Without it every
      // spawn resolves by turn order alone, so two agents spawned in one turn can bind
      // to each other's call_id.
      const activity = parseCodexSubAgentActivity(p);
      if (activity) {
        const target = spawns.find((s) => s.callId === activity.callId && !s.agentId);
        if (target) {
          target.agentId = activity.agentThreadId;
          if (activity.agentPath) target.agentPath = activity.agentPath;
        }
      }
    }
  }
}

/**
 * Incremental reader over a session's rollout, for the two things the live
 * stream cannot supply.
 *
 * Sub-agents run as their OWN threads under app-server, and this connection
 * filters foreign threads out (see CodexEventShim) — so a child's final report
 * reaches us only through the file. The spawn's own arguments and the agent's
 * nickname are likewise absent from the live item.
 *
 * Reads only the bytes appended since the last call (JSONL is append-only), so
 * a long session costs O(total bytes) across a turn rather than O(bytes × calls).
 * A StringDecoder keeps multibyte characters intact across the byte boundary,
 * and a partial trailing line is carried into the next read.
 */
export function createRolloutCallReader(): (rolloutPath: string) => RolloutCalls {
  let boundPath: string | null = null;
  let offset = 0;
  let carry = '';
  let decoder = new StringDecoder('utf8');
  const spawns: RolloutSpawnCall[] = [];
  const reports: RolloutAgentReport[] = [];

  const snapshot = (): RolloutCalls => ({ spawn: spawns, reports });

  const reset = (p: string) => {
    boundPath = p; offset = 0; carry = ''; decoder = new StringDecoder('utf8');
    spawns.length = 0; reports.length = 0;
  };

  return (rolloutPath: string): RolloutCalls => {
    if (rolloutPath !== boundPath) reset(rolloutPath);
    let size = 0;
    try { size = statSync(rolloutPath).size; } catch { return snapshot(); }
    if (size < offset) reset(rolloutPath); // file truncated/rewritten → re-scan
    if (size === offset) return snapshot(); // nothing appended

    let chunk = '';
    try {
      const fd = openSync(rolloutPath, 'r');
      try {
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        const n = readSync(fd, buf, 0, len, offset);
        chunk = decoder.write(buf.subarray(0, n));
        offset += n;
      } finally { closeSync(fd); }
    } catch { return snapshot(); }

    const data = carry + chunk;
    const lastNl = data.lastIndexOf('\n');
    if (lastNl === -1) { carry = data; return snapshot(); } // no complete line yet
    carry = data.slice(lastNl + 1);
    parseCallLines(data.slice(0, lastNl), spawns, reports);
    return snapshot();
  };
}

export function resolveCodexSpawnCall(
  spawnCalls: ReadonlyArray<RolloutSpawnCall>,
  index: number,
  agentId: string | undefined,
): RolloutSpawnCall | null {
  if (agentId) {
    const exact = spawnCalls.find((s) => s.agentId === agentId);
    if (exact?.callId) return exact;
  }
  const byOrder = spawnCalls[index];
  return byOrder?.callId ? byOrder : null;
}

interface CodexEventAdapter {
  handle(event: CodexEvent): void;
  /** Point the sub-agent reader at this turn's rollout; see `bindRollout`. */
  bindRollout(path: string | null | undefined): void;
  /**
   * Count streamed assistant text toward the turn's output-token estimate.
   *
   * Under the exec transport the estimate ticked once per completed item, so
   * the "processing N" readout sat at 0 for the whole of a long answer. Text
   * now arrives as deltas, and the counter has to be fed from there or it goes
   * backwards: the completed agent_message item is deliberately dropped by the
   * shim, so nothing else would ever count the reply at all.
   */
  noteAssistantText(text: string): void;
  assertSuccess(): void;
}

function createCodexEventAdapter(ctx: RunCtx): CodexEventAdapter {
  const { sessionId } = ctx;
  let terminated = false;
  let failure: Error | null = null;
  let progressOutputTokens = 0;
  const pendingToolCalls = new Map<string, string>(); // item.id -> tool_use_id
  const progressItems = new Set<string>();

  // Rollout state, kept only for the sub-agent payload the live stream omits.
  // Tool identity does NOT come from here any more — see toolUseIdFor.
  let rolloutPath: string | null = null;
  let spawnBase = 0; // # of spawn_agent calls in the rollout before this turn
  let spawnSeen = 0; // # of distinct spawn_agent items seen this turn
  let reportBase = 0; // # of sub-agent reports in the rollout before this turn
  const agentToolUseIds = new Map<string, string>();
  const readRollout = createRolloutCallReader();

  /**
   * Everything on disk when the turn opens belongs to an earlier turn and already has
   * bubbles; the *Base counters skip it. This may ONLY be called before the model can
   * have run — codex appends each call to the rollout before executing it, so sampling
   * any later would count the very call being resolved as history and shift every
   * index by one. A fresh session needs no sample: its rollout starts empty.
   *
   * Only spawns and sub-agent reports are counted now. Tool IDS no longer come
   * from here at all (see toolUseIdFor); what remains is the sub-agent payload
   * the live stream does not carry — and the reports, which arrive on the
   * CHILD's thread and are therefore filtered out of this connection.
   */
  let basesReady = false;
  const initBases = () => {
    if (basesReady || !rolloutPath) return;
    basesReady = true;
    const c = readRollout(rolloutPath);
    spawnBase = c.spawn.length; reportBase = c.reports.length;
  };

  if (sessionId) {
    try {
      rolloutPath = findCodexSessionPath(sessionId);
      initBases();
    } catch { rolloutPath = null; }
  }

  /**
   * Point the reader at the rollout this turn will actually append to.
   *
   * `thread/start` and `thread/resume` both return the file's path, so the turn
   * can hand it over instead of searching for it. That matters twice:
   *
   *   - A resume that FALLS BACK to a fresh thread gets a new id and a new
   *     file, while this adapter was constructed against the old session's
   *     path. Without a rebind the whole turn reads the wrong file and every
   *     sub-agent bubble silently disappears.
   *   - A brand-new session has no path to find, and searching for one meant
   *     an `execSync(find …)` over ~/.codex/sessions, capped at a handful of
   *     attempts before giving up for the rest of the turn.
   */
  const bindRollout = (path: string | null | undefined): void => {
    if (!path || path === rolloutPath) return;
    rolloutPath = path;
    // A different file is a different history, so its baseline has to be
    // re-sampled — and still before the model can have run, which is why this
    // is called from the turn's setup and not from an event.
    basesReady = false;
    initBases();
  };

  /**
   * The tool id for a live item, and the whole story now that Codex runs on
   * app-server: `item.id` IS the persistent id.
   *
   * Under the old `exec` transport the live id was a per-turn ordinal
   * (`item_15`) that appeared nowhere on disk, so a snapshot keyed by it could
   * not be found again after a reload. Bridging that took a reader over the
   * growing rollout plus five "how many of these existed before this turn"
   * offsets, all of which had to be sampled before the model could run.
   *
   * app-server publishes `item/completed` with a globally unique id AND records
   * it at `event_msg/item_completed -> item.id`, so live and reloaded ids are
   * the same value read from two places. Measured across this machine's
   * sessions: exec-era rollouts contain 0 `item_completed` entries, app-server
   * ones contain every tool call. The transcript parser rebinds to the same
   * field — see `bindItemId` there.
   *
   * Note the id is NOT uniform in shape, and must not be forced to be: a
   * command or patch gets `exec-<uuid>`, while a collab tool call's item id is
   * literally its `call_id`. Taking whatever the protocol hands us is what
   * keeps sub-agent routing (`sub_agent_activity.event_id` is the spawning
   * call_id) working untouched.
   *
   * An alias, not a wrapper: this used to memoise, which was already a no-op
   * (the underlying call is pure) and would become a lie the moment it wasn't.
   */
  const toolUseIdFor = codexToolUseId;


  /** Task bubbles already emitted this turn, keyed by the spawning call_id. */
  const spawnEmitted = new Set<string>();
  /** Sub-agent path (`/root/cr_static`) → its Task bubble, for routing the report. */
  const agentPathToolUseIds = new Map<string, string>();

  const emitSpawnBubble = (
    toolUseId: string,
    input: Record<string, unknown>,
    agentPath?: string,
  ) => {
    spawnEmitted.add(toolUseId);
    if (agentPath) agentPathToolUseIds.set(agentPath, toolUseId);
    pendingToolCalls.set(toolUseId, toolUseId);
    ctx.emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.task, input }] },
    });
  };

  const emitSpawn = (item: CodexItem) => {
    const agentIds = item.receiver_thread_ids ?? [];
    const path = rolloutPath;
    const entry = path
      ? resolveCodexSpawnCall(readRollout(path).spawn, spawnBase + spawnSeen, agentIds[0])
      : null;
    spawnSeen += 1;

    // The rollout entry still supplies what the live item does not carry — the
    // spawn's own arguments, the agent's nickname and path. It no longer
    // supplies the ID: a collab tool call's `item.id` already IS its call_id,
    // so preferring an ordinal-matched entry here could only ever be wrong.
    const toolUseId = toolUseIdFor(item);
    if (spawnEmitted.has(toolUseId)) return; // syncSubAgents got there first (it reads the rollout on every event tick)
    const args = entry?.args && Object.keys(entry.args).length > 0
      ? entry.args
      : { message: item.prompt || '' };
    const input = parseCodexSpawnInput(args, {
      nickname: entry?.nickname,
      agentId: agentIds[0] || entry?.agentId,
    });
    for (const id of agentIds) agentToolUseIds.set(id, toolUseId);
    emitSpawnBubble(toolUseId, input, entry?.agentPath);
  };

  /**
   * Drive the sub-agent bubbles off the rollout.
   *
   * The live path (handleCollabItem) covers the spawn item itself, but two
   * things reach us only through the file: the spawn's `agentId`, which is
   * stamped by a later `sub_agent_activity` line, and the child's final report,
   * which is published on the CHILD's thread — filtered out of this connection
   * by design (see CodexEventShim). The two paths dedupe on the spawning
   * call_id, which both resolve to.
   *
   * Emission waits for that `agentId` so the bubble goes out once, complete: a
   * streamed tool_use cannot be amended the way the resume path mutates its
   * input. flushPending() is the backstop for a spawn that never got one.
   */
  const syncSubAgents = (flushPending = false) => {
    const path = rolloutPath;
    if (!path) return;
    const { spawn, reports } = readRollout(path);

    for (let i = spawnBase; i < spawn.length; i += 1) {
      const s = spawn[i];
      if (!s.callId || spawnEmitted.has(s.callId)) continue;
      if (!s.agentId && !flushPending) continue;
      emitSpawnBubble(
        s.callId,
        parseCodexSpawnInput(s.args, { nickname: s.nickname, agentId: s.agentId }),
        s.agentPath,
      );
      if (s.agentId) agentToolUseIds.set(s.agentId, s.callId);
    }

    // Both loops re-scan from the base rather than advancing a cursor: a report can
    // land before its spawn is emittable (no agentId yet), and must still be picked up
    // on a later pass. Re-emission is what spawnEmitted / pendingToolCalls prevent.
    for (let i = reportBase; i < reports.length; i += 1) {
      const { author, text } = reports[i];
      const toolUseId = agentPathToolUseIds.get(author);
      // Not pending → an earlier turn's agent, or the ≤ 0.14x wait already reported it.
      if (!toolUseId || !pendingToolCalls.has(toolUseId)) continue;
      ctx.emit({ type: 'user', message: { content: [{ tool_use_id: toolUseId, content: text }] } });
      pendingToolCalls.delete(toolUseId);
    }
  };

  const emitAgentReports = (item: CodexItem) => {
    for (const state of parseCodexAgentsStates(item.agents_states)) {
      if (!state.done) continue;
      const toolUseId = agentToolUseIds.get(state.agentId);
      if (!toolUseId) continue;
      ctx.emit({
        type: 'user',
        message: { content: [{ tool_use_id: toolUseId, content: codexAgentResultText(state) }] },
      });
      pendingToolCalls.delete(toolUseId);
      agentToolUseIds.delete(state.agentId);
    }
  };




  const handleCollabItem = (item: CodexItem) => {
    if (item.tool === CODEX_SPAWN_FN_NAME) { emitSpawn(item); return; }
    emitAgentReports(item);
  };

  const emitOutputProgress = (text: string, key?: string): void => {
    if (key) {
      if (progressItems.has(key)) return;
      progressItems.add(key);
    }
    progressOutputTokens += estimateOutputUnits(text);
    ctx.emit({ type: 'usage_update', output_tokens: progressOutputTokens });
  };

  const handle = (event: CodexEvent): void => {
    if (terminated) return;
    // A sub-agent's report is published on the CHILD's thread, which this
    // connection filters out, so every event doubles as a tick to pick reports
    // up off the rollout (see syncSubAgents). Cheap — the reader returns
    // immediately unless the file grew.
    if (event.type !== 'thread.started') syncSubAgents();
    switch (event.type) {
      case 'thread.started': {
        const threadId = event.thread_id || `codex-${randomUUID()}`;
        ctx.rekey(threadId);
        ctx.emit({ type: 'system', subtype: 'init', session_id: threadId });
        break;
      }
      case 'item.completed': {
        const item = event.item;
        if (!item) break;
        if (item.type === 'reasoning' && item.text) {
          emitOutputProgress(item.text);
          ctx.emit({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `<details><summary>Reasoning</summary>\n\n${item.text}\n\n</details>` }] },
          });
        }
        /**
         * One completed item, one bubble, through the SAME `codexItemBubble`
         * the transcript parser uses. That is what makes a bubble identical
         * live and after a reload: not two constructions kept in agreement,
         * but one construction read twice.
         */
        const bubble = codexItemBubble(item);
        if (bubble) {
          if (!pendingToolCalls.has(bubble.id)) {
            emitOutputProgress(bubble.input.command as string || bubble.name, `tool-start:${bubble.id}`);
            ctx.emit({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: bubble.id, name: bubble.name, input: bubble.input }] },
            });
          }
          emitOutputProgress(bubble.result, `tool-result:${bubble.id}`);
          ctx.emit({
            type: 'user',
            message: { content: [{ tool_use_id: bubble.id, content: bubble.result }] },
          });
          pendingToolCalls.delete(bubble.id);
        }
        if (item.type === 'collab_tool_call') handleCollabItem(item);
        break;
      }
      case 'item.started': {
        const item = event.item;
        /**
         * The call half of the same bubble, so it appears the moment the tool
         * starts rather than when it finishes. Derived from `codexItemBubble`
         * too — one construction, drawn twice, instead of a started-shape and a
         * completed-shape kept in agreement by hand.
         */
        if (item) {
          const started = codexItemBubble(item);
          if (started && !pendingToolCalls.has(started.id)) {
            pendingToolCalls.set(started.id, started.id);
            emitOutputProgress(started.input.command as string || started.name, `tool-start:${started.id}`);
            ctx.emit({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: started.id, name: started.name, input: started.input }] },
            });
          }
        }
        break;
      }
      case 'turn.completed': {
        // Last chance: emit any spawn whose sub_agent_activity never landed, so a
        // failed or un-bound sub-agent still leaves a bubble rather than vanishing.
        syncSubAgents(true);
        const usage = event.usage || {};
        ctx.emit({
          type: 'result',
          subtype: 'success',
          usage: {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_creation_input_tokens: usage.cache_write_input_tokens || 0,
            cache_read_input_tokens: usage.cached_input_tokens || 0,
          },
          total_cost_usd: 0,
        });
        break;
      }
      case 'turn.failed': {
        terminated = true;
        failure = new Error(event.error?.message || 'Codex turn failed');
        break;
      }
      case 'error': {
        terminated = true;
        failure = new Error(event.message || 'Codex error');
        break;
      }
      // 'turn.started' and 'item.updated' currently do not need UI changes.
    }
  };

  return {
    handle,
    bindRollout,
    noteAssistantText(text: string) {
      if (terminated) return;
      emitOutputProgress(text);
    },
    assertSuccess() {
      if (failure) throw failure;
    },
  };
}

function cleanupImageFiles(imageFiles: string[]): void {
  for (const f of imageFiles) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

/**
 * `turn/start` always takes an array of input items, and its image variant is
 * `localImage` — the app-server spelling of exec's `local_image`. The text item
 * is kept even when empty-but-for-images so the model still gets a prompt.
 */
function codexTurnInput(prompt: string, imageFiles: string[]): Array<Record<string, unknown>> {
  return [
    { type: 'text', text: imageFiles.length > 0 ? prompt || CODEX_IMAGE_ONLY_TEXT : prompt },
    ...imageFiles.map((path) => ({ type: 'localImage', path })),
  ];
}

/**
 * Thread params for `thread/start` / `thread/resume`.
 *
 * `approvalPolicy: 'never'` is load-bearing beyond permissions: it is what
 * keeps the server from ever issuing a blocking approval request, so this
 * client never has to park one and answer it later. Verified end to end — a
 * full-access turn that reads, writes and patches files sends zero
 * server-to-client requests.
 */
function codexThreadParams(ctx: RunCtx): Record<string, unknown> {
  const effort = resolveCodexReasoningEffort(ctx.params.codexReasoningEffort);
  return {
    ...(ctx.params.model ? { model: ctx.params.model } : {}),
    ...(effort ? { effort } : {}),
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  };
}

function resolveCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
    case 'ultra':
      return value;
    default:
      return undefined;
  }
}

/** How long a stop waits on the server before falling back to killing it. */
const INTERRUPT_TIMEOUT_MS = 3_000;

/**
 * Stop every turn this connection has in flight, children before the parent.
 *
 * Killing the process stops them too — that is the fallback, and what this used
 * to do on its own. The difference is what the transcript ends up saying: a
 * killed sub-agent's rollout simply stops mid-write, with no terminal record,
 * which is what a stopped session looks like when it is later reopened. Asking
 * first gives each turn a real `interrupted` terminal.
 *
 * Children first because a parent's interrupt does NOT cascade — measured: the
 * parent reported `interrupted` in 0.1s while its two sub-agents kept working
 * for the twelve seconds the probe watched.
 *
 * Bounded and best-effort throughout: a stop that hangs is worse than a stop
 * that is abrupt, and the caller kills the process immediately afterwards.
 */
async function interruptTurns(client: CodexAppServerClient, shim: CodexEventShim): Promise<void> {
  const turns = shim.activeTurns();
  if (turns.length === 0) return;
  await Promise.race([
    Promise.allSettled(
      turns.map((t) => client.request('turn/interrupt', { threadId: t.threadId, turnId: t.turnId }))
    ),
    new Promise((resolve) => setTimeout(resolve, INTERRUPT_TIMEOUT_MS)),
  ]);
}

/**
 * Run one turn against `codex app-server`.
 *
 * Replaces the `@openai/codex-sdk` path, whose API speaks only
 * `exec --experimental-json` — a transport that emits assistant text once, as a
 * finished `item.completed`, with no incremental events on the wire at any
 * setting. That is why a Codex reply used to appear as one block while every
 * other engine typed. app-server publishes `item/agentMessage/delta`, and those
 * deltas are forwarded in Claude's `content_block_delta` shape so the client
 * needs no Codex-specific handling to render them.
 *
 * Everything else is deliberately unchanged: notifications are rewritten into
 * the exec event shape and handed to the same adapter, so tool bubbles,
 * sub-agents, todos and diffs keep their existing behaviour.
 */
async function runCodexAppServer(ctx: RunCtx): Promise<void> {
  const imageFiles = ctx.images && ctx.images.length > 0 ? writeImagesToTemp(ctx.images) : [];
  const adapter = createCodexEventAdapter(ctx);
  const shim = new CodexEventShim();

  let terminal: 'completed' | 'failed' | null = null;
  let settle: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const onNotification = (n: CodexNotification): void => {
    for (const out of shim.handle(n)) {
      if (out.kind === 'text-delta') {
        adapter.noteAssistantText(out.text);
        ctx.emit({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: out.text } },
        });
        continue;
      }
      adapter.handle(out.event as CodexEvent);
      if (out.event.type === 'turn.completed') terminal = 'completed';
      if (out.event.type === 'turn.failed') terminal = 'failed';
    }
    if (terminal) settle?.();
  };

  /**
   * How the transport died, if it did. Once `turn/start` has resolved there is
   * no pending request left for a rejection to travel on, so without this a
   * crashed or killed child leaves the turn waiting forever on a notification
   * that can never arrive.
   */
  let closedReason: Error | null = null;

  let client: CodexAppServerClient;
  try {
    client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
      onNotification,
      // Permitted `console.error` under EFFECT.md §0 (subprocess IPC adapter gateway).
      onStderr: (line) => console.error(`[codex app-server] ${line}`),
      onClosed: (err) => {
        closedReason = err;
        settle?.();
      },
    });
  } catch (error) {
    // Resolving the binary throws when the platform package is missing, which is
    // the likeliest startup failure of all — and it happens before the try below,
    // so the images written above would leak on exactly that path.
    cleanupImageFiles(imageFiles);
    throw error;
  }

  try {
    await client.request('initialize', {
      clientInfo: { name: 'cockpit', title: 'Cockpit', version: '1' },
      capabilities: { experimentalApi: true },
    });
    // Params-less, and it must land before any thread/* call.
    client.notify('initialized');

    const params = codexThreadParams(ctx);
    /**
     * A stale thread id is recoverable: the session may have been archived, its
     * rollout removed out from under us, or — measured, and by far the most
     * common — another Codex client (the ChatGPT desktop app opens the same
     * `~/.codex/sessions` store) holds the thread's writer lock, which the
     * server rejects with `thread-store conflict: … already has an active
     * writer`. Starting fresh loses the history but keeps the turn, which is
     * strictly better than failing the send.
     *
     * It is NOT silent, though. The fallback changes the session id under the
     * user, and that id change is what makes the tab bar grow a second tab for
     * the same conversation — so without a word from here the only thing the
     * user sees is a tab appearing out of nowhere and a model that has
     * forgotten everything. The reason is logged AND reported into the
     * transcript as a system notice (see the ctx.emit below).
     */
    let opened: Record<string, unknown>;
    let resumeFailure: string | null = null;
    if (ctx.sessionId) {
      try {
        opened = await client.request('thread/resume', { threadId: ctx.sessionId, ...params });
      } catch (error) {
        resumeFailure = error instanceof Error ? error.message : String(error);
        // Permitted `console.error` under EFFECT.md §0 (subprocess IPC adapter gateway).
        console.error(
          `[codex app-server] thread/resume failed for ${ctx.sessionId} — starting a fresh thread (history not carried over): ${resumeFailure}`
        );
        opened = await client.request('thread/start', params);
      }
    } else {
      opened = await client.request('thread/start', params);
    }

    const thread = opened.thread as { id?: string; path?: string | null } | undefined;
    const threadId = thread?.id;
    if (!threadId) throw new Error('codex app-server returned no thread id');
    // The protocol hands back the rollout's path, so the sub-agent reader never
    // has to go looking for it — and a resume that fell back to a fresh thread
    // gets pointed at the new file instead of the old session's.
    adapter.bindRollout(thread?.path);
    // Everything on the connection that is not this thread belongs to a
    // sub-agent; see the guard in CodexEventShim.handle.
    shim.bindThread(threadId);

    /**
     * Synthesised rather than taken from the `thread/started` notification, and
     * the timing is the reason: this is what samples the rollout's per-turn
     * baseline counters, which is only correct BEFORE the model can have run.
     * A request result is ordered against `turn/start`; a notification is not.
     */
    adapter.handle({ type: 'thread.started', thread_id: threadId });

    /**
     * Emitted AFTER `thread.started` so the rekey has already happened: the
     * notice then lands on the run under its new id, which is the one the tab
     * is about to be bound to. The client renders it as a muted system row
     * (subtype `notice` → systemEvent kind 'meta'); the raw server message is
     * carried in `error` for the detail modal, untranslated on purpose.
     */
    if (resumeFailure) {
      ctx.emit({
        type: 'system',
        subtype: 'notice',
        notice: 'codex_resume_failed',
        previous_session_id: ctx.sessionId,
        session_id: threadId,
        error: resumeFailure,
      });
    }

    const startedTurn = await client.request('turn/start', {
      threadId,
      input: codexTurnInput(ctx.prompt ?? '', imageFiles),
    });
    // Needed to stop this turn by name later; see `interruptTurns`.
    const turnId = (startedTurn.turn as { id?: string } | undefined)?.id;
    if (turnId) shim.noteOwnTurn(threadId, turnId);

    // `turn/start` returns as soon as the turn is accepted; the turn itself ends
    // on a notification, on the transport dying (`onClosed` settles the same
    // promise), or on an abort. Abort resolves rather than throws, so a stopped
    // run tears the child down instead of being reported as a failure.
    await Promise.race([
      finished,
      new Promise<void>((resolve) => {
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);

    if (ctx.signal.aborted) await interruptTurns(client, shim);

    adapter.assertSuccess();
    // The child went away mid-turn and the user did not ask for it. Reported
    // last so a real engine error (which the adapter already holds) wins the
    // race to explain what happened.
    if (closedReason && !ctx.signal.aborted && !terminal) throw closedReason;
  } finally {
    client.dispose();
    cleanupImageFiles(imageFiles);
  }
}

export const codexSpec: EngineSpec = {
  name: 'codex',
  // No preflight: the orchestrator's own "prompt or images" check is sufficient.
  runner: {
    async run(ctx: RunCtx) {
      if (ctx.params.noHistory !== true || !ctx.sessionId) {
        await runCodexAppServer(ctx);
        return;
      }

      const sessionPath = findCodexSessionPath(ctx.sessionId);
      const stashed = sessionPath ? stashCodexRollout(sessionPath) : false;
      try {
        await runCodexAppServer(ctx);
      } finally {
        if (stashed && sessionPath) mergeStashedCodexRollout(sessionPath);
      }
    },
    // No resolveTitle -> teardown 'unread' with undefined title (matches original).
  },
};
