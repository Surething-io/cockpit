/**
 * state.json has always declared an `engine` field that nothing ever wrote, so the
 * recent-sessions badge was dead markup. attachEngines is what finally fills it in,
 * from the same `engines` map the per-project session lists read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const PROJ_A = '/Users/x/alpha';
const PROJ_B = '/Users/x/beta';
const NEVER_OPENED = '/Users/x/ghost';

let home: string;
let attachEngines: typeof import('./globalState').attachEngines;
let updateGlobalState: typeof import('./globalState').updateGlobalState;
// updateGlobalState skips non-existent cwds, so this one has to be real on disk.
let realCwd: string;

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so set it before importing.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;

  const { encodePath } = await import('@cockpit/shared-utils');
  const write = (cwd: string, state: unknown) => {
    const dir = join(home, 'projects', encodePath(cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify(state), 'utf-8');
  };
  write(PROJ_A, { sessions: ['s1', 's2'], engines: { s1: 'deepseek', s2: 'kimi' } });
  // No `engines` key at all — the shape of a project that only ever ran claude.
  write(PROJ_B, { sessions: ['s3'] });

  realCwd = mkdtempSync(join(tmpdir(), 'cockpit-cwd-'));

  ({ attachEngines, updateGlobalState } = await import('./globalState'));
});

afterAll(() => {
  rmSync(realCwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
});

describe('attachEngines', () => {
  it('tags each session from its own project state', async () => {
    const out = await attachEngines([
      { cwd: PROJ_A, sessionId: 's1' },
      { cwd: PROJ_A, sessionId: 's2' },
    ]);
    expect(out.map((s) => s.engine)).toEqual(['deepseek', 'kimi']);
  });

  it('leaves engine unset where the map has no entry — that is the claude default', async () => {
    const out = await attachEngines([
      { cwd: PROJ_A, sessionId: 'unknown-session' },
      { cwd: PROJ_B, sessionId: 's3' },
      { cwd: NEVER_OPENED, sessionId: 's4' },
    ]);
    expect(out.every((s) => s.engine === undefined)).toBe(true);
  });

  // The dispatcher now records the engine on the session itself (state.json), which is
  // the only source for a session that never had a tab — a scheduled task's. The map is
  // written by open tabs alone, so it must not be able to override or blank that.
  it('prefers the engine already on the session over the tab-written map', async () => {
    const out = await attachEngines([
      // never in any map: before, this rendered as the claude default
      { cwd: NEVER_OPENED, sessionId: 's4', engine: 'codex' },
      // map says deepseek, dispatcher says codex — dispatcher wins
      { cwd: PROJ_A, sessionId: 's1', engine: 'codex' },
    ]);
    expect(out.map((s) => s.engine)).toEqual(['codex', 'codex']);
  });

  it('preserves the input order and every other field', async () => {
    const out = await attachEngines([
      { cwd: PROJ_B, sessionId: 's3', title: 'plain', lastActive: 2 },
      { cwd: PROJ_A, sessionId: 's1', title: 'ds', lastActive: 1 },
    ]);
    expect(out).toEqual([
      { cwd: PROJ_B, sessionId: 's3', title: 'plain', lastActive: 2 },
      { cwd: PROJ_A, sessionId: 's1', title: 'ds', lastActive: 1, engine: 'deepseek' },
    ]);
  });

  it('reads one file per project, not per session', async () => {
    // 4 sessions across 2 projects. Correctness is what the assertion can see;
    // the per-cwd cache is what keeps a 100-entry cross-project list cheap.
    const out = await attachEngines([
      { cwd: PROJ_A, sessionId: 's1' },
      { cwd: PROJ_A, sessionId: 's2' },
      { cwd: PROJ_B, sessionId: 's3' },
      { cwd: PROJ_A, sessionId: 's1' },
    ]);
    expect(out.map((s) => s.engine)).toEqual(['deepseek', 'kimi', undefined, 'deepseek']);
  });

  it('returns an empty list unchanged', async () => {
    expect(await attachEngines([])).toEqual([]);
  });
});

/**
 * The other half: what the DISPATCHER records. This is the only engine source for a
 * session that never had a tab (a scheduled task's), so the carry-over below is what
 * stops a plain status update from silently reverting it to the claude default.
 */
describe('updateGlobalState engine', () => {
  const read = async () => {
    const { readJsonFile, GLOBAL_STATE_FILE } = await import('@cockpit/shared-utils');
    const state = await readJsonFile<{ sessions: Array<{ sessionId: string; engine?: string }> }>(
      GLOBAL_STATE_FILE,
      { sessions: [] },
    );
    return state.sessions;
  };

  it('persists the engine, and a later status-only update keeps it', async () => {
    await updateGlobalState(realCwd, 'sess-codex', 'loading', undefined, 'hi', 'codex');
    expect((await read()).find((s) => s.sessionId === 'sess-codex')?.engine).toBe('codex');

    // The client's PATCH passes no engine — must not blank it.
    await updateGlobalState(realCwd, 'sess-codex', 'normal');
    expect((await read()).find((s) => s.sessionId === 'sess-codex')?.engine).toBe('codex');
  });
});
