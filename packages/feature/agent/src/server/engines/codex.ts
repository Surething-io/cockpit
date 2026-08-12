import type { Input, ModelReasoningEffort, ThreadOptions } from '@openai/codex-sdk';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import { sanitizedSpawnEnv, findCodexSessionPath } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EngineSpec, ImageData, RunCtx } from './types';
import { mergeStashedCodexRollout, stashCodexRollout } from './shared/noHistoryRollout';
import {
  CODEX_MCP_NAMESPACE_PREFIX,
  CODEX_EXEC_SCRIPT_FN_NAME,
  CODEX_IMAGE_ONLY_TEXT,
  CODEX_PATCH_FN_NAME,
  CODEX_SPAWN_FN_NAME,
  CODEX_TOOL_NAMES,
  codexAgentResultText,
  codexMcpResultText,
  codexMcpToolName,
  codexTodoInput,
  codexTodoResultText,
  codexWebSearchCall,
  parseCodexAgentsStates,
  parseCodexExecScript,
  parseCodexSpawnInput,
  parseCodexSpawnOutput,
  parseCodexSubAgentActivity,
} from '../api/session/codexTools';

// Codex SDK event adapter. Translates Codex JSON events into the same event shapes the
// other engines emit.
type CodexReasoningEffort = ModelReasoningEffort | 'max' | 'ultra';

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
  // --- collab_tool_call (multi-agent) fields, verified against codex 0.141 ---
  /** 'spawn_agent' | 'wait' | 'close_agent' | 'send_input' | 'resume_agent' */
  tool?: string;
  sender_thread_id?: string;
  /** Sub-agent thread ids. EMPTY on a spawn's item.started — only item.completed has it. */
  receiver_thread_ids?: string[];
  prompt?: string | null;
  /** Live per-agent state. Note: a DIFFERENT encoding from the rollout's wait output. */
  agents_states?: Record<string, { status?: string; message?: string | null }>;
  // --- mcp_tool_call ---
  server?: string;
  /** `tool` is shared with collab_tool_call; disambiguated by `item.type`. */
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string } | null;
  // --- web_search --- (`id` is a stable `ws_…`, matching the rollout's call_id)
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

const CODEX_EXEC_FN_NAMES = new Set(['exec_command', 'shell_command', 'local_shell']);

export interface RolloutExecCall { callId?: string; cmd: string }
export interface RolloutPatchCall { callId?: string; files: string[] }
/**
 * A `spawn_agent` call. `agentId`/`nickname` are only known once codex appends the
 * paired `function_call_output`, so they arrive on a later read than `callId`.
 */
export interface RolloutSpawnCall {
  callId?: string;
  args: Record<string, unknown>;
  agentId?: string;
  nickname?: string;
  /** 0.147+: the sub-agent's path (`/root/cr_static`); no nickname is published here. */
  agentPath?: string;
}
/** An MCP call. Persisted as an ordinary function_call under an `mcp__<server>` namespace. */
export interface RolloutMcpCall { callId?: string; server: string; tool: string }
export interface RolloutCalls {
  exec: ReadonlyArray<RolloutExecCall>;
  patch: ReadonlyArray<RolloutPatchCall>;
  spawn: ReadonlyArray<RolloutSpawnCall>;
  mcp: ReadonlyArray<RolloutMcpCall>;
}

/** Extract the target file paths from an apply_patch body (`*** Update File: <path>`). */
export function parsePatchFiles(input: string): string[] {
  const files: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) files.push(m[1].trim());
  return files;
}

