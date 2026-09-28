import { describe, it, expect, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { sweepOrphanOutputs } from './historyStore';
import { registerCommand, getRunningCommand, finalizeCommand } from './RunningCommandRegistry';
import type { PipeProcess } from './ptyHostClient';

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

describe('sweepOrphanOutputs', () => {
  it('removes only old, unreferenced sidecars', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-sweep-'));
    tmpDirs.push(root);
    const dir = path.join(root, '-proj');
    await fs.mkdir(dir);
    const out = (id: string) => path.join(dir, `terminal-output-${id}.txt`);

    // Recorded outputFile, stored under a different (symlink-style) prefix:
    // must still count as referenced — matched by file name.
    const history = [
      { id: 'kept', command: 'a', outputFile: `/elsewhere/-proj/terminal-output-kept.txt` },
      { id: 'live', command: 'b', running: true },
      { id: 'inline', command: 'c', output: 'short' },
    ];
    await fs.writeFile(path.join(dir, 'terminal-history-t1.jsonl'), history.map((e) => JSON.stringify(e)).join('\n') + '\n');
    for (const id of ['kept', 'live', 'inline', 'gone', 'fresh']) await fs.writeFile(out(id), `${id}-data`);

    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const id of ['kept', 'live', 'inline', 'gone']) await fs.utimes(out(id), old, old);

    const result = await sweepOrphanOutputs(Date.now(), root);

    const left = (await fs.readdir(dir)).filter((n) => n.startsWith('terminal-output-')).sort();
    expect(left).toEqual([
      'terminal-output-fresh.txt', // unreferenced but too new to judge
      'terminal-output-kept.txt',  // referenced by outputFile
      'terminal-output-live.txt',  // belongs to a running entry
    ]);
    expect(result.removed).toBe(2); // 'inline' (stale spill) and 'gone' (entry deleted)
  });

  it('is a no-op when the projects dir does not exist', async () => {
    const result = await sweepOrphanOutputs(Date.now(), path.join(os.tmpdir(), `cockpit-sweep-missing-${Date.now()}`));
    expect(result).toEqual({ removed: 0, bytes: 0 });
  });
});

describe('pipe output without newlines', () => {
  it('keeps only the tail of an unterminated line', async () => {
    const projectCwd = path.join(os.tmpdir(), `cockpit-partial-${Date.now()}`);
    const child = Object.assign(new EventEmitter(), {
      pid: 991001,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { writable: true, write: () => true, end: () => {} },
    }) as unknown as PipeProcess;
    registerCommand({
      commandId: 'cmd-partial', command: 'curl', cwd: projectCwd, projectCwd, tabId: 't',
      pid: 991001, process: child, timestamp: new Date().toISOString(),
    });

    // A progress bar: 300KB of `\r` redraws, never a newline.
    for (let i = 0; i < 3000; i++) child.stdout!.emit('data', `\r${String(i).padStart(99, '.')}`);

    const cmd = getRunningCommand('cmd-partial')!;
    expect(cmd.outputPartial.length).toBe(64 * 1024);
    expect(cmd.outputPartial.endsWith('2999')).toBe(true);
    expect(cmd.outputLines).toHaveLength(0);

    await finalizeCommand('cmd-partial', 0, 991001);
    const { getTerminalHistoryPath } = await import('@cockpit/shared-utils');
    tmpDirs.push(path.dirname(getTerminalHistoryPath(projectCwd, 't')));
  });
});
