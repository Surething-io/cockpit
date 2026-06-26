// Running command registry
// Uses globalThis to share a single instance across Turbopack module isolation
// Responsibilities:
// 1. Track all running child processes (buffer stdout/stderr)
// 2. Write to the JSONL history file when a child process exits

import { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import fs from 'fs/promises';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { getTerminalHistoryPath, getTerminalOutputPath, ensureParentDir } from '@cockpit/shared-utils';
import { registerTerminal, finalizeTerminal, notifyOutputListeners, notifyExitListeners } from './TerminalBridge';
import { broadcastConsoleDelta } from './consoleBroadcast';

const MAX_OUTPUT_LINES = 5000;
const OUTPUT_FILE_THRESHOLD = 4096;
/** PTY raw byte ring buffer cap (~2MB worth of chars, covers 20k+ typical lines) */
const PTY_RING_BUFFER_MAX = 2 * 1024 * 1024;

/**
 * Count `\n` (0x0A) characters in a string. Used by both the pipe append path
 * (parts.length is enough there) and the PTY ring buffer to maintain its
 * monotonic global line counter without ever scanning the whole snapshot.
 */
export function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0A) n++;
  }
  return n;
}

/**
 * Append-only ring buffer for raw PTY output.
 *
 * Stores raw chunks (preserving ANSI control sequences intact) and trims the
 * oldest content when the total exceeds the cap. We keep raw text and let the
 * frontend's xterm.js parse it on replay — no per-line splitting, which would
 * corrupt cursor/styling sequences that span line boundaries.
 *
 * In addition to the byte ring buffer, we maintain two monotonic line counters
 * so the CLI can use stable global line numbers as cursors:
 *   - `totalLinesEverWritten`: total `\n` chars ever appended (only grows).
 *   - `firstAvailableLine`: global line number of the first complete line still
 *     reachable in the ring (advances when bytes are trimmed from the head).
 * The pair lets callers convert any `lineno ∈ [firstAvailableLine,
 * totalLinesEverWritten)` to "still in the ring" and detect when an older
 * cursor has been evicted.
 */
export class PtyRingBuffer {
  private chunks: string[] = [];
  private totalLen = 0;
  private readonly max: number;
  /** Monotonic count of `\n` chars ever appended. Never decreases. */
  private _totalLinesEverWritten = 0;
  /** Global line number of the first complete line currently in the ring. */
  private _firstAvailableLine = 0;

  constructor(max: number = PTY_RING_BUFFER_MAX) {
    this.max = max;
  }

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLen += data.length;
    this._totalLinesEverWritten += countNewlines(data);
    while (this.totalLen > this.max && this.chunks.length > 0) {
      const overflow = this.totalLen - this.max;
      const oldest = this.chunks[0];
      if (oldest.length <= overflow) {
        this._firstAvailableLine += countNewlines(oldest);
        this.chunks.shift();
        this.totalLen -= oldest.length;
      } else {
        const cut = oldest.slice(0, overflow);
        this._firstAvailableLine += countNewlines(cut);
        this.chunks[0] = oldest.slice(overflow);
        this.totalLen -= overflow;
      }
    }
  }

  snapshot(): string {
    return this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
  }

  get length(): number {
    return this.totalLen;
  }

  /** Total `\n` chars ever written — monotonic global "next line number". */
  get totalLinesEverWritten(): number {
    return this._totalLinesEverWritten;
  }

  /** Global line number of the first complete line still in the ring. */
  get firstAvailableLine(): number {
    return this._firstAvailableLine;
  }
}

/**
 * Find a safe replay start position inside a PTY snapshot.
 *
 * The buffer's head may be in the middle of an ANSI escape sequence
 * (because the ring buffer trims by raw byte count). Replaying from a
 * partial sequence makes xterm render garbage. Strategy:
 *   1. Prefer the position right after the first '\n' — line feed cannot
 *      appear inside CSI sequences, and is a UTF-16 code-unit boundary.
 *   2. Fall back to the first ESC (0x1B) — guaranteed start of a fresh sequence.
 *   3. Worst case: position 0 (only if 2MB contains neither '\n' nor ESC,
 *      which is essentially impossible for real terminal output).
 *
 * No scan upper bound: indexOf is V8-optimized and attach is rare.
 */
export function findSafeStart(s: string): number {
  const lf = s.indexOf('\n');
  if (lf !== -1) return lf + 1;
  const esc = s.indexOf('\x1b');
  if (esc !== -1) return esc;
  return 0;
}

