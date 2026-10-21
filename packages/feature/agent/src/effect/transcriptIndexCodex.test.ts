// Codex catalog over a throwaway HOME / COCKPIT_HOME: paths.ts reads both at module
// load, so the env is set before the modules are imported.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Effect } from 'effect';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-tic-'));
const home = path.join(root, 'home');
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.COCKPIT_HOME = path.join(root, 'cockpit');
const sessions = path.join(home, '.codex', 'sessions');

type Index = import('@cockpit/effect-services').TranscriptIndex;
let live: typeof import('./transcriptIndexLive');
let services: typeof import('@cockpit/effect-services');
let views: typeof import('../server/transcriptViews');

const run = <A>(f: (i: Index) => Effect.Effect<A, never>) =>
  Effect.runPromise(Effect.flatMap(services.TranscriptIndex, f).pipe(Effect.provide(live.TranscriptIndexLive)));
const resolve = (id: string) => run((i) => i.resolveCodex(id));
const list = () => run((i) => i.codexSessions);
const headReads = async () => (await run((i) => i.counters)).codexHeadReads;

const meta = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/w', ...extra } }) + '\n';
const ID = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const rollout = (day: string, n: number) => {
  const dir = path.join(sessions, '2026', '10', day);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `rollout-2026-10-${day}T00-00-0${n}-${ID(n)}.jsonl`);
};

beforeAll(async () => {
  services = await import('@cockpit/effect-services');
  live = await import('./transcriptIndexLive');
  views = await import('../server/transcriptViews');
});

describe('codex catalog', () => {
  it('finds a rollout that was still empty at the first lookup once its meta lands', async () => {
    const p = rollout('01', 1);
    fs.writeFileSync(p, '');
    expect(await resolve(ID(1))).toBeNull();
    fs.writeFileSync(p, JSON.stringify({ type: 'session_meta', payload: { id: ID(1) } }).slice(0, 20)); // half a line
    expect(await resolve(ID(1))).toBeNull();
    fs.writeFileSync(p, meta(ID(1)));
    expect((await resolve(ID(1)))?.path).toBe(p);
  });

  it('reads a first line once: appends and repeat lookups cost no head reads', async () => {
    const p = rollout('02', 2);
    fs.writeFileSync(p, meta(ID(2)));
    expect((await resolve(ID(2)))?.path).toBe(p);
    const before = await headReads();
    fs.appendFileSync(p, JSON.stringify({ type: 'response_item' }) + '\n');
    expect((await resolve(ID(2)))?.path).toBe(p);
    await list();
    expect(await headReads()).toBe(before);
  });

  it('re-reads the meta when the rollout is replaced (new inode)', async () => {
    const p = rollout('03', 3);
    fs.writeFileSync(p, meta(ID(3)));
    expect((await resolve(ID(3)))?.cwd).toBe('/w');
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ type: 'session_meta', payload: { id: ID(3), cwd: '/moved' } }) + '\n');
    fs.renameSync(tmp, p);
    expect((await resolve(ID(3)))?.cwd).toBe('/moved');
  });

  it('drops a deleted rollout and flags sub-agents', async () => {
    const gone = rollout('04', 4);
    fs.writeFileSync(gone, meta(ID(4)));
    expect(await resolve(ID(4))).not.toBeNull();
    fs.rmSync(gone);
    expect(await resolve(ID(4))).toBeNull();

    const child = rollout('05', 5);
    fs.writeFileSync(child, meta(ID(5), { thread_source: 'subagent', agent_role: 'explorer' }));
    const entry = (await list()).find((e) => e.id === ID(5))!;
    expect(views.isCodexSubagent(entry)).toBe(true);
    expect(entry.agentRole).toBe('explorer');
    expect((await list()).some((e) => e.id === ID(4))).toBe(false);
  });

  it('ignores the legacy codex index: a stale version-1 entry cannot mislabel a sub-agent', async () => {
    const p = rollout('07', 7);
    fs.writeFileSync(p, meta(ID(7), { parent_thread_id: ID(1) }));
    // What a version-1 index recorded for it: no sub-agent fields at all.
    fs.mkdirSync(process.env.COCKPIT_HOME!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.COCKPIT_HOME!, 'codex-session-index.json'),
      JSON.stringify({ version: 1, files: { [p]: { id: ID(7), path: p, cwd: '/w', cwdRealpath: '/w' } } })
    );
    // First start after an upgrade: no process state, no heads file of our own yet.
    delete (globalThis as { __cockpitTranscriptIndex?: unknown }).__cockpitTranscriptIndex;
    fs.rmSync(path.join(process.env.COCKPIT_HOME!, 'transcript-index'), { recursive: true, force: true });
    vi.resetModules();
    services = await import('@cockpit/effect-services');
    live = await import('./transcriptIndexLive');
    const entry = (await list()).find((e) => e.id === ID(7))!;
    expect(views.isCodexSubagent(entry)).toBe(true);
    expect(entry.parentThreadId).toBe(ID(1));
  });

  it('concurrent cold misses read each rollout\'s first line once (single-flight)', async () => {
    for (let n = 0; n < 5; n++) fs.writeFileSync(rollout('08', n), meta(`1111111${n}-0000-4000-8000-000000000000`));
    // A fresh process: nothing known yet, so every lookup below misses.
    delete (globalThis as { __cockpitTranscriptIndex?: unknown }).__cockpitTranscriptIndex;
    fs.rmSync(path.join(process.env.COCKPIT_HOME!, 'transcript-index'), { recursive: true, force: true });
    vi.resetModules();
    services = await import('@cockpit/effect-services');
    live = await import('./transcriptIndexLive');
    const rollouts = (await list()).length;
    delete (globalThis as { __cockpitTranscriptIndex?: unknown }).__cockpitTranscriptIndex;
    fs.rmSync(path.join(process.env.COCKPIT_HOME!, 'transcript-index'), { recursive: true, force: true });
    vi.resetModules();
    services = await import('@cockpit/effect-services');
    live = await import('./transcriptIndexLive');
    await run((i) =>
      Effect.all(
        Array.from({ length: 20 }, (_, n) => i.resolveCodex(`99999999-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`)),
        { concurrency: 'unbounded' }
      )
    );
    expect(await headReads()).toBe(rollouts);
  });

  it('canonicalises a cwd that no longer exists through its existing ancestors', async () => {
    const realRoot = fs.realpathSync(root); // /var → /private/var on macOS
    const gone = path.join(root, 'deleted-project', 'sub');
    expect(await live.canonicalPath(gone)).toBe(path.join(realRoot, 'deleted-project', 'sub'));
    expect(await live.canonicalPath(root)).toBe(realRoot);
  });

  it('accepts a full rollout path or file name as the id', async () => {
    const p = rollout('06', 6);
    fs.writeFileSync(p, meta(ID(6)));
    expect((await resolve(p))?.path).toBe(p);
    expect((await resolve(path.basename(p)))?.path).toBe(p);
  });
});
