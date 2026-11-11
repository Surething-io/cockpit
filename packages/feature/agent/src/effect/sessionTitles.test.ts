import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';

let root: string;
let titles: typeof import('./sessionTitles');
let paths: typeof import('@cockpit/shared-utils');
const oldHome = process.env.COCKPIT_HOME;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cockpit-titles-'));
  process.env.COCKPIT_HOME = root;
  paths = await import('@cockpit/shared-utils');
  titles = await import('./sessionTitles');
});
afterAll(async () => {
  if (oldHome === undefined) delete process.env.COCKPIT_HOME;
  else process.env.COCKPIT_HOME = oldHome;
  await rm(root, { recursive: true, force: true });
});
const read = (cwd: string, id: string, fallback = 'First prompt', store = 'claude') =>
  Effect.runPromise(titles.readSessionTitle(cwd, id, fallback, store));
const save = (cwd: string, id: string, value: unknown, store = 'claude') =>
  Effect.runPromise(titles.writeSessionTitle(cwd, id, store, value));
const refresh = (cwd: string, id: string, title: string) =>
  Effect.runPromise(titles.refreshSessionTitle(cwd, id, 'claude', Effect.succeed(title)));
const cached = async (cwd: string, id: string) =>
  titles.cachedSessionTitle(await Effect.runPromise(titles.readProjectTitles(paths.encodePath(cwd))), cwd, id);