export interface RunningCommand {
  commandId: string;
  command: string;
  cwd: string;
  projectCwd: string;
  tabId: string;
  pid: number;
  process: ChildProcess;
  /** PTY process instance (set in PTY mode) */
  ptyProcess?: IPty;
  /** Whether PTY mode is enabled */
  usePty?: boolean;
  outputLines: string[];
  outputPartial: string;
  /** PTY raw output ring buffer — only set in PTY mode, released on finalize */
  ptyRingBuffer?: PtyRingBuffer;
  timestamp: string;
  /** Originating browser tab's sync id — echoed in the placeholder broadcast so
   *  the tab that started/reran the command ignores its own delta. */
  sourceId?: string;
  /**
   * Pipe mode: monotonic count of complete (newline-terminated) lines ever
   * appended. Never decreases — splice() trimming `outputLines` does NOT
   * decrement this. Acts as the global "next line number" cursor.
   * For PTY mode this is mirrored from `ptyRingBuffer.totalLinesEverWritten`.
   */
  totalLinesEverWritten: number;
  /** Last time output was appended (epoch ms). Used by /api/terminal/meta. */
  lastOutputAt?: number;
  /**
   * Tombstone: set by killCommand() when the user deletes/closes a bubble.
   * The process's onExit→finalizeCommand sees this flag and silently
   * unregisters WITHOUT re-persisting a JSONL entry or broadcasting an
   * update — otherwise a deleted bubble would resurrect as a "finished"
   * record on the next refresh.
   */
  deleted?: boolean;
}

const GLOBAL_KEY = Symbol.for('terminal_running_commands');
const SERVER_ID_KEY = Symbol.for('terminal_server_id');

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, RunningCommand> | string | undefined;
};

/** Unique server startup ID, used to detect restarts */
function getServerId(): string {
  const g = globalThis as GlobalWithRegistry;
  if (!g[SERVER_ID_KEY]) {
    g[SERVER_ID_KEY] = `srv_${Date.now()}_${process.pid}`;
    console.log(`[registry] server started, id=${g[SERVER_ID_KEY]}, pid=${process.pid}`);
  }
  return g[SERVER_ID_KEY] as string;
}

// Print server id on initialization
getServerId();

function getRegistry(): Map<string, RunningCommand> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, RunningCommand>();
  }
  return g[GLOBAL_KEY] as Map<string, RunningCommand>;
}

/**
 * Register a running command
 * Automatically attaches close/error listeners to ensure finalizeCommand always runs
 */
