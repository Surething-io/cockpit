import { spawn } from 'child_process';
import { sanitizedSpawnEnv, findCodexSessionPath } from '@cockpit/shared-utils';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { StringDecoder } from 'string_decoder';
import { join } from 'path';
import { tmpdir } from 'os';
import type { EngineSpec, ImageData, RunCtx } from './types';

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
  type?: string; // 'agent_message' | 'reasoning' | 'command_execution' | 'file_change' | 'error'
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>; // file_change (apply_patch) items
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
export interface RolloutCalls { exec: ReadonlyArray<RolloutExecCall>; patch: ReadonlyArray<RolloutPatchCall> }

/** Extract the target file paths from an apply_patch body (`*** Update File: <path>`). */
export function parsePatchFiles(input: string): string[] {
  const files: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) files.push(m[1].trim());
  return files;
}

/** Parse both exec_command and apply_patch calls out of a chunk of complete JSONL lines. */
function parseCallLines(text: string, exec: RolloutExecCall[], patch: RolloutPatchCall[]): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { payload?: { type?: string; name?: string; call_id?: string; arguments?: string; input?: string } };
    try { entry = JSON.parse(line); } catch { continue; }
    const p = entry.payload;
    if (!p) continue;
    if (p.type === 'function_call' && p.name && CODEX_EXEC_FN_NAMES.has(p.name)) {
      let cmd = '';
      try { cmd = String((JSON.parse(p.arguments || '{}') as { cmd?: string }).cmd || ''); } catch { /* ignore */ }
      exec.push({ callId: p.call_id, cmd });
    } else if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      patch.push({ callId: p.call_id, files: parsePatchFiles(p.input || '') });
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
 * live `command_execution`) and patch list (apply_patch edits, live `file_change`)
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

  const reset = (p: string) => {
    boundPath = p; offset = 0; carry = ''; decoder = new StringDecoder('utf8'); exec.length = 0; patch.length = 0;
  };

  return (rolloutPath: string): RolloutCalls => {
    if (rolloutPath !== boundPath) reset(rolloutPath);
    let size = 0;
    try { size = statSync(rolloutPath).size; } catch { return { exec, patch }; }
    if (size < offset) reset(rolloutPath); // file truncated/rewritten → re-scan
    if (size === offset) return { exec, patch }; // nothing appended

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
    } catch { return { exec, patch }; }

    const data = carry + chunk;
    const lastNl = data.lastIndexOf('\n');
    if (lastNl === -1) { carry = data; return { exec, patch }; } // no complete line yet
    carry = data.slice(lastNl + 1);
    parseCallLines(data.slice(0, lastNl), exec, patch);
    return { exec, patch };
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

export const codexSpec: EngineSpec = {
  name: 'codex',
  // Require a text prompt (codex passes it as the positional arg; an images-only message would
  // otherwise spawn with an undefined prompt). Matches the original route's 400 guard.
  async preflight(params) {
    return typeof params.prompt === 'string' && params.prompt.trim()
      ? { ok: true }
      : { ok: false, status: 400, error: 'codex requires a text prompt' };
  },
  runner: {
    run(ctx: RunCtx) {
      const { cwd, sessionId } = ctx;
      const prompt = ctx.prompt as string; // orchestrator validated non-empty
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
          args.push(prompt);
        } else {
          args.push('--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check');
          if (cwd) args.push('-C', cwd);
          for (const imgPath of imageFiles) args.push('--image', imgPath);
          args.push(prompt);
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
              execBase = c.exec.length; patchBase = c.patch.length;
            }
          } catch { rolloutPath = null; execBase = 0; patchBase = 0; }
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
                    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: item.command || '' } }] },
                  });
                }
                ctx.emit({
                  type: 'user',
                  message: { content: [{ tool_use_id: toolUseId, content: item.aggregated_output || `(exit code: ${item.exit_code ?? 'unknown'})` }] },
                });
                pendingToolCalls.delete(toolUseId);
              }
              if (item.type === 'file_change') {
                // apply_patch edit — surface as its own tool call so it (a) shows a
                // bubble and (b) triggers a snapshot keyed to this call, instead of its
                // diff being captured by the next (often read-only) command's snapshot.
                const toolUseId = resolvePatchToolUseId(item);
                if (!pendingToolCalls.has(toolUseId)) {
                  ctx.emit({
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', id: toolUseId, name: 'ApplyPatch', input: patchInput(item) }] },
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
              if (item?.type === 'command_execution' && item.command) {
                const toolUseId = resolveExecToolUseId(item);
                pendingToolCalls.set(toolUseId, toolUseId);
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: item.command } }] },
                });
              }
              if (item?.type === 'file_change' && (item.changes?.length ?? 0) > 0) {
                const toolUseId = resolvePatchToolUseId(item);
                pendingToolCalls.set(toolUseId, toolUseId);
                ctx.emit({
                  type: 'assistant',
                  message: { content: [{ type: 'tool_use', id: toolUseId, name: 'ApplyPatch', input: patchInput(item) }] },
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
          if (code !== 0 && stderrBuf.trim()) console.error(`[Codex] exited with code ${code}: ${stderrBuf.trim()}`);
          if (failure) reject(failure);
          else resolve();
        });
      });
    },
    // No resolveTitle → teardown 'unread' with undefined title (matches original).
  },
};