describe('session title lifecycle', () => {
  it('persists native titles, skips unchanged writes, and preserves them across renames and resets', async () => {
    const cwd = join(root, 'native-cache');
    expect(await cached(cwd, 's')).toBeUndefined();
    expect((await refresh(cwd, 's', 'Original')).changed).toBe(true);
    const file = titles.sessionTitlesPath(paths.encodePath(cwd));
    const before = await readFile(file, 'utf8');
    expect((await refresh(cwd, 's', 'Original')).changed).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before);
    await save(cwd, 's', 'Custom');
    expect((await refresh(cwd, 's', 'Latest native')).info).toMatchObject({ title: 'Custom', defaultTitle: 'Latest native', customTitle: 'Custom' });
    await save(cwd, 's', null);
    expect(await cached(cwd, 's')).toMatchObject({ title: 'Latest native', customTitle: null });
    expect((await refresh(cwd, 's', 'Untitled Session')).changed).toBe(false);
    expect((await cached(cwd, 's'))?.title).toBe('Latest native');
    expect((await refresh(cwd, 'empty', 'Untitled Session')).changed).toBe(false);
    expect(await cached(cwd, 'empty')).toBeUndefined();
  });

  it('serves cached titles during slow refreshes and rejects a late older result', async () => {
    const cwd = join(root, 'refresh-race');
    await refresh(cwd, 's', 'Cached');
    let release!: (title: string) => void;
    const started = vi.fn();
    const slow = Effect.runPromise(titles.refreshSessionTitle(cwd, 's', 'claude', Effect.tryPromise({
      try: () => new Promise<string>((resolve) => { release = resolve; started(); }),
      catch: (cause) => cause,
    })));
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    try {
      expect((await cached(cwd, 's'))?.title).toBe('Cached');
      await refresh(cwd, 's', 'Newer');
      await save(cwd, 's', 'User rename');
    } finally { release('Older'); }
    expect((await slow).changed).toBe(false);
    expect(await cached(cwd, 's')).toMatchObject({ title: 'User rename', defaultTitle: 'Newer' });
  });

  it('preserves cached data after refresh failure and separates ambiguous native stores', async () => {
    const cwd = join(root, 'refresh-failure');
    await refresh(cwd, 's', 'Keep');
    await expect(Effect.runPromise(titles.refreshSessionTitle(cwd, 's', 'claude', Effect.fail('Unavailable')))).rejects.toThrow();
    expect((await cached(cwd, 's'))?.title).toBe('Keep');
    await Effect.runPromise(titles.refreshSessionTitle(cwd, 's', 'codex', Effect.succeed('Other store')));
    expect(await cached(cwd, 's')).toBeUndefined();
    expect(await read(cwd, 's', '', 'claude')).toMatchObject({ title: 'Keep' });
    expect(await read(cwd, 's', '', 'codex')).toMatchObject({ title: 'Other store' });
  });

  it('preserves favorite names after unpinning and does not resurrect a cleared name', async () => {
    const cwd = join(root, 'legacy-project');
    await writeFile(paths.PINNED_SESSIONS_FILE, JSON.stringify([{ cwd, sessionId: 'old', customTitle: 'My task' }]));
    expect((await read(cwd, 'old')).title).toBe('My task');
    await writeFile(paths.PINNED_SESSIONS_FILE, '[]');
    expect((await read(cwd, 'old')).title).toBe('My task');
    await save(cwd, 'old', '  New\nname  ');
    expect((await read(cwd, 'old')).title).toBe('New name');
    await save(cwd, 'old', null);
    await writeFile(paths.PINNED_SESSIONS_FILE, JSON.stringify([{ cwd, sessionId: 'old', customTitle: 'Old client snapshot' }]));
    expect(await read(cwd, 'old', 'Latest default')).toMatchObject({ title: 'Latest default', customTitle: null, titleRevision: 2 });
  });

  it('serializes mutations without losing other sessions, and orders same-session writes', async () => {
    const cwd = join(root, 'parallel');
    await Effect.runPromise(Effect.all(Array.from({ length: 12 }, (_, i) => titles.writeSessionTitle(cwd, `s${i}`, 'claude', `Title ${i}`)), { concurrency: 'unbounded' }));
    for (let i = 0; i < 12; i++) expect((await read(cwd, `s${i}`)).title).toBe(`Title ${i}`);
    const mutations = await Effect.runPromise(Effect.all(['One', 'Two', null].map((value) => titles.writeSessionTitle(cwd, 'same', 'claude', value)), { concurrency: 'unbounded' }));
    expect(mutations.map((m) => m.revision)).toEqual([1, 2, 3]);
    expect((await read(cwd, 'same')).customTitle).toBeNull();
  });

  it('isolates projects and native stores, normalizes Codex IDs, and groups Pi providers', async () => {
    const cwd = join(root, 'identity');
    const id = '019fecf2-99ce-7af0-9a20-69df24f4fe32';
    await save(cwd, id, 'Codex name', 'codex');
    expect((await read(cwd, `rollout-${id}.jsonl`, 'Default', 'codex')).title).toBe('Codex name');
    expect((await read(cwd, id)).customTitle).toBeNull();
    expect((await read(join(root, 'other'), id, 'Default', 'codex')).customTitle).toBeNull();
    const underscored = join(root, 'project_a');
    const hyphenated = join(root, 'project-a');
    expect(paths.encodePath(underscored)).toBe(paths.encodePath(hyphenated));
    await save(underscored, id, 'Underscore');
    await save(hyphenated, id, 'Hyphen');
    expect((await read(underscored, id)).title).toBe('Underscore');
    expect((await read(hyphenated, id)).title).toBe('Hyphen');
    expect(titles.titleStore('kimi')).toBe(titles.titleStore('ollama'));
  });

  it('rejects blank or invalid values without changing data', async () => {
    const cwd = join(root, 'validation');
    await save(cwd, 's', 'Keep');
    for (const value of [' \n ', 12, {}, undefined]) await expect(save(cwd, 's', value)).rejects.toThrow();
    expect((await read(cwd, 's')).title).toBe('Keep');
  });

  it('fails on malformed metadata without overwriting it', async () => {
    const cwd = join(root, 'broken');
    await save(cwd, 's', 'Before corruption');
    const file = titles.sessionTitlesPath(paths.encodePath(cwd));
    await writeFile(file, '{broken');
    await expect(save(cwd, 's', 'Lost')).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{broken');
  });
});