export function registerCommand(
  cmd: Omit<
    RunningCommand,
    'outputLines' | 'outputPartial' | 'ptyRingBuffer' | 'totalLinesEverWritten' | 'lastOutputAt'
  >,
): void {
  console.log(`[registry] register: id=${cmd.commandId}, cmd="${cmd.command}", pid=${cmd.pid}, pty=${!!cmd.ptyProcess}, server=${getServerId()}`);
  const entry: RunningCommand = {
    ...cmd,
    outputLines: [],
    outputPartial: '',
    totalLinesEverWritten: 0,
    // Only PTY commands get a ring buffer — pipe mode replay still uses outputLines.
    ...(cmd.ptyProcess ? { ptyRingBuffer: new PtyRingBuffer() } : {}),
  };
  getRegistry().set(cmd.commandId, entry);

  // Register in TerminalBridge (for CLI access)
  registerTerminal(cmd.tabId, cmd.commandId, cmd.command, cmd.projectCwd);

  // Write placeholder entry to disk (no output, marked as running)
  writeHistoryPlaceholder(cmd.commandId, cmd.command, cmd.timestamp, cmd.cwd, cmd.projectCwd, cmd.tabId, !!cmd.usePty, cmd.sourceId).catch(() => {});

  if (cmd.ptyProcess) {
    // PTY mode: single data event (stdout + stderr merged, matching a real terminal).
    // We don't split into lines — control sequences span chunks and would be
    // corrupted by line-based handling. Instead, append raw chunks to a ring
    // buffer for refresh-time replay, and notify live listeners untouched.
    const pty = cmd.ptyProcess;

    pty.onData((data: string) => {
      entry.ptyRingBuffer?.append(data);
      // Mirror the buffer's monotonic line counter onto the RunningCommand so
      // CLI/HTTP read paths can use a single accessor regardless of mode.
      if (entry.ptyRingBuffer) {
        entry.totalLinesEverWritten = entry.ptyRingBuffer.totalLinesEverWritten;
      }
      entry.lastOutputAt = Date.now();
      notifyOutputListeners(cmd.commandId, data);
    });

    const ptyPid = cmd.pid;
    pty.onExit(async ({ exitCode }) => {
      try { await finalizeCommand(cmd.commandId, exitCode, ptyPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
  } else {
    // Pipe mode: separate stdout/stderr streams
    const child = cmd.process;

    child.stdout?.on('data', (data: Buffer) => {
      appendCommandOutput(cmd.commandId, data.toString());
    });
    child.stderr?.on('data', (data: Buffer) => {
      appendCommandOutput(cmd.commandId, data.toString());
    });

    const childPid = cmd.pid;
    child.on('close', async (code: number | null) => {
      try { await finalizeCommand(cmd.commandId, code ?? 0, childPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
    child.on('error', async () => {
      try { await finalizeCommand(cmd.commandId, 1, childPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
  }
}

/**
 * Append output to the buffer
 */
export function appendCommandOutput(commandId: string, data: string): void {
  const cmd = getRegistry().get(commandId);
  if (!cmd) return;

  const text = cmd.outputPartial + data;
  const parts = text.split('\n');
  cmd.outputPartial = parts.pop() || '';

  // No truncation on outputPartial — normal CLI output always has newlines,
  // and the rare lineless cases (base64, progress bars) are too small to matter.

  if (parts.length > 0) {
    cmd.outputLines.push(...parts);
    // Monotonic global line counter. Critically: this is NOT decremented
    // when outputLines is spliced below — the array index drifts, the
    // global line number never does. This is what makes CLI cursors stable.
    cmd.totalLinesEverWritten += parts.length;
    if (cmd.outputLines.length > MAX_OUTPUT_LINES) {
      cmd.outputLines.splice(0, cmd.outputLines.length - MAX_OUTPUT_LINES);
      // Reset terminal styling state — truncated head lines may contain unclosed color sequences
      if (cmd.outputLines.length > 0) {
        cmd.outputLines[0] = '\x1b[0m' + cmd.outputLines[0];
      }
    }
  }

  cmd.lastOutputAt = Date.now();

  // Notify follow listeners
  notifyOutputListeners(commandId, data);
}

/**
 * Global line number of the first complete (line-terminated) entry still
 * reachable. Pipe mode: derived from `totalLinesEverWritten - outputLines.length`.
 * PTY mode: delegated to the ring buffer's own counter.
 */
export function getFirstAvailableLine(cmd: RunningCommand): number {
  if (cmd.ptyRingBuffer) return cmd.ptyRingBuffer.firstAvailableLine;
  return cmd.totalLinesEverWritten - cmd.outputLines.length;
}

function getBufferedOutput(cmd: RunningCommand): string {
  const lines = cmd.outputLines.join('\n');
  if (cmd.outputPartial) {
    return lines ? lines + '\n' + cmd.outputPartial : cmd.outputPartial;
  }
  return lines;
}

/**
 * Query running commands for a given project
 */
export function getRunningCommands(projectCwd: string): Array<{
  commandId: string;
  command: string;
  cwd: string;
  tabId: string;
  pid: number;
  timestamp: string;
  usePty?: boolean;
}> {
  const results: ReturnType<typeof getRunningCommands> = [];
  for (const cmd of getRegistry().values()) {
    if (cmd.projectCwd === projectCwd) {
      results.push({
        commandId: cmd.commandId,
        command: cmd.command,
        cwd: cmd.cwd,
        tabId: cmd.tabId,
        pid: cmd.pid,
        timestamp: cmd.timestamp,
        ...(cmd.usePty ? { usePty: true } : {}),
      });
    }
  }
  return results;
}

/**
 * Get a single command (used for attach)
 */
export function getRunningCommand(commandId: string): RunningCommand | undefined {
  return getRegistry().get(commandId);
}

/**
 * Kill a running command's backend process and tombstone it.
 *
 * Single authoritative "destroy the process" entry point — used by the
 * delete/clear paths so closing a bubble actually ends the backend. The
 * tombstone (`deleted = true`) is set BEFORE killing so the asynchronous
 * onExit→finalizeCommand callback skips JSONL re-persistence (no resurrection
 * on refresh). Best-effort + idempotent: unknown id is a no-op.
 */
export function killCommand(commandId: string): void {
  const cmd = getRegistry().get(commandId);
  if (!cmd) return;
  cmd.deleted = true;
  console.log(`[registry] kill: id=${commandId}, pid=${cmd.pid}, pty=${!!cmd.ptyProcess}, server=${getServerId()}`);
  if (cmd.ptyProcess) {
    // node-pty kills the whole pty session (process group)
    try { cmd.ptyProcess.kill(); } catch { /* already exited */ }
  } else {
    const pid = cmd.pid;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch { /* exited */ }
    }, 1000);
  }
}

/**
 * Diagnostics: total registry size
 */
export function getRegistrySize(): number {
  return getRegistry().size;
}

/**
 * Diagnostics: all distinct projectCwds in the registry
 */
export function getAllProjectCwds(): string[] {
  const cwds = new Set<string>();
  for (const cmd of getRegistry().values()) {
    cwds.add(cmd.projectCwd);
  }
  return [...cwds];
}

/**
 * Write a placeholder entry to JSONL when a command is created (no output, marked running: true)
 */
async function writeHistoryPlaceholder(
  commandId: string, command: string, timestamp: string,
  cwd: string, projectCwd: string, tabId: string, usePty: boolean,
  sourceId?: string,
): Promise<void> {
  const historyPath = getTerminalHistoryPath(projectCwd, tabId);
  await ensureParentDir(historyPath);

  const entry: Record<string, unknown> = {
    id: commandId, command, output: '', timestamp, cwd,
    ...(usePty ? { usePty: true } : {}),
    running: true,
  };

  let existingLines: string[] = [];
  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    existingLines = content.trim().split('\n').filter(Boolean);
  } catch { /* file does not exist */ }

  // Rerun: an entry with this id already exists (finalized from a previous run).
  // Replace it in place (avoids duplicate-id lines) and signal a rerun, not an add.
  let isRerun = false;
  for (let i = 0; i < existingLines.length; i++) {
    try {
      if (JSON.parse(existingLines[i]).id === commandId) {
        existingLines[i] = JSON.stringify(entry);
        isRerun = true;
        break;
      }
    } catch { /* ignore unparseable */ }
  }

  if (!isRerun) {
    // Limit to 100 entries max (only when appending a genuinely new bubble)
    if (existingLines.length >= 100) {
      const removedLines = existingLines.slice(0, existingLines.length - 99);
      for (const line of removedLines) {
        try {
          const old = JSON.parse(line);
          if (old.outputFile) await fs.unlink(old.outputFile).catch(() => {});
        } catch { /* ignore */ }
      }
      existingLines = existingLines.slice(-99);
    }
    existingLines.push(JSON.stringify(entry));
  }

  await fs.writeFile(historyPath, existingLines.join('\n') + '\n', 'utf-8');

  // Sync to other tabs. sourceId lets the originating tab drop its own echo
  // (critical for rerun: that tab already reset + re-attached locally).
  broadcastConsoleDelta(
    projectCwd,
    tabId,
    isRerun ? { op: 'rerun', entry } : { op: 'add', entry },
    sourceId,
  );
}

/**
 * When a command finishes: replace the placeholder entry (write output) and clean up the registry
 */
export async function finalizeCommand(commandId: string, exitCode: number, pid?: number): Promise<void> {
  const registry = getRegistry();
  const cmd = registry.get(commandId);
  if (!cmd) return; // idempotent: skip if already finalized
  // rerun scenario: old process onExit must not delete the new process's registry entry
  if (pid !== undefined && cmd.pid !== pid) return;

  console.log(`[registry] finalize: id=${commandId}, exitCode=${exitCode}, cmd="${cmd.command}", server=${getServerId()}`);

  // Notify follow listeners that the process has exited
  notifyExitListeners(commandId, exitCode);
  finalizeTerminal(commandId, exitCode);

  // Tombstoned by killCommand (user deleted/closed the bubble): unregister
  // silently. We still ran the exit notifications above so any attached tab
  // closes its live stream, but we MUST NOT re-persist or broadcast an update
  // here — the JSONL entry was already removed by the delete path, and writing
  // it back would make the bubble reappear on the next refresh.
  if (cmd.deleted) {
    cmd.ptyRingBuffer = undefined;
    registry.delete(commandId);
    return;
  }

  const output = getBufferedOutput(cmd);
  // Release the PTY ring buffer — the JSONL/output file written below is the
  // canonical record for already-exited commands; the ring buffer was only
  // needed for live attach/replay during the run.
  cmd.ptyRingBuffer = undefined;
  registry.delete(commandId);

  const entry: Record<string, unknown> = {
    id: cmd.commandId,
    command: cmd.command,
    output: '',
    exitCode,
    timestamp: cmd.timestamp,
    cwd: cmd.cwd,
    ...(cmd.usePty ? { usePty: true } : {}),
  };

  const historyPath = getTerminalHistoryPath(cmd.projectCwd, cmd.tabId);
  await ensureParentDir(historyPath);

  // Store long output in a separate file
  if (output.length > OUTPUT_FILE_THRESHOLD) {
    const outputPath = getTerminalOutputPath(cmd.projectCwd, cmd.commandId);
    await fs.writeFile(outputPath, output, 'utf-8');
    entry.outputFile = outputPath;
  } else {
    entry.output = output;
  }

  // Read existing history and replace the placeholder entry
  let existingLines: string[] = [];
  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    existingLines = content.trim().split('\n').filter(Boolean);
  } catch {
    // file does not exist
  }

  // Find and replace the placeholder entry; append if not found
  let replaced = false;
  for (let i = 0; i < existingLines.length; i++) {
    try {
      if (JSON.parse(existingLines[i]).id === commandId) {
        existingLines[i] = JSON.stringify(entry);
        replaced = true;
        break;
      }
    } catch { /* ignore */ }
  }
  if (!replaced) {
    existingLines.push(JSON.stringify(entry));
  }

  await fs.writeFile(historyPath, existingLines.join('\n') + '\n', 'utf-8');

  // Flip the bubble to finished in other tabs. Output is NOT sent here — it rides
  // the per-command terminal stream (each attached tab already got the exit event).
  // sourceId = the tab that started/reran this run, so it ignores its own finalize
  // (otherwise an old run's finalize could race a rerun and unset isRunning).
  broadcastConsoleDelta(cmd.projectCwd, cmd.tabId, {
    op: 'update',
    id: cmd.commandId,
    fields: { running: false, exitCode },
  }, cmd.sourceId);
}

/** Sentinel exit code for a PTY/command that was still running when the server died. */
export const INTERRUPTED_EXIT_CODE = -1;

/**
 * Synchronously dump every live PTY ring buffer to its output file.
 *
 * Called from the process `exit` hook (server.mjs) so a graceful restart
 * (Ctrl-C / SIGINT / SIGTERM) preserves terminal scrollback on disk. MUST be
 * synchronous: an `exit` handler cannot await, and async fs writes would not
 * flush before the process dies. The placeholder JSONL line still says
 * `running: true`; the next server reconciles it on load (see
 * reconcileOrphanedRunning). A hard kill (SIGKILL) skips this and loses the
 * content — by design.
 */
export function flushAllRunningSync(): void {
  const registry = getRegistry();
  for (const cmd of registry.values()) {
    const buf = cmd.ptyRingBuffer;
    if (!buf || buf.length === 0) continue;
    try {
      const outputPath = getTerminalOutputPath(cmd.projectCwd, cmd.commandId);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, buf.snapshot(), 'utf-8');
    } catch { /* best-effort flush; never block shutdown */ }
  }
}

/**
 * Reconcile orphaned `running: true` placeholders left by a previous server.
 *
 * A PTY terminal is persisted as a placeholder (running: true) and only cleared
 * by finalizeCommand inside the owning process. A server restart/crash kills the
 * PTY without finalizing, so the placeholder is stranded — and loadHistory skips
 * every running entry, making the bubble vanish. Here we rewrite any running
 * entry that is NOT live in *this* process into a finished one: drop `running`,
 * mark it interrupted, and attach its flushed output file if present. Also
 * collapses duplicate ids (rerun placeholders) keeping the latest.
 *
 * Idempotent: rewrites the file only when something actually changed.
 */
export async function reconcileOrphanedRunning(projectCwd: string, tabId: string): Promise<void> {
  const historyPath = getTerminalHistoryPath(projectCwd, tabId);

  let content: string;
  try {
    content = await fs.readFile(historyPath, 'utf-8');
  } catch {
    return; // no history file yet
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return;

  // Dedup by id, keeping the last occurrence (rerun appends a fresh placeholder).
  const byId = new Map<string, Record<string, unknown>>();
  let changed = false;
  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      changed = true; // drop unparseable line
      continue;
    }
    const id = entry.id as string | undefined;
    if (!id) continue;
    if (byId.has(id)) changed = true; // duplicate collapsed
    byId.delete(id);
    byId.set(id, entry);
  }

  for (const entry of byId.values()) {
    if (entry.running !== true) continue;
    const id = entry.id as string;
    // Still live in this server (same-process refresh) → leave it for reattach.
    if (getRunningCommand(id)) continue;

    delete entry.running;
    entry.exitCode = INTERRUPTED_EXIT_CODE;
    const outputPath = getTerminalOutputPath(projectCwd, id);
    try {
      const stat = await fs.stat(outputPath);
      if (stat.size > 0) entry.outputFile = outputPath;
    } catch { /* no flushed output → bubble restores empty */ }
    changed = true;
  }

  if (!changed) return;

  const rewritten = [...byId.values()].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.writeFile(historyPath, rewritten, 'utf-8');
}
