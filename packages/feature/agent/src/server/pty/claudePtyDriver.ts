/**
 * claudePtyDriver — single-turn PTY driver for ephemeral interactive claude
 * (the core of subscription-billing PTY mode).
 *
 * Mechanism:
 *   - spawn `claude --session-id <uuid>` (new) or `claude -r <uuid>` (resume)
 *   - --dangerously-skip-permissions + auto-accept the "Bypass Permissions mode" menu
 *   - inject hooks via --settings: a no-op Stop hook so every turn emits a stop_hook_summary
 *     completion signal, and a PreToolUse block that turns AskUserQuestion into a plain-text question
 *   - once the REPL is ready, bracketed-paste the prompt + Enter to submit
 *   - tail <uuid>.jsonl (baselined at spawn-time line count, only new lines count); completion detection:
 *       primary = system/stop_hook_summary ; fallback = jsonl idle
 *   - on completion, Ctrl+C x2 to exit, with term.kill() as a backstop
 *
 * Design: docs/pty-subscription-mode-design.md §4 / §9.5
 *
 * Self-contained (node built-ins + node-pty only), runnable standalone via tsx; does not import
 * @cockpit/* aliases, which keeps it headless-testable. Effect wrapping happens at the caller
 * boundary (the chat.ts route).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as pty from 'node-pty';
import { execSync } from 'child_process';

// ── System-clipboard image paste (interactive claude's native attach: Ctrl+V → it reads the
//    clipboard PNG via osascript/xclip) ──
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function hasCmd(c: string): boolean { try { execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; } catch { return false; } }
function clipboardImageSupported(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') return hasCmd('wl-copy') || hasCmd('xclip');
  return false;
}
/** Put an image file on the system clipboard (on mac, convert non-png to png via sips first); returns true on success. */
function setClipboardImage(file: string, isPng: boolean): boolean {
  try {
    if (process.platform === 'darwin') {
      let png = file;
      if (!isPng) { png = `${file}.png`; execSync(`sips -s format png ${shq(file)} --out ${shq(png)}`, { stdio: 'ignore' }); }
      execSync(`osascript -e 'set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as «class PNGf»)'`, { stdio: 'ignore' });
      return true;
    }
    if (process.platform === 'linux') {
      if (hasCmd('wl-copy')) { execSync(`wl-copy --type image/png < ${shq(file)}`, { shell: '/bin/bash', stdio: 'ignore' }); return true; }
      if (hasCmd('xclip')) { execSync(`xclip -selection clipboard -t image/png -i ${shq(file)}`, { stdio: 'ignore' }); return true; }
    }
  } catch { /* */ }
  return false;
}
function getClipboardText(): string | null {
  try {
    if (process.platform === 'darwin') return execSync('pbpaste', { encoding: 'utf8' });
    if (hasCmd('wl-paste')) return execSync('wl-paste -n', { encoding: 'utf8' });
    if (hasCmd('xclip')) return execSync('xclip -o -selection clipboard', { encoding: 'utf8' });
  } catch { /* */ }
  return null;
}
function setClipboardText(t: string): void {
  try {
    if (process.platform === 'darwin') { execSync('pbcopy', { input: t }); return; }
    if (hasCmd('wl-copy')) { execSync('wl-copy', { input: t }); return; }
    if (hasCmd('xclip')) { execSync('xclip -selection clipboard', { input: t }); return; }
  } catch { /* */ }
}

