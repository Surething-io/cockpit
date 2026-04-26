// Running command registry
// Uses globalThis to share a single instance across Turbopack module isolation
// Responsibilities:
// 1. Track all running child processes (buffer stdout/stderr)
// 2. Write to the JSONL history file when a child process exits

import { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import fs from 'fs/promises';
import { getTerminalHistoryPath, getTerminalOutputPath, ensureParentDir } from '../paths';
import { registerTerminal, finalizeTerminal, notifyOutputListeners, notifyExitListeners } from './TerminalBridge';

const MAX_OUTPUT_LINES = 5000;
const OUTPUT_FILE_THRESHOLD = 4096;
/** PTY raw byte ring buffer cap (~2MB worth of chars, covers 20k+ typical lines) */
const PTY_RING_BUFFER_MAX = 2 * 1024 * 1024;

/**
 * Append-only ring buffer for raw PTY output.
 *
 * Stores raw chunks (preserving ANSI control sequences intact) and trims the
 * oldest content when the total exceeds the cap. We keep raw text and let the
 * frontend's xterm.js parse it on replay — no per-line splitting, which would
 * corrupt cursor/styling sequences that span line boundaries.
 */
export class PtyRingBuffer {
  private chunks: string[] = [];
  private totalLen = 0;
  private readonly max: number;

  constructor(max: number = PTY_RING_BUFFER_MAX) {
    this.max = max;
  }

  append(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.totalLen += data.length;
    while (this.totalLen > this.max && this.chunks.length > 0) {
      const overflow = this.totalLen - this.max;
      const oldest = this.chunks[0];
      if (oldest.length <= overflow) {
        this.chunks.shift();
        this.totalLen -= oldest.length;
      } else {
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
export function registerCommand(cmd: Omit<RunningCommand, 'outputLines' | 'outputPartial' | 'ptyRingBuffer'>): void {
  console.log(`[registry] register: id=${cmd.commandId}, cmd="${cmd.command}", pid=${cmd.pid}, pty=${!!cmd.ptyProcess}, server=${getServerId()}`);
  const entry: RunningCommand = {
    ...cmd,
    outputLines: [],
    outputPartial: '',
    // Only PTY commands get a ring buffer — pipe mode replay still uses outputLines.
    ...(cmd.ptyProcess ? { ptyRingBuffer: new PtyRingBuffer() } : {}),
  };
  getRegistry().set(cmd.commandId, entry);

  // Register in TerminalBridge (for CLI access)
  registerTerminal(cmd.tabId, cmd.commandId, cmd.command, cmd.projectCwd);

  // Write placeholder entry to disk (no output, marked as running)
  writeHistoryPlaceholder(cmd.commandId, cmd.command, cmd.timestamp, cmd.cwd, cmd.projectCwd, cmd.tabId, !!cmd.usePty).catch(() => {});

  if (cmd.ptyProcess) {
    // PTY mode: single data event (stdout + stderr merged, matching a real terminal).
    // We don't split into lines — control sequences span chunks and would be
    // corrupted by line-based handling. Instead, append raw chunks to a ring
    // buffer for refresh-time replay, and notify live listeners untouched.
    const pty = cmd.ptyProcess;

    pty.onData((data: string) => {
      entry.ptyRingBuffer?.append(data);
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
    if (cmd.outputLines.length > MAX_OUTPUT_LINES) {
      cmd.outputLines.splice(0, cmd.outputLines.length - MAX_OUTPUT_LINES);
      // Reset terminal styling state — truncated head lines may contain unclosed color sequences
      if (cmd.outputLines.length > 0) {
        cmd.outputLines[0] = '\x1b[0m' + cmd.outputLines[0];
      }
    }
  }

  // Notify follow listeners
  notifyOutputListeners(commandId, data);
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

  // Limit to 100 entries max
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
  await fs.writeFile(historyPath, existingLines.join('\n') + '\n', 'utf-8');
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
}
