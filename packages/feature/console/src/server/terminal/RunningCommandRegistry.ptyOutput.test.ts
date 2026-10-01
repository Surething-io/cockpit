import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getTerminalHistoryPath, getTerminalOutputPath } from '@cockpit/shared-utils';
import {
  registerCommand,
  getRunningCommand,
  flushAllRunningSync,
  PtyRingBuffer,
} from './RunningCommandRegistry';
import { removeEntryOutput } from './historyStore';
import type { PtyHandle } from './ptyHostClient';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const historyDirs: string[] = [];

/**
 * Wait for the finalized history entry, not just for the registry to drop the
 * command: finalizeCommand unregisters synchronously and only then writes the
 * output file and the JSONL, which on a slow disk (Windows CI) can land well
 * after the registry is empty — reading early returns the running placeholder.
 */
async function waitForFinalEntry(historyPath: string, id: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const lines = (await fs.readFile(historyPath, 'utf-8')).trim().split('\n');
      const entry = lines.map((l) => JSON.parse(l)).find((e) => e.id === id);
      if (entry && !entry.running && entry.exitCode !== undefined) return entry;
    } catch { /* not written yet, or caught mid-write */ }
    if (Date.now() > deadline) throw new Error(`no finalized history entry for ${id}`);
    await sleep(25);
  }
}

afterAll(async () => {
  for (const d of historyDirs) await fs.rm(d, { recursive: true, force: true });
});

/** A PTY whose output and exit are driven by the test. */
function fakePty(pid: number) {
  const dataCbs: Array<(d: string) => void> = [];
  const exitCbs: Array<(e: { exitCode: number }) => void> = [];
  const handle: PtyHandle = {
    pid,
    onData: (cb) => { dataCbs.push(cb); return { dispose() {} }; },
    onExit: (cb) => { exitCbs.push(cb); return { dispose() {} }; },
    write: () => {},
    resize: () => {},
    kill: () => {},
  };
  return {
    handle,
    emit: (d: string) => dataCbs.forEach((cb) => cb(d)),
    exit: (exitCode: number) => exitCbs.forEach((cb) => cb({ exitCode })),
  };
}

async function runToExit(name: string, chunks: string[]) {
  const projectCwd = path.join(os.tmpdir(), `cockpit-ptyout-${Date.now()}-${name}`);
  const tabId = `tab-${name}`;
  const commandId = `cmd-ptyout-${name}`;
  const historyPath = getTerminalHistoryPath(projectCwd, tabId);
  historyDirs.push(path.dirname(historyPath));

  const pty = fakePty(900000 + historyDirs.length);
  registerCommand({
    commandId, command: 'echo', cwd: projectCwd, projectCwd, tabId,
    pid: pty.handle.pid, ptyProcess: pty.handle, usePty: true,
    timestamp: new Date().toISOString(),
  });
  await sleep(100); // let the placeholder write land
  for (const c of chunks) pty.emit(c);
  pty.exit(3);

  const entry = await waitForFinalEntry(historyPath, commandId);
  expect(getRunningCommand(commandId)).toBeUndefined();
  const output: string = entry.outputFile
    ? await fs.readFile(entry.outputFile, 'utf-8')
    : entry.output;
  return { entry, output };
}

describe('finalizeCommand persists PTY output', () => {
  it('keeps a short PTY output inline, ANSI intact', async () => {
    const { entry, output } = await runToExit('short', ['\x1b[32mok\x1b[0m\r\n', 'done\r\n']);
    expect(entry.exitCode).toBe(3);
    expect(entry.running).toBeUndefined();
    expect(output).toBe('\x1b[32mok\x1b[0m\r\ndone\r\n');
  });

  it('spills a long PTY output to an output file', async () => {
    const chunk = 'x'.repeat(1000) + '\r\n';
    const { entry, output } = await runToExit('long', Array(10).fill(chunk));
    expect(entry.outputFile).toBeTruthy();
    expect(output).toBe(chunk.repeat(10));
  });
});

describe('PtyRingBuffer.trimmed', () => {
  it('is false until the head is cut, then true', () => {
    const ring = new PtyRingBuffer(10);
    ring.append('12345');
    expect(ring.trimmed).toBe(false);
    ring.append('\x1b[31m\nabc');
    expect(ring.trimmed).toBe(true);
    expect(ring.length).toBe(10);
  });
});

describe('sidecar output files do not outlive their entry', () => {
  it('an inline finalize removes a stale sidecar left by an earlier run', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-ptyout-${Date.now()}-stale`);
    const commandId = 'cmd-ptyout-stale';
    const stale = getTerminalOutputPath(projectCwd, commandId);
    historyDirs.push(path.dirname(stale));
    await fs.mkdir(path.dirname(stale), { recursive: true });
    await fs.writeFile(stale, 'previous long run');

    const pty = fakePty(990001);
    registerCommand({
      commandId, command: 'echo', cwd: projectCwd, projectCwd, tabId: 'tab-stale',
      pid: pty.handle.pid, ptyProcess: pty.handle, usePty: true,
      timestamp: new Date().toISOString(),
    });
    await sleep(100);
    pty.emit('short\r\n');
    pty.exit(0);
    await waitForFinalEntry(getTerminalHistoryPath(projectCwd, 'tab-stale'), commandId);

    await expect(fs.access(stale)).rejects.toThrow();
  });

  it('removeEntryOutput deletes by id even when outputFile was never recorded', async () => {
    const cwd = path.join(os.tmpdir(), `cockpit-ptyout-${Date.now()}-byid`);
    const file = getTerminalOutputPath(cwd, 'cmd-byid');
    historyDirs.push(path.dirname(file));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'flushed while running');

    await removeEntryOutput(cwd, { id: 'cmd-byid' }); // a running placeholder has no outputFile
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('the exit-time flush writes every live PTY (hosted ones may not survive)', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-ptyout-${Date.now()}-flush`);
    const pty = fakePty(990002);
    registerCommand({
      commandId: 'cmd-flush', command: 'x', cwd: projectCwd, projectCwd, tabId: 'tab-flush',
      pid: pty.handle.pid, ptyProcess: pty.handle, usePty: true, timestamp: new Date().toISOString(),
    });
    historyDirs.push(path.dirname(getTerminalOutputPath(projectCwd, 'x')));
    await sleep(100);
    pty.emit('live output');

    flushAllRunningSync();

    expect(await fs.readFile(getTerminalOutputPath(projectCwd, 'cmd-flush'), 'utf-8')).toBe('live output');
    pty.exit(0);
    await sleep(100);
  });
});
