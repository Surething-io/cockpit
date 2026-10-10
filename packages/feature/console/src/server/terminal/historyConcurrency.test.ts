/**
 * Terminal history JSONL under concurrent writers (F8).
 *
 * Every writer of a tab's history file serializes on its path. Without that,
 * a fast command's fire-and-forget placeholder write could land after
 * finalizeCommand and leave the bubble "running", and concurrent writers in
 * one tab dropped each other's entries. None of these tests sleep between the
 * racing calls — that is the point.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(path.join(os.tmpdir(), 'cockpit-history-race-'));
process.env.COCKPIT_HOME = home;

type Registry = typeof import('./RunningCommandRegistry');
type Store = typeof import('./historyStore');
let registry: Registry;
let store: Store;
let historyPathOf: (cwd: string, tabId: string) => string;

const children: ChildProcess[] = [];
let seq = 0;

beforeAll(async () => {
  registry = await import('./RunningCommandRegistry');
  store = await import('./historyStore');
  historyPathOf = (await import('@cockpit/shared-utils')).getTerminalHistoryPath;
});

afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* exited */ } }
  rmSync(home, { recursive: true, force: true });
});

function freshTab() {
  seq += 1;
  return { projectCwd: path.join(home, `proj-${seq}`), tabId: `tab-${seq}` };
}

/** Register a command backed by a real (idle) child process; return its id and pid. */
function start(projectCwd: string, tabId: string, commandId: string) {
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  children.push(child);
  registry.registerCommand({
    commandId, command: 'true', cwd: projectCwd, projectCwd, tabId,
    pid: child.pid!, process: child, timestamp: new Date().toISOString(),
  });
  return child.pid!;
}

async function entries(projectCwd: string, tabId: string) {
  try {
    const text = await fs.readFile(historyPathOf(projectCwd, tabId), 'utf-8');
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

describe('terminal history under concurrent writers', () => {
  it('a command finalized right after it registers is never left "running"', async () => {
    const { projectCwd, tabId } = freshTab();
    const ids = Array.from({ length: 20 }, (_, i) => `fast-${i}`);
    // register → finalize back to back, no await in between: the placeholder
    // write is still in flight when finalize starts.
    await Promise.all(ids.map((id) => registry.finalizeCommand(id, 0, start(projectCwd, tabId, id))));

    const byId = new Map((await entries(projectCwd, tabId)).map((e) => [e.id, e]));
    for (const id of ids) {
      expect(byId.get(id), id).toMatchObject({ exitCode: 0 });
      expect(byId.get(id)?.running, id).toBeUndefined();
    }
  });

  it('concurrent appends to one tab keep every entry', async () => {
    const { projectCwd, tabId } = freshTab();
    const ids = Array.from({ length: 30 }, (_, i) => `append-${i}`);
    await Promise.all(ids.map((id) =>
      store.appendHistoryEntry(projectCwd, tabId, {
        id, command: 'echo', output: '', timestamp: new Date().toISOString(),
      } as Parameters<Store['appendHistoryEntry']>[2]),
    ));

    expect((await entries(projectCwd, tabId)).map((e) => e.id).sort()).toEqual([...ids].sort());
  });

  it('a delete racing another command\'s finalize keeps both outcomes', async () => {
    const { projectCwd, tabId } = freshTab();
    const keepPid = start(projectCwd, tabId, 'keep');
    start(projectCwd, tabId, 'drop');
    // Both placeholders are queued on the history lock already; race the
    // delete of one against the finalize of the other.
    await Promise.all([
      store.removeHistoryEntry(projectCwd, tabId, 'drop', () => registry.killCommand('drop')),
      registry.finalizeCommand('keep', 0, keepPid),
    ]);

    const byId = new Map((await entries(projectCwd, tabId)).map((e) => [e.id, e]));
    expect(byId.has('drop')).toBe(false);
    expect(byId.get('keep')).toMatchObject({ exitCode: 0 });
  });
});