/** Parse exec_command, apply_patch, spawn_agent and MCP calls out of complete JSONL lines. */
function parseCallLines(
  text: string,
  exec: RolloutExecCall[],
  patch: RolloutPatchCall[],
  spawns: RolloutSpawnCall[],
  mcps: RolloutMcpCall[],
): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { payload?: {
      type?: string; name?: string; namespace?: string; call_id?: string;
      arguments?: string; input?: string; output?: string;
      event_id?: string; agent_thread_id?: string; agent_path?: string;
    } };
    try { entry = JSON.parse(line); } catch { continue; }
    const p = entry.payload;
    if (!p) continue;
    if (p.type === 'function_call' && p.name && CODEX_EXEC_FN_NAMES.has(p.name)) {
      let cmd = '';
      try { cmd = String((JSON.parse(p.arguments || '{}') as { cmd?: string }).cmd || ''); } catch { /* ignore */ }
      exec.push({ callId: p.call_id, cmd });
    } else if (p.type === 'custom_tool_call' && p.name === CODEX_PATCH_FN_NAME) {
      patch.push({ callId: p.call_id, files: parsePatchFiles(p.input || '') });
    } else if (p.type === 'custom_tool_call' && p.name === CODEX_EXEC_SCRIPT_FN_NAME) {
      // 5.6+: one freeform tool for everything, so which list this belongs to is
      // decided by the script body. An unclassifiable script is deliberately dropped
      // rather than guessed into a list — a wrong entry would shift every later
      // index and bind the next live item to the wrong call_id.
      const script = parseCodexExecScript(p.input || '');
      if (script.kind === 'exec') exec.push({ callId: p.call_id, cmd: script.command });
      else if (script.kind === 'patch') patch.push({ callId: p.call_id, files: parsePatchFiles(script.patch) });
    } else if (p.type === 'function_call' && p.name && p.namespace?.startsWith(CODEX_MCP_NAMESPACE_PREFIX)) {
      mcps.push({
        callId: p.call_id,
        server: p.namespace.slice(CODEX_MCP_NAMESPACE_PREFIX.length),
        tool: p.name,
      });
    } else if (p.type === 'function_call' && p.name === CODEX_SPAWN_FN_NAME) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(p.arguments || '{}') as Record<string, unknown>; } catch { /* ignore */ }
      spawns.push({ callId: p.call_id, args });
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
 * The live `codex exec --json` stream tags items with an ephemeral per-turn
 * `item.id` (item_0, item_1, ...) and carries NO `call_id`. The persisted rollout
 * JSONL instead stores each call under a stable, session-global `call_id`, which
 * is what the resume path (session-by-path.ts) uses to key tool calls. Recording
 * snapshots under `item.id` therefore breaks the FileDiff entry after a refresh.
 *
 * Codex writes the call (with its call_id) to the rollout before executing, so by
 * the time we see the live item the entry already exists. This factory returns a
 * reader that maps the growing rollout to its ordered exec list (shell commands,
 * live `command_execution`), patch list (apply_patch edits, live `file_change`) and
 * spawn list (sub-agents, live `collab_tool_call`)
 * — reading only the bytes appended since the last call (JSONL is append-only),
 * so a long session costs O(total bytes) across a turn, not O(bytes × calls). A
 * StringDecoder keeps multibyte chars intact across the byte boundary; a partial
 * trailing line is carried to the next read.
 */
export function createRolloutCallReader(): (rolloutPath: string) => RolloutCalls {
  let boundPath: string | null = null;
  let offset = 0;
  let carry = '';
  let decoder = new StringDecoder('utf8');
  const exec: RolloutExecCall[] = [];
  const patch: RolloutPatchCall[] = [];
  const spawns: RolloutSpawnCall[] = [];
  const mcps: RolloutMcpCall[] = [];

  const reset = (p: string) => {
    boundPath = p; offset = 0; carry = ''; decoder = new StringDecoder('utf8');
    exec.length = 0; patch.length = 0; spawns.length = 0; mcps.length = 0;
  };

  return (rolloutPath: string): RolloutCalls => {
    if (rolloutPath !== boundPath) reset(rolloutPath);
    let size = 0;
    try { size = statSync(rolloutPath).size; } catch { return { exec, patch, spawn: spawns, mcp: mcps }; }
    if (size < offset) reset(rolloutPath); // file truncated/rewritten → re-scan
    if (size === offset) return { exec, patch, spawn: spawns, mcp: mcps }; // nothing appended

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
    } catch { return { exec, patch, spawn: spawns, mcp: mcps }; }

    const data = carry + chunk;
    const lastNl = data.lastIndexOf('\n');
    if (lastNl === -1) { carry = data; return { exec, patch, spawn: spawns, mcp: mcps }; } // no complete line yet
    carry = data.slice(lastNl + 1);
    parseCallLines(data.slice(0, lastNl), exec, patch, spawns, mcps);
    return { exec, patch, spawn: spawns, mcp: mcps };
  };
}

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || p;

/**
 * Unwrap codex's `/bin/zsh -lc '<cmd>'` shell wrapper to the raw command for comparison.
 * Codex switches the wrapper quote to double when the inner command contains a single
 * quote (e.g. `sed -n '1,3p'`), so both quote styles must be handled.
 */