export interface RunTurnOptions {
  /** Working directory (realpath-resolved to locate the jsonl). */
  cwd: string;
  /** The user's message text for this turn. */
  prompt: string;
  /** Session id; if omitted, a new uuid is created and returned. */
  sessionId?: string;
  /** true → `claude -r <id>` resume; false/omitted → `claude --session-id <id>` new. */
  resume?: boolean;
  /** Images (base64). PTY can't pass images directly → write temp files and, in fallback mode,
   *  reference their paths in the prompt so claude reads them via the Read tool (D12, approach A). */
  images?: Array<{ media_type: string; data: string }>;
  /** Each new jsonl line (already JSON.parsed), for the route to map into SSE. */
  onJsonlLine?: (line: TranscriptLine) => void;
  /** Raw PTY output, for the floating window's live stream (D6 dual-view). */
  onPtyData?: (data: string) => void;
  /** REPL is ready and the prompt has been submitted. */
  onSubmit?: () => void;
  /** Synthetic turn boundary for a run kept resident across a background task (see the pendingBg
   *  logic in runClaudeTurn): 'result' finalizes an intermediate turn's bubble at its stop_hook,
   *  'init' starts a new bubble when the follow-up turn (auto-run after the task reports back)
   *  begins. The route maps these to the SAME result/init SSE events a normal single turn emits. */
  onTurnBoundary?: (kind: 'result' | 'init') => void;
  /** Turn completed (via: 'stop_hook_summary' | 'idle' | 'question_esc' | 'question_loop'). */
  onComplete?: (via: string) => void;
  /** AskUserQuestion was auto-cancelled and the turn ended early — either the selector UI got
   *  ESC'd (question_esc) or the model kept retrying the blocked tool (question_loop). Lets the
   *  route surface a pty_notice so the user knows why. */
  onQuestionEsc?: () => void;
  /** Interrupt (ESC / stop button): on abort, send Ctrl+C and exit. */
  signal?: AbortSignal;
  /** Debug logging. */
  debug?: boolean;
  /** Idle-fallback threshold ms (default 3000). */
  idleMs?: number;
  /** Startup stuck: not ready for longer than stuckMs (default 10000) → fire onStuck + a graceMs window. */
  stuckMs?: number;
  graceMs?: number;
  /** Startup stuck (REPL not ready for a long time, likely waiting on a dialog) → prompt the user to handle it. */
  onStuck?: () => void;
  /** Optional hard timeout ms; if omitted there is NO timeout — the turn runs freely and "stuck" is
   *  resolved by the user pressing ESC in the floating window. */
  timeoutMs?: number;
  /** PTY terminal size (must match the frontend xterm, otherwise the TUI's in-place redraw misaligns); default 80x24. */
  cols?: number;
  rows?: number;
}

export interface RunTurnResult {
  sessionId: string;
  jsonlPath: string;
  completed: boolean;
  completedVia: string | null;
  exitCode: number | null;
  /** claude-code itself crashed (upstream bug); completed=false in that case. */
  crashed?: boolean;
  crashError?: string;
  /** Startup-stuck timeout (still not ready / not handled within the grace window) → killed. */
  timedOut?: boolean;
  /** New jsonl lines for this turn. */
  newLines: TranscriptLine[];
}

export interface TranscriptLine {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown; stop_reason?: string | null };
  uuid?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/** cwd → encoding of the ~/.claude/projects/<encoded>/ dir (must realpath first, see §9.5-A). */
export function sessionDirFor(cwd: string): string {
  let real = cwd;
  try { real = fs.realpathSync(cwd); } catch { /* dir may not exist yet */ }
  const encoded = real.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

export function jsonlPathFor(cwd: string, sessionId: string): string {
  return path.join(sessionDirFor(cwd), `${sessionId}.jsonl`);
}

/** Steers the model away from the interactive selector: ask in plain text instead, so the turn
 *  completes normally and the user answers in the next turn. Fed to the model via PreToolUse stderr. */
const ASK_QUESTION_GUIDANCE =
  'Interactive questions cannot be displayed in this session. Do NOT retry this tool. '
  + 'Instead, present your questions as plain text in your reply - each question with its options '
  + 'and your recommended choice - then end your turn and wait for the user to answer in the next message.';

/** Idempotently write the injected hook settings file, returning its path (§9.5-F).
 *  - Stop: no-op hook so every turn emits a stop_hook_summary completion signal.
 *  - PreToolUse(AskUserQuestion): the interactive selector would hang autonomous driving (nobody
 *    answers; the question_esc fallback in runClaudeTurn only salvages the turn). Block it before
 *    execution and steer the model to ask in plain text instead. */
export function ensureHookSettings(): string {
  // Versioned filename: older cockpit processes sharing the tmpdir keep rewriting the old
  // 'cockpit-claude-stophook.json' with Stop-only content; a new name avoids the clash.
  const p = path.join(os.tmpdir(), 'cockpit-claude-hooks-v2.json');
  const content = JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
      PreToolUse: [{
        matcher: 'AskUserQuestion',
        hooks: [{ type: 'command', command: `echo ${shq(ASK_QUESTION_GUIDANCE)} >&2; exit 2` }],
      }],
    },
  });
  // Compare content, not existence: a concurrently running cockpit of another version owns the
  // same path with different hooks and would otherwise win the file forever (existsSync caching).
  try { if (fs.readFileSync(p, 'utf8') === content) return p; } catch { /* missing → write */ }
  // Atomic write (temp + rename): a claude spawned by another instance may read the file at any
  // moment; rename guarantees it sees either the old or the new JSON, never a truncated one.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
  return p;
}

