import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getTerminalHistoryPath } from '@cockpit/shared-utils';
import * as nodePty from 'node-pty';
import {
  registerCommand,
  getRunningCommand,
  finalizeCommand,
  killCommand,
} from './RunningCommandRegistry';

const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mkChild(): ChildProcess {
  const c = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

async function readEntries(projectCwd: string, tabId: string) {
  const p = getTerminalHistoryPath(projectCwd, tabId);
  try {
    const content = await fs.readFile(p, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* */ } }
});

describe('finalizeCommand tombstone (deleted bubble must not resurrect)', () => {
  it('does NOT re-persist a finished entry when the command was tombstoned', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-tomb-${Date.now()}-a`);
    const tabId = 'tab-a';
    const commandId = 'cmd-tomb-a';
    const child = mkChild();

    registerCommand({
      commandId, command: 'sleep 300', cwd: projectCwd, projectCwd, tabId,
      pid: child.pid!, process: child,
    });
    await sleep(150); // let the async placeholder write land

    // Simulate the delete path: tombstone the command, then the process exits.
    getRunningCommand(commandId)!.deleted = true;
    await finalizeCommand(commandId, 0, child.pid!);

    const entries = await readEntries(projectCwd, tabId);
    const finished = entries.filter((e) => e.id === commandId && e.exitCode !== undefined);
    expect(finished).toHaveLength(0);            // no resurrection as a finished bubble
    expect(getRunningCommand(commandId)).toBeUndefined(); // unregistered
  });

  it('control: a normal (non-deleted) command IS persisted as finished', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-tomb-${Date.now()}-b`);
    const tabId = 'tab-b';
    const commandId = 'cmd-tomb-b';
    const child = mkChild();

    registerCommand({
      commandId, command: 'sleep 300', cwd: projectCwd, projectCwd, tabId,
      pid: child.pid!, process: child,
    });
    await sleep(150);

    await finalizeCommand(commandId, 0, child.pid!); // no tombstone

    const entries = await readEntries(projectCwd, tabId);
    const finished = entries.filter((e) => e.id === commandId && e.exitCode === 0);
    expect(finished).toHaveLength(1);            // normal finalize still works
    expect(getRunningCommand(commandId)).toBeUndefined();
  });

  it('integration: killCommand on a PTY command kills it AND leaves no resurrected entry', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-tomb-${Date.now()}-c`);
    const tabId = 'tab-c';
    const commandId = 'cmd-tomb-c';

    // Fake IPty: kill() flips a flag and asynchronously fires onExit, exactly
    // like node-pty. (Real-process termination is covered by the live HTTP e2e;
    // here we deterministically exercise the kill→onExit→finalize wiring.)
    const exitCbs: Array<(e: { exitCode: number; signal?: number }) => void> = [];
    let killed = false;
    const fakePty = {
      pid: 999999,
      onData: () => ({ dispose() {} }),
      onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitCbs.push(cb);
        return { dispose() {} };
      },
      kill: () => {
        killed = true;
        queueMicrotask(() => exitCbs.forEach((cb) => cb({ exitCode: 0 })));
      },
      resize: () => {},
    } as unknown as nodePty.IPty;
    const dummy = mkChild(); // registerCommand requires a ChildProcess in `process`

    registerCommand({
      commandId, command: 'sleep 300', cwd: projectCwd, projectCwd, tabId,
      pid: fakePty.pid, process: dummy, ptyProcess: fakePty, usePty: true,
    });
    await sleep(150);
    expect(getRunningCommand(commandId)).toBeDefined(); // running before

    // The full delete path: kill the backend process (tombstones internally).
    killCommand(commandId);

    // Wait for pty.onExit → finalizeCommand to unregister it.
    for (let i = 0; i < 40 && getRunningCommand(commandId); i++) await sleep(25);

    expect(killed).toBe(true);                              // backend process was killed
    expect(getRunningCommand(commandId)).toBeUndefined();  // unregistered
    const entries = await readEntries(projectCwd, tabId);
    const finished = entries.filter((e) => e.id === commandId && e.exitCode !== undefined);
    expect(finished).toHaveLength(0);                       // no resurrection
  });
});