function unwrapShellCommand(command: string): string {
  const m = command.match(/^\/bin\/\S+ -lc (['"])([\s\S]*)\1\s*$/);
  return m ? m[2] : command;
}

function normalizeCmd(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Resolve the persistent call_id for the `index`-th exec call of a turn from the
 * ordered rollout exec list, guarding with a command match. Returns null to signal
 * "fall back to item.id" (missing entry, no call_id, or command desync).
 */
// Max extra length a shell wrapper adds around the inner command, e.g.
// `/bin/zsh -lc "<cmd>"` (~16 chars; leave slack for longer shell paths). The
// includes() fallback only fires within this bound so a short command can't be
// spuriously matched as a substring of an unrelated, much longer command.
const SHELL_WRAPPER_SLACK = 32;

export function resolveCodexCallId(
  execCalls: ReadonlyArray<RolloutExecCall>,
  index: number,
  liveCommand: string,
): string | null {
  const target = execCalls[index];
  if (!target?.callId) return null;
  const persisted = normalizeCmd(target.cmd);
  const live = normalizeCmd(unwrapShellCommand(liveCommand || ''));
  const liveRaw = normalizeCmd(liveCommand || '');
  // Order within a turn is 1:1; the command match guards against desync (rollout not
  // yet flushed, offset drift). Prefix checks tolerate either side being truncated;
  // the last clause covers any shell wrapper we failed to strip (rollout stores the
  // raw inner command, a substring of the wrapped live command) but is length-bounded
  // to SHELL_WRAPPER_SLACK so it only accepts a genuine wrapper, not a coincidental
  // substring under desync.
  if (
    !live ||
    live === persisted ||
    persisted.startsWith(live) ||
    live.startsWith(persisted) ||
    (!!persisted && liveRaw.includes(persisted) && liveRaw.length - persisted.length <= SHELL_WRAPPER_SLACK)
  ) {
    return target.callId;
  }
  return null;
}

/**
 * Resolve the persistent call_id for the `index`-th apply_patch of a turn from the
 * ordered rollout patch list, guarding with a file-path match (live file_change gives
 * absolute paths; the rollout patch references cwd-relative paths, so compare by
 * basename). Returns null → "fall back to item.id".
 */
export function resolveCodexPatchCallId(
  patchCalls: ReadonlyArray<RolloutPatchCall>,
  index: number,
  changePaths: ReadonlyArray<string>,
): string | null {
  const target = patchCalls[index];
  if (!target?.callId) return null;
  if (target.files.length === 0 || changePaths.length === 0) return target.callId; // nothing to cross-check → trust order
  const wanted = new Set(target.files.map(basename));
  if (changePaths.some((p) => wanted.has(basename(p)))) return target.callId;
  return null;
}

/**
 * Resolve the persistent call_id for a live `spawn_agent`, preferring an exact match
 * on the sub-agent's thread id (the live item carries it in `receiver_thread_ids`,
 * the rollout in the spawn call's output) and falling back to turn order when codex
 * has not flushed that output yet. Returns the matching rollout entry so the caller
 * can also reuse its arguments/nickname, or null → "fall back to item.id".
 */
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

/**
 * Resolve the persistent call_id for the `index`-th MCP call of a turn, guarded by
 * server+tool so an offset drift falls back to item.id rather than binding the wrong
 * call. MCP tools are unknown names, so `isMutatingToolName` treats them as mutating
 * and they DO get snapshots — which is why their ids have to survive a refresh.
 */
export function resolveCodexMcpCallId(
  mcpCalls: ReadonlyArray<RolloutMcpCall>,
  index: number,
  server: string | undefined,
  tool: string | undefined,
): string | null {
  const target = mcpCalls[index];
  if (!target?.callId) return null;
  if (server && tool && (target.server !== server || target.tool !== tool)) return null;
  return target.callId;
}

interface CodexEventAdapter {
  handle(event: CodexEvent): void;
  assertSuccess(): void;
}

function createCodexEventAdapter(ctx: RunCtx): CodexEventAdapter {
  const { sessionId } = ctx;
  let terminated = false;
  let failure: Error | null = null;
  let progressOutputTokens = 0;
  const pendingToolCalls = new Map<string, string>(); // item.id -> tool_use_id
  const progressItems = new Set<string>();

  // Map live items to their persistent rollout call_id so snapshots survive a
  // refresh (see createRolloutCallReader). command_execution <-> exec list and
  // file_change (apply_patch) <-> patch list are matched independently, each by
  // its own per-turn order. Resolved lazily, cached per item.id; falls back to
  // codexToolUseId (item.id) on any mismatch.
  let rolloutPath: string | null = null;
  let execBase = 0;  // # of exec calls in the rollout before this turn (resume offset)
  let patchBase = 0; // # of apply_patch calls in the rollout before this turn
  let execSeen = 0;  // # of distinct command_execution items seen this turn
  let patchSeen = 0; // # of distinct file_change items seen this turn
  let spawnBase = 0; // # of spawn_agent calls in the rollout before this turn
  let spawnSeen = 0; // # of distinct spawn_agent items seen this turn
  let mcpBase = 0;   // # of MCP calls in the rollout before this turn
  let mcpSeen = 0;   // # of distinct mcp_tool_call items seen this turn
  const agentToolUseIds = new Map<string, string>();
  let codexThreadId: string | null = sessionId || null;
  let rolloutLookups = 0;
  const MAX_ROLLOUT_LOOKUPS = 8;
  const resolvedToolUseIds = new Map<string, string>();
  const readRollout = createRolloutCallReader();

  if (sessionId) {
    try {
      rolloutPath = findCodexSessionPath(sessionId);
      if (rolloutPath) {
        const c = readRollout(rolloutPath);
        execBase = c.exec.length; patchBase = c.patch.length; spawnBase = c.spawn.length; mcpBase = c.mcp.length;
      }
    } catch { rolloutPath = null; execBase = 0; patchBase = 0; spawnBase = 0; mcpBase = 0; }
  }

  const ensureRolloutPath = (): string | null => {
    if (rolloutPath || !codexThreadId || rolloutLookups >= MAX_ROLLOUT_LOOKUPS) return rolloutPath;
    rolloutLookups += 1;
    try { rolloutPath = findCodexSessionPath(codexThreadId); } catch { rolloutPath = null; }
    return rolloutPath;
  };

  const resolveExecToolUseId = (item: CodexItem): string => {
    const key = item.id || item.call_id || `codex-${randomUUID()}`;
    const cached = resolvedToolUseIds.get(key);
    if (cached) return cached;

    let toolUseId = codexToolUseId(item);
    const path = ensureRolloutPath();
    if (!item.call_id && path) {
      const callId = resolveCodexCallId(readRollout(path).exec, execBase + execSeen, item.command || '');
      if (callId) toolUseId = callId;
    }
    resolvedToolUseIds.set(key, toolUseId);
    execSeen += 1;
    return toolUseId;
  };

  const resolvePatchToolUseId = (item: CodexItem): string => {
    const key = item.id || item.call_id || `codex-${randomUUID()}`;
    const cached = resolvedToolUseIds.get(key);
    if (cached) return cached;

    let toolUseId = codexToolUseId(item);
    const path = ensureRolloutPath();
    if (!item.call_id && path) {
      const paths = (item.changes || []).map((c) => c.path || '').filter(Boolean);
      const callId = resolveCodexPatchCallId(readRollout(path).patch, patchBase + patchSeen, paths);
      if (callId) toolUseId = callId;
    }
    resolvedToolUseIds.set(key, toolUseId);
    patchSeen += 1;
    return toolUseId;
  };

  const patchInput = (item: CodexItem) => ({
    changes: (item.changes || []).map((c) => ({ path: c.path || '', kind: c.kind || 'update' })),
  });
  const patchResultText = (item: CodexItem): string => {
    const cs = item.changes || [];
    if (cs.length === 0) return 'apply_patch';
    return cs.map((c) => `${c.kind || 'update'} ${c.path || ''}`.trim()).join('\n');
  };

  const emitSpawn = (item: CodexItem) => {
    const agentIds = item.receiver_thread_ids ?? [];
    const path = ensureRolloutPath();
    const entry = path
      ? resolveCodexSpawnCall(readRollout(path).spawn, spawnBase + spawnSeen, agentIds[0])
      : null;
    spawnSeen += 1;

    const toolUseId = entry?.callId || codexToolUseId(item);
    const args = entry?.args && Object.keys(entry.args).length > 0
      ? entry.args
      : { message: item.prompt || '' };
    const input = parseCodexSpawnInput(args, {
      nickname: entry?.nickname,
      agentId: agentIds[0] || entry?.agentId,
    });
    for (const id of agentIds) agentToolUseIds.set(id, toolUseId);
    pendingToolCalls.set(toolUseId, toolUseId);
    ctx.emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.task, input }] },
    });
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

  const resolveMcpToolUseId = (item: CodexItem): string => {
    const key = item.id || `codex-${randomUUID()}`;
    const cached = resolvedToolUseIds.get(key);
    if (cached) return cached;

    let toolUseId = codexToolUseId(item);
    const path = ensureRolloutPath();
    if (!item.call_id && path) {
      const callId = resolveCodexMcpCallId(readRollout(path).mcp, mcpBase + mcpSeen, item.server, item.tool);
      if (callId) toolUseId = callId;
    }
    resolvedToolUseIds.set(key, toolUseId);
    mcpSeen += 1;
    return toolUseId;
  };

  const emitMcpCall = (item: CodexItem, done: boolean) => {
    const toolUseId = resolveMcpToolUseId(item);
    const name = codexMcpToolName(item.server || 'mcp', item.tool || 'tool');
    if (!pendingToolCalls.has(toolUseId)) {
      pendingToolCalls.set(toolUseId, toolUseId);
      ctx.emit({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: toolUseId, name, input: item.arguments || {} }] },
      });
    }
    if (!done) return;
    ctx.emit({
      type: 'user',
      message: { content: [{ tool_use_id: toolUseId, content: codexMcpResultText(item) || `(${item.status || 'completed'})` }] },
    });
    pendingToolCalls.delete(toolUseId);
  };

  const emitWebSearch = (item: CodexItem) => {
    const toolUseId = codexToolUseId(item);
    const { name, input, result } = codexWebSearchCall(item.query, item.action);
    ctx.emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolUseId, name, input }] },
    });
    ctx.emit({ type: 'user', message: { content: [{ tool_use_id: toolUseId, content: result }] } });
  };

  const emitTodoList = (item: CodexItem) => {
    const toolUseId = codexToolUseId(item);
    const input = codexTodoInput(item.items);
    ctx.emit({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.todo, input }] },
    });
    ctx.emit({
      type: 'user',
      message: { content: [{ tool_use_id: toolUseId, content: codexTodoResultText(input.todos) }] },
    });
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
    switch (event.type) {
      case 'thread.started': {
        const threadId = event.thread_id || `codex-${randomUUID()}`;
        if (event.thread_id) codexThreadId = event.thread_id;
        ctx.rekey(threadId);
        ctx.emit({ type: 'system', subtype: 'init', session_id: threadId });
        ensureRolloutPath();
        break;
      }
      case 'item.completed': {
        const item = event.item;
        if (!item) break;
        if (item.type === 'agent_message' && item.text) {
          emitOutputProgress(item.text);
          ctx.emit({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
        }
        if (item.type === 'error' && (item.message || item.text)) {
          emitOutputProgress(item.message || item.text || '');
          ctx.emit({ type: 'error', error: item.message || item.text });
        }
        if (item.type === 'reasoning' && item.text) {
          emitOutputProgress(item.text);
          ctx.emit({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `<details><summary>Reasoning</summary>\n\n${item.text}\n\n</details>` }] },
          });
        }
        if (item.type === 'command_execution') {
          const toolUseId = resolveExecToolUseId(item);
          if (!pendingToolCalls.has(toolUseId)) {
            emitOutputProgress(item.command || CODEX_TOOL_NAMES.bash, `command-start:${toolUseId}`);
            ctx.emit({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.bash, input: { command: item.command || '' } }] },
            });
          }
          emitOutputProgress(item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})`, `command-result:${toolUseId}`);
          ctx.emit({
            type: 'user',
            message: { content: [{ tool_use_id: toolUseId, content: item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})` }] },
          });
          pendingToolCalls.delete(toolUseId);
        }
        if (item.type === 'collab_tool_call') handleCollabItem(item);
        if (item.type === 'mcp_tool_call') {
          emitOutputProgress(`${item.server || 'mcp'} ${item.tool || ''} ${JSON.stringify(item.result ?? item.error ?? '')}`);
          emitMcpCall(item, true);
        }
        if (item.type === 'web_search') {
          emitOutputProgress(JSON.stringify(item.action || item.query || 'web_search'));
          emitWebSearch(item);
        }
        if (item.type === 'todo_list') {
          emitOutputProgress(JSON.stringify(item.items || []));
          emitTodoList(item);
        }
        if (item.type === 'file_change') {
          const toolUseId = resolvePatchToolUseId(item);
          if (!pendingToolCalls.has(toolUseId)) {
            emitOutputProgress(patchResultText(item), `patch-start:${toolUseId}`);
            ctx.emit({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.applyPatch, input: patchInput(item) }] },
            });
          }
          emitOutputProgress(patchResultText(item), `patch-result:${toolUseId}`);
          ctx.emit({
            type: 'user',
            message: { content: [{ tool_use_id: toolUseId, content: patchResultText(item) }] },
          });
          pendingToolCalls.delete(toolUseId);
        }
        break;
      }
      case 'item.started': {
        const item = event.item;
        if (item?.type === 'mcp_tool_call') emitMcpCall(item, false);
        if (item?.type === 'command_execution' && item.command) {
          const toolUseId = resolveExecToolUseId(item);
          pendingToolCalls.set(toolUseId, toolUseId);
          emitOutputProgress(item.command, `command-start:${toolUseId}`);
          ctx.emit({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.bash, input: { command: item.command } }] },
          });
        }
        if (item?.type === 'file_change' && (item.changes?.length ?? 0) > 0) {
          const toolUseId = resolvePatchToolUseId(item);
          pendingToolCalls.set(toolUseId, toolUseId);
          emitOutputProgress(patchResultText(item), `patch-start:${toolUseId}`);
          ctx.emit({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.applyPatch, input: patchInput(item) }] },
          });
        }
        break;
      }
      case 'turn.completed': {
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

function codexSdkInput(prompt: string, imageFiles: string[]): Input {
  if (imageFiles.length === 0) return prompt;
  return [
    { type: 'text', text: prompt || CODEX_IMAGE_ONLY_TEXT },
    ...imageFiles.map((path) => ({ type: 'local_image' as const, path })),
  ];
}

function codexThreadOptions(ctx: RunCtx): ThreadOptions {
  const effort = resolveCodexReasoningEffort(ctx.params.codexReasoningEffort);
  return {
    ...(ctx.params.model ? { model: ctx.params.model } : {}),
    ...(effort ? { modelReasoningEffort: effort as ModelReasoningEffort } : {}),
    ...(ctx.cwd ? { workingDirectory: ctx.cwd } : {}),
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
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

async function runCodexSdk(ctx: RunCtx): Promise<void> {
  const imageFiles = ctx.images && ctx.images.length > 0 ? writeImagesToTemp(ctx.images) : [];
  const adapter = createCodexEventAdapter(ctx);
  try {
    const { Codex } = await import('@openai/codex-sdk');
    const env = sanitizedSpawnEnv({});
    let codex: InstanceType<typeof Codex>;
    try {
      codex = new Codex({ env });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('Unable to locate Codex CLI binaries')) throw error;
      codex = new Codex({ codexPathOverride: 'codex', env });
    }
    const thread = ctx.sessionId
      ? codex.resumeThread(ctx.sessionId, codexThreadOptions(ctx))
      : codex.startThread(codexThreadOptions(ctx));
    const { events } = await thread.runStreamed(codexSdkInput(ctx.prompt ?? '', imageFiles), { signal: ctx.signal });
    for await (const event of events) adapter.handle(event as CodexEvent);
    adapter.assertSuccess();
  } finally {
    cleanupImageFiles(imageFiles);
  }
}

export const codexSpec: EngineSpec = {
  name: 'codex',
  // No preflight: the orchestrator's own "prompt or images" check is sufficient.
  runner: {
    async run(ctx: RunCtx) {
      if (ctx.params.noHistory !== true || !ctx.sessionId) {
        await runCodexSdk(ctx);
        return;
      }

      const sessionPath = findCodexSessionPath(ctx.sessionId);
      const stashed = sessionPath ? stashCodexRollout(sessionPath) : false;
      try {
        await runCodexSdk(ctx);
      } finally {
        if (stashed && sessionPath) mergeStashedCodexRollout(sessionPath);
      }
    },
    // No resolveTitle -> teardown 'unread' with undefined title (matches original).
  },
};
