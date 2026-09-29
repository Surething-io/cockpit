/**
 * Readers of scheduled-tasks.json must wait out an in-flight write.
 *
 * writeJsonFile truncates and rewrites in place (no atomic rename — it breaks
 * fs.watch on macOS), and only writers took the file lock. A getTasks() landing in
 * that window read an empty file, and readJsonFileForUpdate's strict parse threw
 * "not valid JSON, refusing to overwrite it" — seen as a flaky CI failure in
 * scheduledTasks.missedOnce.test.ts, where a fired task's trailing status write
 * raced the next test's read.
 *
 * The write window is reproduced deterministically: hold the lock with the file
 * empty, and only put the content back after the reader has had time to run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home: string;
let file: string;
let mod: typeof import('./scheduledTasks');
let withFileLock: typeof import('@cockpit/shared-utils').withFileLock;

const TASKS = [
  {
    id: 't1',
    cwd: '/Users/x/proj',
    tabId: 'tab-1',
    sessionId: 'sess-t1',
    message: 'do the thing',
    type: 'once' as const,
    nextFireTime: Date.now() + 24 * 60 * 60 * 1000,
    paused: true, // never arms a timer
    createdAt: Date.now(),
  },
];

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so it must be set before the import.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;
  file = join(home, 'scheduled-tasks.json');
  writeFileSync(file, JSON.stringify(TASKS), 'utf-8');

  mod = await import('./scheduledTasks');
  ({ withFileLock } = await import('@cockpit/shared-utils'));
  await mod.scheduledTaskManager.init();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
});

describe('scheduled task reads vs. an in-flight write', () => {
  it('getTasks and getUnreadCount wait for the write instead of parsing a truncated file', async () => {
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((r) => (releaseWrite = r));

    const write = withFileLock(file, async () => {
      writeFileSync(file, '', 'utf-8'); // the truncated state a mid-write reader sees
      await writeHeld;
      writeFileSync(file, JSON.stringify(TASKS), 'utf-8');
    });

    const reads = Promise.all([mod.scheduledTaskManager.getTasks(), mod.scheduledTaskManager.getUnreadCount()]);
    // Give an unlocked reader every chance to hit the empty file first.
    await new Promise((r) => setTimeout(r, 50));
    releaseWrite();

    const [tasks, unread] = await reads;
    await write;
    expect(tasks.map((t) => t.id)).toEqual(['t1']);
    expect(unread).toBe(0);
  });
});