// ── Manual fallback: register the running PTY by sessionId so the frontend can write keys to its stdin ──
const ptyInputRegistry = new Map<string, (data: string) => void>();
/** Write keys into the PTY stdin of a running session; returns false if no PTY is running for it. */
export function writeToPtySession(sessionId: string, data: string): boolean {
  const fn = ptyInputRegistry.get(sessionId);
  if (!fn) return false;
  try { fn(data); return true; } catch { return false; }
}

/**
 * Update the in-flight background-task set from one transcript line. Pure; exported for testing.
 *   - START: a tool_result carrying "Command running in background with ID: <id>".
 *   - DONE:  a user line stamped origin.kind 'task-notification' carrying <task-id><id></task-id>.
 * Used to keep the PTY claude process resident until every run_in_background shell has reported
 * back — otherwise the launch turn's stop_hook would kill claude (and the shell with it).
 */
export function trackBackgroundLifecycle(line: TranscriptLine, pending: Set<string>): void {
  const content = line.message?.content;
  if (line.type === 'user' && Array.isArray(content)) {
    for (const b of content as Array<{ type?: string; content?: unknown }>) {
      if (b.type === 'tool_result' && typeof b.content === 'string') {
        // Match just the id token — a trailing "." (…ID: b7bp62e63. Output is…) must NOT be
        // captured, or it won't match the notification's <task-id> and the run would never drain.
        const m = b.content.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)/);
        if (m) pending.add(m[1]);
      }
    }
  }
  const origin = (line as { origin?: { kind?: string } }).origin;
  if (line.type === 'user' && origin?.kind === 'task-notification') {
    const raw =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type?: string; text?: string }>)
              .filter((b) => b.type === 'text')
              .map((b) => b.text || '')
              .join('')
          : '';
    const id = raw.match(/<task-id>([\s\S]*?)<\/task-id>/)?.[1]?.trim();
    if (id) pending.delete(id);
  }
}

/**
 * Run a single turn. Resolves once the turn has completed and the process has exited
 * (or was interrupted / timed out).
 *
 * Background-task persistence: if the turn launches a `run_in_background` shell, we do NOT kill
 * claude at the launch turn's stop_hook — we keep it resident (and keep polling the jsonl) until
 * the shell reports back, so the real completion notification + the auto-run follow-up turn are
 * captured. See pendingBg / awaitingNewTurn below.
 */
