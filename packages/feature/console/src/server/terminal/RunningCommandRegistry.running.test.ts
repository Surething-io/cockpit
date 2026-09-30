import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { getTerminalHistoryPath } from '@cockpit/shared-utils';
import {
  registerCommand,
  getRunningCommand,
  finalizeCommand,
  killCommand,
  listAllRunning,
  interruptCommand,
} from './RunningCommandRegistry';

const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stand-in for the /ws/global-state client set the WS server pins to globalThis.
const sent: string[] = [];
const g = globalThis as unknown as { __cockpitGlobalStateClients?: Set<unknown> };
let prevClients: Set<unknown> | undefined;
beforeAll(() => {
  prevClients = g.__cockpitGlobalStateClients;
  g.__cockpitGlobalStateClients = new Set([{ readyState: 1, send: (d: string) => sent.push(d) }]);
});
afterAll(() => {
  g.__cockpitGlobalStateClients = prevClients;
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* */ } }
});

const pings = () => sent.filter((d) => JSON.parse(d).type === 'running-terminals-changed').length;

function track(projectCwd: string, commandId: string, child: ChildProcess) {
  registerCommand({
    commandId, command: 'sleep 300', cwd: projectCwd, projectCwd, tabId: 'default',
    pid: child.pid!, process: child, timestamp: new Date().toISOString(),
  });
}

describe('listAllRunning', () => {
  it('spans projects, skips tombstoned entries, and pings on every change', async () => {
    const base = path.join(os.tmpdir(), `cockpit-running-${Date.now()}`);
    const a = spawn('sleep', ['300'], { stdio: 'ignore' });
    const b = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(a, b);

    const before = pings();
    track(`${base}-a`, 'cmd-run-a', a);
    track(`${base}-b`, 'cmd-run-b', b);
    expect(pings() - before).toBe(2);

    const ids = () => listAllRunning().map((r) => r.commandId);
    expect(ids()).toEqual(expect.arrayContaining(['cmd-run-a', 'cmd-run-b']));
    expect(listAllRunning().find((r) => r.commandId === 'cmd-run-b')?.projectCwd).toBe(`${base}-b`);

    killCommand('cmd-run-b'); // tombstone: gone from the list at once
    expect(ids()).toContain('cmd-run-a');
    expect(ids()).not.toContain('cmd-run-b');

    await finalizeCommand('cmd-run-a', 0, a.pid!);
    expect(ids()).not.toContain('cmd-run-a');
    expect(pings() - before).toBeGreaterThanOrEqual(4); // 2 spawns + kill + exit
  });
});

describe('interruptCommand', () => {
  it('kills the whole process tree and keeps the bubble as a finished entry', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-interrupt-${Date.now()}`);
    // A shell with a grandchild, like a real bubble running `npm run dev`.
    const child = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore' });
    children.push(child);
    track(projectCwd, 'cmd-int', child);
    await sleep(200); // grandchild spawned + placeholder written

    expect(interruptCommand('cmd-int')).toBe(true);
    for (let i = 0; i < 30 && getRunningCommand('cmd-int'); i++) await sleep(100);
    expect(getRunningCommand('cmd-int')).toBeUndefined();

    const content = await fs.readFile(getTerminalHistoryPath(projectCwd, 'default'), 'utf-8');
    const entries = content.trim().split('\n').map((l) => JSON.parse(l));
    const entry = entries.find((e) => e.id === 'cmd-int');
    expect(entry?.running).toBeFalsy();      // finalized, not left as a placeholder
    expect(entry?.exitCode).toBeDefined();   // persisted: the bubble stays, as finished
  });

  it('refuses unknown and tombstoned commands', () => {
    expect(interruptCommand('cmd-does-not-exist')).toBe(false);
    const c = spawn('sleep', ['300'], { stdio: 'ignore' });
    children.push(c);
    track(path.join(os.tmpdir(), `cockpit-int-dead-${Date.now()}`), 'cmd-int-dead', c);
    killCommand('cmd-int-dead');
    expect(interruptCommand('cmd-int-dead')).toBe(false);
  });
});
