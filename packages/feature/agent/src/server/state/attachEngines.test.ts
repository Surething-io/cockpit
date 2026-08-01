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

  ({ attachEngines } = await import('./globalState'));
});

afterAll(() => {
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
