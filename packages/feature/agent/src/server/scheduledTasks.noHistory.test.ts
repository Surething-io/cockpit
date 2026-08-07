/**
 * "Independent task" must survive the trip from the chat tab to a scheduled fire.
 *
 * It never did: the flag lives in the POST body the browser sends, and the scheduler
 * dispatches in-process with its own params — so a session with the box ticked still
 * replayed its whole transcript on every fire. Cover the derivation directly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CWD = '/Users/x/proj';
const SID = 'sess-independent';
const PLAIN_SID = 'sess-plain';

let home: string;
let readSessionNoHistory: typeof import('./scheduledTasks').readSessionNoHistory;
let encodePath: (p: string) => string;

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so it must be set before the import.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;

  ({ encodePath } = await import('@cockpit/shared-utils'));
  const projectDir = join(home, 'projects', encodePath(CWD));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, 'session.json'),
    JSON.stringify({ sessions: [SID, PLAIN_SID], noHistories: { [SID]: true } }),
    'utf-8',
  );

  ({ readSessionNoHistory } = await import('./scheduledTasks'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
});

const task = (sessionId: string) =>
  ({ cwd: CWD, sessionId }) as unknown as import('./scheduledTasks').ScheduledTask;

describe('readSessionNoHistory (scheduled fire honors "independent task")', () => {
  it('reads the toggle at fire time for a deepseek built-in session', async () => {
    expect(await readSessionNoHistory(task(SID), 'deepseek', true)).toBe(true);
  });

  it('reads it for ollama, which always runs the built-in loop', async () => {
    expect(await readSessionNoHistory(task(SID), 'ollama', false)).toBe(true);
  });

  it('is false for a session that never ticked the box', async () => {
    expect(await readSessionNoHistory(task(PLAIN_SID), 'ollama', false)).toBe(false);
  });

  it('stays false for deepseek in SDK mode — that loop ignores noHistory', async () => {
    expect(await readSessionNoHistory(task(SID), 'deepseek', false)).toBe(false);
  });

  it('reads it for claude, which honors it by stashing the transcript', async () => {
    // Scheduled dispatch never passes mode:'pty', so this always takes the SDK path.
    expect(await readSessionNoHistory(task(SID), 'claude', false)).toBe(true);
  });

  it('stays false for the external-CLI engines, mirroring the client gate', async () => {
    // codex and kimi are driven by their own CLIs, which own the conversation context.
    for (const engine of ['codex', 'kimi']) {
      expect(await readSessionNoHistory(task(SID), engine, false)).toBe(false);
    }
  });

  it('is false when the project has no state file at all', async () => {
    const orphan = { cwd: '/Users/x/never-opened', sessionId: SID } as unknown as import('./scheduledTasks').ScheduledTask;
    expect(await readSessionNoHistory(orphan, 'ollama', false)).toBe(false);
  });
});
