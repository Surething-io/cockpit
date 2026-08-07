import { spawn } from 'child_process';
import { sanitizedSpawnEnv, findCodexSessionPath } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EngineSpec, ImageData, RunCtx } from './types';
import {
  CODEX_MCP_NAMESPACE_PREFIX,
  CODEX_SPAWN_FN_NAME,
  CODEX_TOOL_NAMES,
  codexAgentResultText,
  codexMcpResultText,
  codexMcpToolName,
  codexTodoInput,
  codexTodoResultText,
  codexWebSearchCall,
  parseCodexAgentsStates,
  parseCodexSpawnInput,
  parseCodexSpawnOutput,
} from '../api/session/codexTools';

// Codex CLI JSONL → event adapter. Spawns `codex exec --json` and translates its JSONL stdout
// into the same event shapes the other engines emit.

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
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
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
    let entry: { payload?: { type?: string; name?: string; namespace?: string; call_id?: string; arguments?: string; input?: string; output?: string } };
    try { entry = JSON.parse(line); } catch { continue; }
    const p = entry.payload;
    if (!p) continue;
    if (p.type === 'function_call' && p.name && CODEX_EXEC_FN_NAMES.has(p.name)) {
      let cmd = '';
      try { cmd = String((JSON.parse(p.arguments || '{}') as { cmd?: string }).cmd || ''); } catch { /* ignore */ }
      exec.push({ callId: p.call_id, cmd });
    } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      patch.push({ callId: p.call_id, files: parsePatchFiles(p.input || '') });
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