export function runClaudeTurn(opts: RunTurnOptions): Promise<RunTurnResult> {
  const {
    cwd, prompt, onJsonlLine, onPtyData, onSubmit, onComplete, onQuestionEsc, onTurnBoundary, signal,
    debug = false, idleMs = 3000, timeoutMs, cols = 80, rows = 24,
    stuckMs = 10_000, graceMs = 30_000, onStuck,
  } = opts;

  const sessionId = opts.sessionId || crypto.randomUUID();
  const isResume = opts.resume === true;   // a new turn with a uuid uses --session-id; only resume uses -r
  const jsonlPath = jsonlPathFor(cwd, sessionId);
  const settingsPath = ensureHookSettings();

  const log = (...a: unknown[]) => { if (debug) console.error('[driver]', ...a); };

  // Images: prefer native system-clipboard paste (Ctrl+V → claude attaches natively, just like a human);
  // on unsupported platforms / failure, fall back to "temp file + path for claude to Read". Both write temp files first.
  const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  const tempImageFiles: { path: string; isPng: boolean }[] = [];
  for (const img of opts.images || []) {
    try {
      const p = path.join(os.tmpdir(), `cockpit-pty-img-${crypto.randomUUID()}.${EXT[img.media_type] || 'png'}`);
      fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
      tempImageFiles.push({ path: p, isPng: img.media_type === 'image/png' });
    } catch { /* skip bad image */ }
  }
  const useClipboard = tempImageFiles.length > 0 && clipboardImageSupported();
  const effectivePrompt = (!useClipboard && tempImageFiles.length)
    ? `${prompt}\n\n[Attached image(s)]:\n${tempImageFiles.map((f) => f.path).join('\n')}`
    : prompt;
  const cleanupImages = () => {
    for (const f of tempImageFiles) {
      try { fs.unlinkSync(f.path); } catch { /* */ }
      try { fs.unlinkSync(`${f.path}.png`); } catch { /* sips conversion artifact */ }
    }
  };

  return new Promise<RunTurnResult>((resolve) => {
    // Baseline: on resume the jsonl already contains history; only detect new lines (§9.5-D).
    let baseline = 0;
    try { baseline = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).length; } catch { /* new */ }

    // --dangerously-skip-permissions: by design. Equivalent to the SDK path's bypassPermissions;
    // autonomous driving (paste → run → completion detection → exit) must not be blocked by permission
    // prompts. The accept menu is auto-confirmed on first run (§9.5-B/D3).
    const flags = isResume
      ? ['-r', sessionId, '--dangerously-skip-permissions']
      : ['--session-id', sessionId, '--dangerously-skip-permissions'];
    flags.push('--settings', settingsPath);
    const cmd = `claude ${flags.join(' ')}`;
    log('spawn:', cmd, '| jsonl:', jsonlPath, '| baseline:', baseline);

    // Login shell resolves PATH (§9.5-E). Fall back to bash rather than sh: on Linux /bin/sh is often
    // dash, which doesn't support --login for PATH resolution.
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    let term: pty.IPty;
    try {
      term = pty.spawn(shell, ['--login', '-c', cmd], {
        name: 'xterm-256color', cols, rows, cwd, env: process.env as Record<string, string>,
      });
    } catch (e) {
      // spawn failed: clean up temp images, resolve with a failure result (don't reject, to avoid leaking temp files).
      cleanupImages();
      resolve({ sessionId, jsonlPath, completed: false, completedVia: null, exitCode: null, crashed: true, crashError: `spawn failed: ${String(e)}`, newLines: [] });
      return;
    }
    // Manual fallback: register a stdin write entry so the frontend floating window's keys reach this PTY (unregistered in onExit).
    ptyInputRegistry.set(sessionId, (d) => { try { term.write(d); } catch { /* */ } });

    let rawBuf = '';
    let lastDataTs = Date.now();
    let menuHandled = false;
    let questionEscSent = false;
    let askQuestionUses = 0;
    let promptSent = false;
    let completed = false;
    let completedVia: string | null = null;
    let exitSent = false;
    let exited = false;
    let seen = baseline;
    let lastJsonlTs = 0;
    let sawAssistantText = false;
    let crashed = false;
    let crashError = '';
    let timedOut = false;
    const newLines: TranscriptLine[] = [];
    // Background-task persistence: in-flight `run_in_background` shells (see trackBackgroundLifecycle).
    // While non-empty, a stop_hook does NOT end the run — we stay resident until they drain.
    const pendingBg = new Set<string>();
    // Set after an intermediate turn's stop_hook: the next assistant line is a follow-up turn and
    // needs its own bubble (emit an 'init' boundary before its content).
    let awaitingNewTurn = false;

    term.onData((d) => {
      rawBuf += d;
      // Memory cap: keep only the tail (crash/menu/ready markers are in the newly appended segment or
      // at early startup, so truncating the front is safe). Same threshold as XtermFloatingWindow (200k/150k).
      if (rawBuf.length > 200_000) rawBuf = rawBuf.slice(-150_000);
      lastDataTs = Date.now();
      onPtyData?.(d);

      // claude-code crash detection (upstream bug, e.g. on resume EP2 renders a history diff with
      // originalFile=null → null.split()). After crashing, the TUI process often doesn't exit → we must
      // detect and kill it, otherwise (with no timeout) it hangs forever.
      // Signature: a thrown stack contains claude-code's cli.js:line:col (normal output never prints its own source path).
      if (!crashed && /claude-code\/cli\.js:\d+:\d+/.test(rawBuf)) {
        crashed = true;
        const m = rawBuf.match(/Cannot read properties of [^\n\x1b]+/);
        crashError = (m ? m[0] : 'claude-code internal crash').trim();
        log('CRASH detected:', crashError);
        setTimeout(() => { if (!exited) { try { term.kill(); } catch { /* */ } } }, 100);
        setTimeout(() => { if (!exited) { try { term.kill('SIGKILL'); } catch { /* */ } } }, 1000);
        return;
      }

      // Bypass-Permissions accept menu: defaults to "No, exit", must arrow Down to "Yes, I accept" (§9.5-B).
      if (!menuHandled && /Bypass Permissions mode|Yes, I accept/i.test(rawBuf)) {
        menuHandled = true;
        log('accept menu → Down + Enter');
        setTimeout(() => term.write('\x1b[B'), 400);
        setTimeout(() => term.write('\r'), 700);
      }

      // AskUserQuestion interactive selector ("Enter to select · Tab/Arrow keys to navigate · Esc to
      // cancel"): autonomous driving has nobody to answer, so the turn would hang until killed. ESC
      // dismisses the dialog, but ESC counts as a user interrupt → no stop_hook_summary will ever fire,
      // so we must also end the turn ourselves. The question itself is already in the jsonl (assistant
      // tool_use) and thus visible in the chat view; the user answers it as the next turn's message.
      // Gated on promptSent: the footer can only belong to this turn's dialog, never startup menus.
      if (!questionEscSent && promptSent && !completed && /Enter to select.*Esc to cancel/i.test(rawBuf)) {
        questionEscSent = true;
        log('AskUserQuestion UI detected → ESC + end turn');
        onQuestionEsc?.();
        setTimeout(() => { try { term.write('\x1b'); } catch { /* */ } }, 300);   // dismiss dialog → idle prompt
        setTimeout(() => complete('question_esc'), 600);                          // then exit cleanly via Ctrl+C path
      }
    });

    // Ready detection → bracketed-paste prompt (§9.5: a positional arg doesn't work, must paste into the live REPL).
    // Noise-tolerant: once the REPL startup marker appears, submit when output is quiet for 2.2s or 4s after ready
    // (whichever comes first, so continuous noise still submits).
    let replReadyTs = 0;
    const readyCheck = setInterval(() => {
      if (promptSent || exited) return;
      const replReady = /bypass permissions on|shift\+tab/i.test(rawBuf);
      if (replReady && !replReadyTs) replReadyTs = Date.now();
      if (!replReady) return;
      const settled = Date.now() - lastDataTs > 2200;
      const readyTimeout = Date.now() - replReadyTs > 4000;
      if (settled || readyTimeout) submitPrompt();
    }, 300);

    // Startup-stuck detection (replaces the old "15s blind force-paste"): if the REPL ready marker never
    // appears, claude is stuck at a dialog / in an error state rather than actually working. If not ready
    // after stuckMs (default 10s) → prompt the user to handle it + a graceMs (default 30s) window;
    // if the user resolves it within the window → REPL becomes ready → submitPrompt clears the timers and
    // continues normally; still not ready → timeout kill.
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    const stuckTimer = setTimeout(() => {
      if (promptSent || exited) return;
      log(`not ready after ${stuckMs}ms → prompt for manual handling, grace ${graceMs}ms`);
      onStuck?.();
      graceTimer = setTimeout(() => {
        if (promptSent || exited) return;
        timedOut = true;
        log('grace window elapsed and still not ready → kill');
        try { term.kill(); } catch { /* */ }
        setTimeout(() => { if (!exited) { try { term.kill('SIGKILL'); } catch { /* */ } } }, 1500);
      }, graceMs);
    }, stuckMs);
    const clearStartupTimers = () => { clearTimeout(stuckTimer); if (graceTimer) clearTimeout(graceTimer); };

    let savedClip: string | null = null;
    const waitImagePlaceholder = (n: number): Promise<void> => new Promise((res) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const count = (rawBuf.match(/\[Image/g) || []).length;
        if (count >= n || Date.now() - start > 2500 || exited) { clearInterval(iv); res(); }
      }, 100);
    });
    async function submitPrompt() {
      if (promptSent) return;
      promptSent = true;
      clearStartupTimers();   // ready and submitted → cancel the stuck prompt / grace exit
      // 1) Native image paste: for each image, set the system clipboard + Ctrl+V (back up the user's clipboard first, text-only best-effort).
      if (useClipboard) {
        savedClip = getClipboardText();
        for (let i = 0; i < tempImageFiles.length && !exited; i++) {
          if (!setClipboardImage(tempImageFiles[i].path, tempImageFiles[i].isPng)) { log('clipboard set failed, skipping this image'); continue; }
          term.write('\x16');                 // Ctrl+V → claude reads the clipboard and attaches natively
          await waitImagePlaceholder(i + 1);  // wait for the [Image #i+1] placeholder or timeout
        }
      }
      // 2) Paste text + submit
      log('paste prompt + Enter' + (tempImageFiles.length ? ` (${useClipboard ? 'clipboard' : 'path'} x${tempImageFiles.length} img)` : ''));
      term.write('\x1b[200~' + effectivePrompt + '\x1b[201~');   // bracketed paste
      setTimeout(() => term.write('\r'), 250);                   // submit
      // 3) Restore the user's clipboard (claude already read the images at Ctrl+V time).
      if (savedClip != null) setTimeout(() => { if (savedClip != null) setClipboardText(savedClip); }, 800);
      onSubmit?.();
    }

    // jsonl tail (§9.5-C: completion relies on stop_hook_summary, not stop_reason).
    const poll = setInterval(() => {
      let txt: string;
      try { txt = fs.readFileSync(jsonlPath, 'utf8'); } catch { return; }
      const lines = txt.split('\n').filter(Boolean);
      for (let i = seen; i < lines.length; i++) {
        let o: TranscriptLine;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        newLines.push(o);
        lastJsonlTs = Date.now();

        // Background-task lifecycle — track BEFORE emitting so a follow-up turn's 'init' boundary
        // is emitted ahead of its content.
        trackBackgroundLifecycle(o, pendingBg);
        // A follow-up turn (the auto-run after a background task reports back) opens a NEW bubble.
        if (awaitingNewTurn && o.type === 'assistant') { awaitingNewTurn = false; onTurnBoundary?.('init'); }

        onJsonlLine?.(o);
        const blocks = Array.isArray(o.message?.content)
          ? (o.message!.content as Array<{ type?: string }>).map((b) => b.type).join(',') : '';
        if (o.type === 'assistant' && blocks.includes('text')) sawAssistantText = true;
        // Circuit breaker: the PreToolUse hook blocks AskUserQuestion and tells the model not to
        // retry, but a model that retries anyway defeats every completion signal at once (no Stop
        // hook while the turn runs, jsonl/PTY never idle, no selector UI for the ESC fallback).
        // Cap the attempts and end the turn ourselves — every turn must keep an automatic
        // termination path that does not depend on the model cooperating.
        if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
          askQuestionUses += (o.message!.content as Array<{ type?: string; name?: string }>)
            .filter((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion').length;
          if (askQuestionUses >= 3 && !completed) {
            log(`AskUserQuestion x${askQuestionUses} → break retry loop, end turn`);
            onQuestionEsc?.();
            complete('question_loop');
          }
        }
        if (o.type === 'system' && o.subtype === 'stop_hook_summary' && !completed) {
          if (pendingBg.size === 0) {
            complete('stop_hook_summary');
          } else {
            // A background task is still running → stay resident. Finalize this turn's bubble and
            // wait; claude auto-runs a follow-up turn on the same process when the task reports back.
            log('stop_hook with background task(s) pending → staying resident', [...pendingBg]);
            onTurnBoundary?.('result');
            awaitingNewTurn = true;
          }
        }
      }
      seen = lines.length;
    }, 150);

    // Completion fallback (insurance for when stop_hook_summary doesn't fire).
    // Key: idle requires BOTH jsonl AND PTY output to be quiet — during a long streaming turn the jsonl is
    // block-level quiet while the PTY keeps emitting; a jsonl-only "short idle" would falsely complete mid-
    // generation → Ctrl+C cutting off the long turn (symptom: "No response requested." / stop_sequence, lost
    // answer). So we only keep the double-silence fallback.
    const idleCheck = setInterval(() => {
      if (completed || !promptSent) return;
      // Suppress the idle-complete while a background task is pending: during the wait both the jsonl
      // and the PTY are quiet, which would otherwise falsely complete the turn and kill claude (and
      // the background shell with it) before the task reports back.
      if (
        sawAssistantText &&
        pendingBg.size === 0 &&
        Date.now() - lastJsonlTs > idleMs &&
        Date.now() - lastDataTs > idleMs
      ) {
        complete('idle');
      }
    }, 300);

    function complete(via: string) {
      if (completed) return;
      completed = true;
      completedVia = via;
      log('complete via', via);
      onComplete?.(via);
      setTimeout(sendExit, 200);
    }

    function sendExit() {
      if (exitSent) return;
      exitSent = true;
      // Ctrl+C x2: in the happy path, lets claude exit cleanly at the idle prompt (code 0).
      // But when claude is working / in an intermediate state, Ctrl+C only interrupts and doesn't exit →
      // timed SIGHUP → SIGKILL backstop, guaranteeing the process is reaped (jsonl already on disk, no loss)
      // and no orphans are left.
      log('exit: Ctrl+C x2 → SIGHUP → SIGKILL');
      try { term.write('\x03'); } catch { /* */ }
      setTimeout(() => { try { term.write('\x03'); } catch { /* */ } }, 150);
      setTimeout(() => { if (!exited) { try { term.kill(); } catch { /* */ } } }, 900);
      setTimeout(() => { if (!exited) { try { term.kill('SIGKILL'); } catch { /* */ } } }, 2000);
    }

    // Interrupt (ESC / stop)
    const onAbort = () => {
      log('aborted → interrupt + guaranteed kill');
      try { term.write('\x1b'); term.write('\x03'); } catch { /* */ }
      setTimeout(() => { if (!exited) { try { term.kill(); } catch { /* */ } } }, 500);
      setTimeout(() => { if (!exited) { try { term.kill('SIGKILL'); } catch { /* */ } } }, 1500);
    };
    let abortListenerAdded = false;
    if (signal) {
      if (signal.aborted) onAbort();
      else { signal.addEventListener('abort', onAbort, { once: true }); abortListenerAdded = true; }
    }

    // With no timeoutMs, no timeout is set: the turn runs freely and stuck states are reaped by the user's
    // ESC (onAbort). SSE disconnect (close tab / leave) → route cancel() → abort → onAbort, so no orphans.
    const timeout = timeoutMs ? setTimeout(() => {
      if (!exited) {
        log('TIMEOUT, killing');
        try { term.kill(); } catch { /* */ }
        setTimeout(() => { if (!exited) { try { term.kill('SIGKILL'); } catch { /* */ } } }, 1500);
      }
    }, timeoutMs) : null;

    term.onExit(({ exitCode }) => {
      exited = true;
      clearInterval(poll); clearInterval(readyCheck); clearInterval(idleCheck);
      clearStartupTimers(); if (timeout) clearTimeout(timeout);
      ptyInputRegistry.delete(sessionId);
      cleanupImages();
      if (abortListenerAdded) signal?.removeEventListener('abort', onAbort);
      log('exit code', exitCode, 'completed', completed, 'via', completedVia);
      resolve({ sessionId, jsonlPath, completed, completedVia, exitCode, crashed, crashError, timedOut, newLines });
    });
  });
}
