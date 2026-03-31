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
export function registerCommand(cmd: Omit<RunningCommand, 'outputLines' | 'outputPartial'>): void {
  console.log(`[registry] register: id=${cmd.commandId}, cmd="${cmd.command}", pid=${cmd.pid}, pty=${!!cmd.ptyProcess}, server=${getServerId()}`);
  getRegistry().set(cmd.commandId, {
    ...cmd,
    outputLines: [],
    outputPartial: '',
  });

  // Register in TerminalBridge (for CLI access)
  registerTerminal(cmd.tabId, cmd.commandId, cmd.command, cmd.projectCwd);

  // Write placeholder entry to disk (no output, marked as running)
  writeHistoryPlaceholder(cmd.commandId, cmd.command, cmd.timestamp, cmd.cwd, cmd.projectCwd, cmd.tabId, !!cmd.usePty).catch(() => {});

  if (cmd.ptyProcess) {
    // PTY mode: single data event (stdout + stderr merged, matching a real terminal)
    const pty = cmd.ptyProcess;

    pty.onData((data: string) => {
      appendCommandOutput(cmd.commandId, data);
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