export const codexSpec: EngineSpec = {
  name: 'codex',
  // No preflight: the orchestrator's own "prompt or images" check is sufficient. This used to
  // require a text prompt because an images-only message would push `undefined` as the positional
  // arg; it now passes '' instead, which codex accepts — verified end-to-end that `codex exec
  // --image <file> -- ""` reads the image and answers, on both the fresh and resume branches.
  runner: {
    run(ctx: RunCtx) {
      const { cwd, sessionId } = ctx;
      // Images-only turns have no text. '' is a valid positional (and, thanks to the `--`
      // separator below, is never mistaken for a missing arg → no stdin fallback).
      const prompt = ctx.prompt ?? '';
      const imageFiles = ctx.images && ctx.images.length > 0 ? writeImagesToTemp(ctx.images) : [];

      return new Promise<void>((resolve, reject) => {
        let terminated = false;
        let failure: Error | null = null;
        const cleanup = () => {
          for (const f of imageFiles) {
            try { unlinkSync(f); } catch { /* ignore */ }
          }
        };

        // codex-cli >=0.141: --full-auto deprecated; --sandbox workspace-write still blocks writes
        // outside the workspace root, so use --dangerously-bypass-approvals-and-sandbox instead.
        // Cockpit already runs the agent with the user's own privileges. A non-trusted dir needs
        // --skip-git-repo-check. `resume` is exec-only (no -C). Prompt positional.
        //
        // The prompt MUST be separated by `--`: on `codex exec` the image flag is declared
        // variadic (`-i, --image <FILE>...`), so `--image a.png "my prompt"` greedily swallows
        // the prompt as a second image path. Codex then falls back to reading the prompt from
        // stdin, which is 'ignore' here, and dies with "No prompt provided via stdin" (exit 1).
        // `--` ends option parsing so the prompt always lands on the positional. (`codex exec
        // resume` declares --image non-variadic, but `--` is harmless there and keeps both
        // branches immune if that ever changes.)
        const args: string[] = ['exec'];
        if (sessionId) {
          args.push(
            'resume',
            sessionId,
            '--json',
            '--dangerously-bypass-approvals-and-sandbox',
            '--skip-git-repo-check',
          );
          for (const imgPath of imageFiles) args.push('--image', imgPath);
          args.push('--', prompt);
        } else {
          args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
          if (cwd) args.push('-C', cwd);
          for (const imgPath of imageFiles) args.push('--image', imgPath);
          args.push('--', prompt);
        }

        const child = spawn('codex', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: cwd || undefined,
          env: sanitizedSpawnEnv(),
        });
        ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });

        const pendingToolCalls = new Map<string, string>(); // item.id → tool_use_id

        // Map live items to their persistent rollout call_id so snapshots survive a
        // refresh (see createRolloutCallReader). command_execution ↔ exec list and
        // file_change (apply_patch) ↔ patch list are matched independently, each by
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
        // Sub-agent thread id → the tool_use id of the Task bubble its spawn created.
        // `wait` reports results per agent id, so this is how a report finds its bubble.
        const agentToolUseIds = new Map<string, string>();
        let codexThreadId: string | null = sessionId || null; // for lazy rollout lookup
        let rolloutLookups = 0;
        const MAX_ROLLOUT_LOOKUPS = 8; // bound find() retries for a never-appearing file
        const resolvedToolUseIds = new Map<string, string>(); // item.id → resolved tool_use_id
        const readRollout = createRolloutCallReader(); // incremental, append-only reader

        // Resume: the session file already exists and is findable by the known id, so
        // capture the pre-turn call counts eagerly — before codex appends this turn.
        if (sessionId) {
          try {
            rolloutPath = findCodexSessionPath(sessionId);
            if (rolloutPath) {
              const c = readRollout(rolloutPath);
              execBase = c.exec.length; patchBase = c.patch.length; spawnBase = c.spawn.length; mcpBase = c.mcp.length;
            }
          } catch { rolloutPath = null; execBase = 0; patchBase = 0; spawnBase = 0; mcpBase = 0; }
        }

        // A brand-new session's rollout does NOT exist yet at thread.started, so keep
        // retrying to locate it (bounded). bases stay 0 — a fresh session has no
        // prior-turn calls, so the incremental reader aligns from index 0.
        const ensureRolloutPath = (): string | null => {
          if (rolloutPath || !codexThreadId || rolloutLookups >= MAX_ROLLOUT_LOOKUPS) return rolloutPath;
          rolloutLookups += 1;
          try { rolloutPath = findCodexSessionPath(codexThreadId); } catch { rolloutPath = null; }
          return rolloutPath;
        };

        const resolveExecToolUseId = (item: CodexItem): string => {
          const key = item.id || item.call_id || `codex-${randomUUID()}`;
          const cached = resolvedToolUseIds.get(key);
          if (cached) return cached; // second sighting (started→completed): keep it stable, don't advance

          let toolUseId = codexToolUseId(item); // fallback: item.call_id || item.id || tool-uuid
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

        // Summarize a file_change item for the tool bubble + result text.
        const patchInput = (item: CodexItem) => ({
          changes: (item.changes || []).map((c) => ({ path: c.path || '', kind: c.kind || 'update' })),
        });
        const patchResultText = (item: CodexItem): string => {
          const cs = item.changes || [];
          if (cs.length === 0) return 'apply_patch';
          return cs.map((c) => `${c.kind || 'update'} ${c.path || ''}`.trim()).join('\n');
        };

        // --- Sub-agents (collab_tool_call) -----------------------------------------
        // codex's multi-agent tools, normalized onto claude's shape: ONE Task bubble per
        // sub-agent. `spawn_agent` opens it and leaves it loading; the `wait` that collects
        // that agent's report closes it. Nothing else gets a bubble.
        //
        // Keeping the bubble loading is not just cosmetic: the sub-agent's transcript is a
        // SEPARATE rollout keyed by its own thread id, and the drill-in view
        // (SubagentTranscriptModal → /api/session-by-path) only polls that file while the
        // tool call has no result. Loading == "you can watch it work".
        const emitSpawn = (item: CodexItem) => {
          const agentIds = item.receiver_thread_ids ?? [];
          const path = ensureRolloutPath();
          const entry = path
            ? resolveCodexSpawnCall(readRollout(path).spawn, spawnBase + spawnSeen, agentIds[0])
            : null;
          spawnSeen += 1;

          const toolUseId = entry?.callId || codexToolUseId(item);
          // Prefer the rollout's arguments (they carry agent_type; the live item only has
          // the prompt), and its nickname, which is the bubble's header label.
          const args = entry?.args && Object.keys(entry.args).length > 0
            ? entry.args
            : { message: item.prompt || '' };
          const input = parseCodexSpawnInput(args, {
            nickname: entry?.nickname,
            agentId: agentIds[0] || entry?.agentId,
          });
          // A batch spawn can return several agents on one call; they share the bubble.
          for (const id of agentIds) agentToolUseIds.set(id, toolUseId);
          pendingToolCalls.set(toolUseId, toolUseId);
          ctx.emit({
            type: 'assistant',
            message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.task, input }] },
          });
        };

        const emitAgentReports = (item: CodexItem) => {
          for (const state of parseCodexAgentsStates(item.agents_states)) {
            if (!state.done) continue; // still running (wait timed out) → keep it spinning
            const toolUseId = agentToolUseIds.get(state.agentId);
            if (!toolUseId) continue; // spawned in an earlier turn → not our bubble to close
            ctx.emit({
              type: 'user',
              message: { content: [{ tool_use_id: toolUseId, content: codexAgentResultText(state) }] },
            });
            pendingToolCalls.delete(toolUseId);
            agentToolUseIds.delete(state.agentId);
          }
        };

        // --- MCP / web_search / todo_list ------------------------------------------
        // All three normalize onto claude's vocabulary so they reuse its renderers:
        // `mcp__<server>__<tool>` (codex's own rollout namespace spells it the same
        // way), WebSearch/WebFetch, and TodoWrite (MessageBubble renders its checklist).
        const resolveMcpToolUseId = (item: CodexItem): string => {
          const key = item.id || `codex-${randomUUID()}`;
          const cached = resolvedToolUseIds.get(key);
          if (cached) return cached; // started→completed: keep it stable, don't advance

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
          // The `ws_…` item id IS the rollout's call_id here, so no lookup is needed
          // and live/resume agree on the bubble id for free.
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
          // wait / close_agent / send_input / resume_agent: no bubble of their own, but any
          // of them can carry a terminal agents_states, so harvest reports from all.
          emitAgentReports(item);
        };

        const rl = createInterface({ input: child.stdout! });

        rl.on('line', (line) => {
          if (terminated) return;
          let event: CodexEvent;
          try { event = JSON.parse(line); } catch { return; }

          switch (event.type) {
            case 'thread.started': {
              const threadId = event.thread_id || `codex-${randomUUID()}`;
              if (event.thread_id) codexThreadId = event.thread_id; // enable lazy lookup
              ctx.rekey(threadId); // rekey provisional runId → codex thread id (+ loading)
              ctx.emit({ type: 'system', subtype: 'init', session_id: threadId });
              // Try once here too (a fresh session's file usually appears shortly after);
              // if still missing, resolveToolUseId keeps retrying. base stays 0 for fresh.
              ensureRolloutPath();
              break;
            }
            case 'item.completed': {
              const item = event.item;
              if (!item) break;
              if (item.type === 'agent_message' && item.text) {
                ctx.emit({ type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } });
              }
              if (item.type === 'error' && (item.message || item.text)) {
                ctx.emit({ type: 'error', error: item.message || item.text });
              }
              if (item.type === 'reasoning' && item.text) {
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'text', text: `<details><summary>Reasoning</summary>\n\n${item.text}\n\n</details>` }] },
                });
              }
              if (item.type === 'command_execution') {
                const toolUseId = resolveExecToolUseId(item);
                if (!pendingToolCalls.has(toolUseId)) {
                  ctx.emit({
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.bash, input: { command: item.command || '' } }] },
                  });
                }
                ctx.emit({
                  type: 'user',
                  message: { content: [{ tool_use_id: toolUseId, content: item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})` }] },
                });
                pendingToolCalls.delete(toolUseId);
              }
              if (item.type === 'collab_tool_call') {
                // Sub-agent lifecycle. Handled ONLY on item.completed: a spawn's
                // item.started carries an empty receiver_thread_ids, so the agent it
                // created is not yet identifiable there. (codex 0.141 emits no
                // item.updated for these, so there is no third state to track.)
                handleCollabItem(item);
              }
              if (item.type === 'mcp_tool_call') emitMcpCall(item, true);
              // web_search / todo_list complete in one shot and expose no result
              // payload, so they are emitted whole here rather than started early.
              if (item.type === 'web_search') emitWebSearch(item);
              if (item.type === 'todo_list') emitTodoList(item);
              if (item.type === 'file_change') {
                // apply_patch edit — surface as its own tool call so it (a) shows a
                // bubble and (b) triggers a snapshot keyed to this call, instead of its
                // diff being captured by the next (often read-only) command's snapshot.
                const toolUseId = resolvePatchToolUseId(item);
                if (!pendingToolCalls.has(toolUseId)) {
                  ctx.emit({
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.applyPatch, input: patchInput(item) }] },
                  });
                }
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
              // An MCP call can run for a while, so open its bubble now and let
              // item.completed fill the result (same two-phase shape as exec/patch).
              if (item?.type === 'mcp_tool_call') emitMcpCall(item, false);
              if (item?.type === 'command_execution' && item.command) {
                const toolUseId = resolveExecToolUseId(item);
                pendingToolCalls.set(toolUseId, toolUseId);
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'tool_use', id: toolUseId, name: CODEX_TOOL_NAMES.bash, input: { command: item.command } }] },
                });
              }
              if (item?.type === 'file_change' && (item.changes?.length ?? 0) > 0) {
                const toolUseId = resolvePatchToolUseId(item);
                pendingToolCalls.set(toolUseId, toolUseId);
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
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: usage.cached_input_tokens || 0,
                },
                total_cost_usd: 0,
              });
              break;
            }
            case 'turn.failed': {
              // Fail the run so it terminates 'error' (scheduled tasks must not misread as success).
              terminated = true;
              failure = new Error(event.error?.message || 'Codex turn failed');
              break;
            }
            case 'error': {
              terminated = true;
              failure = new Error(event.message || 'Codex error');
              break;
            }
            // 'turn.started' — no action
          }
        });

        let stderrBuf = '';
        child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
        child.on('error', (err) => { cleanup(); reject(err); });
        child.on('close', (code) => {
          cleanup();
          const stderr = stderrBuf.trim();
          if (code !== 0 && stderr) console.error(`[Codex] exited with code ${code}: ${stderr}`);
          if (failure) { reject(failure); return; }
          // A non-zero exit with no JSONL error event used to resolve() — the run was marked
          // 'unread' and the user saw an empty reply while the real cause sat in the server log
          // only (e.g. codex dying on a malformed argv before emitting a single event). Fail the
          // run instead so the error reaches the UI. An explicit stop also lands here (SIGTERM →
          // code null), but the orchestrator discards this rejection when its signal is aborted.
          // stderr is NOT a usable signal: codex writes warnings there on fully successful runs.
          if (code !== 0) {
            reject(new Error(stderr || `Codex exited with code ${code}`));
            return;
          }
          resolve();
        });
      });
    },
    // No resolveTitle → teardown 'unread' with undefined title (matches original).
  },
};
