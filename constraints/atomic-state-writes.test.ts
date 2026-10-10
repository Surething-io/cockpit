/**
 * Constraint: AtomicStateWrites (invariant, L2).
 *
 * A state file is replaced atomically (write a temp file beside it, then
 * rename over it): any reader — including ones that do not take the file lock,
 * like readFileSync in sessions/projects.ts or an external tool — sees either
 * the old document or the new one, never a truncated one. And the state.json
 * watcher that drives the UI's global state keeps firing across those
 * replacements (a rename gives the file a new inode, which a per-file kqueue
 * watch on macOS would silently lose).
 *
 * Why: writeJsonFile truncated the file and wrote it in place, so a crash mid-
 * write left a broken file and an unlocked reader could catch it half-written
 * (two scheduler constraints flaked on exactly that). The old comment kept it
 * that way because atomic rename broke fs.watch on macOS — which only holds for
 * a watch on the file itself, so the watcher now watches the directory.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'cockpit-atomic-writes-'));
process.env.COCKPIT_HOME = home;

type Utils = typeof import('../packages/shared/utils/src/index');
let utils: Utils;

beforeAll(async () => {
  utils = await import('../packages/shared/utils/src/index');
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AtomicStateWrites', () => {
  it('an unlocked reader never sees a half-written state file', async () => {
    const file = join(home, 'big-state.json');
    const doc = (n: number) => ({ n, rows: Array.from({ length: 20_000 }, (_, i) => ({ i, text: `row ${i} of ${n}` })) });
    await utils.writeJsonFile(file, doc(0));

    let torn = 0;
    let reads = 0;
    let writing = true;
    const reader = (async () => {
      while (writing) {
        try {
          JSON.parse(readFileSync(file, 'utf8'));
        } catch {
          torn++;
        }
        reads++;
        await new Promise((r) => setImmediate(r));
      }
    })();

    for (let n = 1; n <= 40; n++) await utils.writeJsonFile(file, doc(n));
    writing = false;
    await reader;

    expect(reads).toBeGreaterThan(40);
    expect(torn, `${torn} of ${reads} reads saw a partial file`).toBe(0);
    // No temp files left behind.
    expect(readdirSync(home).filter((f) => f.startsWith('big-state.json') && f !== 'big-state.json')).toEqual([]);
  }, 60_000);

  it('the state.json watcher keeps firing across atomic replacements', async () => {
    const mod = await import('../src/lib/effect/globalStateHandler');
    const watchGlobalStateFile = (mod as { watchGlobalStateFile?: (onChange: () => void) => () => void })
      .watchGlobalStateFile;
    expect(watchGlobalStateFile, 'watchGlobalStateFile exported').toBeTypeOf('function');

    await utils.writeJsonFile(utils.GLOBAL_STATE_FILE, { sessions: [] });
    let events = 0;
    const stop = watchGlobalStateFile!(() => { events++; });
    try {
      for (let i = 1; i <= 3; i++) {
        const before = events;
        await sleep(150);
        await utils.writeJsonFile(utils.GLOBAL_STATE_FILE, { sessions: [{ i }] });
        for (let t = 0; t < 40 && events === before; t++) await sleep(25);
        expect(events, `write ${i} was seen`).toBeGreaterThan(before);
      }
    } finally {
      stop();
    }
  }, 20_000);
});
