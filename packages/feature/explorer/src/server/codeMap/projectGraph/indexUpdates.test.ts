import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getCodeIndex, peekCodeIndex, invalidateIndex, markIndexDirty,
  registerWatcherSubscriber, fileFunctionsForBrowse, callersFromIndex,
  ensureCodeIndex, evictIdleCodeIndexes, INDEX_IDLE_MS,
} from './codeIndex';
import { diffIndexFiles, INDEX_SOURCE_LIMIT_BYTES } from './indexFiles';
import { GET as callersGET } from '../../api/projectGraph/callers';
import { GET as functionsGET } from '../../api/projectGraph/file-functions';
import { getHandler } from '../handlers';
import { subscribeBuildProgress } from './buildProgress';

let cwd: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (p: string, source: string) => fs.writeFile(path.join(cwd, p), source);
const leaf = 'export function leaf() {}\n';
const caller = "import { leaf } from './leaf';\nexport function caller() { leaf(); }\n";

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(tmpdir(), 'cg-updates-'));
  git('init', '-q');
  await write('leaf.ts', leaf);
  await write('caller.ts', caller);
});
afterEach(async () => {
  vi.restoreAllMocks();
  invalidateIndex(cwd);
  registerWatcherSubscriber(null);
  await fs.rm(cwd, { recursive: true, force: true });
});

/** Pause after a real read, allowing assertions against an in-flight snapshot. */
function holdSourceRead(failSibling?: () => void) {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const read = fs.readFile.bind(fs);
  let held = false;
  vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (failSibling && String(args[0]) === path.join(cwd, 'caller.ts')) {
      await reached;
      failSibling();
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    const result = await read(...args);
    if (!held && String(args[0]) === path.join(cwd, 'leaf.ts')) {
      held = true; entered(); await gate;
    }
    return result;
  }) as typeof fs.readFile);
  return { reached, release };
}

describe('project index updates', () => {
  it('finds untracked additions, tracked disk deletions and renames without events', async () => {
    git('add', '.');
    const first = await getCodeIndex(cwd);
    await write('new.ts', 'export function added() {}');
    await fs.rename(path.join(cwd, 'caller.ts'), path.join(cwd, 'renamed.ts'));
    await fs.unlink(path.join(cwd, 'leaf.ts'));
    const next = await getCodeIndex(cwd);
    expect([...next.files.keys()]).toEqual(['new.ts', 'renamed.ts']);
    expect([...first.files.keys()]).toEqual(['caller.ts', 'leaf.ts']);
    expect(next.update?.changedFiles).toBe(4);
  });

  it('checks content when timestamps are preserved, reuses facts, and updates both edge directions', async () => {
    const first = await getCodeIndex(cwd);
    const stat = await fs.stat(path.join(cwd, 'leaf.ts'));
    await write('leaf.ts', 'export function gone() {}\n');
    await fs.utimes(path.join(cwd, 'leaf.ts'), stat.atime, stat.mtime);
    const next = await getCodeIndex(cwd);
    expect(next.update).toMatchObject({ parsedFiles: 1, changedFiles: 1 });
    expect(next.files.get('caller.ts')?.outgoingCalls).toEqual([]);
    expect(next.files.get('leaf.ts')?.incomingCalls).toEqual([]);
    expect(first.files.get('leaf.ts')?.incomingCalls).toHaveLength(1);
    expect(await getCodeIndex(cwd)).toBe(next);
    await write('leaf.ts', leaf);
    const restored = await getCodeIndex(cwd);
    expect(restored.files.get('leaf.ts')?.incomingCalls).toHaveLength(1);
    expect(callersFromIndex(restored, 'leaf', 'leaf.ts').callers).toHaveLength(1);
  });

  it('coalesces events without doing IO until a query', async () => {
    const first = await getCodeIndex(cwd);
    const spy = vi.spyOn(fs, 'readFile');
    for (let i = 0; i < 100; i++) markIndexDirty(cwd);
    expect(peekCodeIndex(cwd)).toBe(first);
    expect(spy).not.toHaveBeenCalled();
    expect(await getCodeIndex(cwd)).toBe(first);
  });

  it('shares a scan and carries events arriving during that scan into the next query', async () => {
    const first = await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const updating = getCodeIndex(cwd);
    await hold.reached;
    expect(peekCodeIndex(cwd)).toBe(first);
    await write('leaf.ts', 'export function replaced() {}\n');
    markIndexDirty(cwd);
    const waiting = getCodeIndex(cwd);
    hold.release();
    expect(await updating).toBe(first);
    const latest = await waiting;
    expect(latest.files.get('leaf.ts')?.flatSymbols[0].name).toBe('replaced');
    expect(first.files.get('leaf.ts')?.flatSymbols[0].name).toBe('leaf');
  });

  it('prevents invalidated in-flight work from writing back and recovers on the next query', async () => {
    await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const old = getCodeIndex(cwd).then(() => 'published', () => 'superseded');
    await hold.reached;
    invalidateIndex(cwd);
    expect(peekCodeIndex(cwd)).toBeNull();
    hold.release();
    expect(await old).toBe('superseded');
    expect(peekCodeIndex(cwd)).toBeNull();
    expect((await getCodeIndex(cwd)).files.size).toBe(2);
  });

  it('serializes force rebuild behind old work and reparses unchanged files', async () => {
    await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const old = getCodeIndex(cwd).then(() => 'published', () => 'superseded');
    await hold.reached;
    const forced = getCodeIndex(cwd, { forceRefresh: true });
    hold.release();
    expect(await old).toBe('superseded');
    expect((await forced).update).toMatchObject({ mode: 'rebuild', parsedFiles: 2 });
  });

  it('allows a query immediately after invalidation while the old task is still running', async () => {
    await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const old = getCodeIndex(cwd).then(() => 'published', () => 'superseded');
    await hold.reached;
    invalidateIndex(cwd);
    const next = getCodeIndex(cwd);
    hold.release();
    expect(await old).toBe('superseded');
    expect((await next).files.size).toBe(2);
    expect(peekCodeIndex(cwd)).not.toBeNull();
  });

  it('never gives ordinary waiters the conflict snapshot requested by an explicit rebuild', async () => {
    await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const old = getCodeIndex(cwd).then(() => 'published', () => 'superseded');
    await hold.reached;
    const ordinary = getCodeIndex(cwd);
    const rejection = expect(ordinary).rejects.toMatchObject({ message: expect.stringContaining('Workspace is changing') });
    await fs.mkdir(path.join(cwd, '.git/rebase-merge'));
    const forced = getCodeIndex(cwd, { forceRefresh: true });
    hold.release();
    expect(await old).toBe('superseded');
    await rejection;
    expect((await forced).files.size).toBe(2);
  });

  it('does not rebuild unchanged workspace content just because a commit moved HEAD', async () => {
    const first = await getCodeIndex(cwd);
    git('add', '.');
    git('-c', 'user.name=Index Test', '-c', 'user.email=index@example.test', 'commit', '-qm', 'base');
    expect(await getCodeIndex(cwd)).toBe(first);
  });

  it('keeps the successful baseline after a read failure and retries without another event', async () => {
    const first = await getCodeIndex(cwd);
    const read = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(cwd, 'leaf.ts')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(...args);
    }) as typeof fs.readFile);
    await expect(getCodeIndex(cwd)).rejects.toMatchObject({ _tag: 'FSError' });
    expect(peekCodeIndex(cwd)).toBe(first);
    spy.mockRestore();
    expect(await fileFunctionsForBrowse(cwd, 'caller.ts')).toMatchObject({
      indexUpdateError: 'denied', crossFileStale: true, crossFilePending: false,
    });
    await write('leaf.ts', 'export function recovered() {}');
    expect((await getCodeIndex(cwd)).files.get('leaf.ts')?.flatSymbols[0].name).toBe('recovered');
    expect(await fileFunctionsForBrowse(cwd, 'caller.ts')).toMatchObject({
      indexUpdateError: undefined, crossFileStale: false, crossFilePending: false,
    });
  });

  it('marks an unchanged focal file pending during a no-event project update, then serves the new relations', async () => {
    const first = await getCodeIndex(cwd);
    await write('caller.ts', 'export function caller() {}');
    const hold = holdSourceRead();
    const updating = getCodeIndex(cwd);
    await hold.reached;
    try {
      const response = await functionsGET(new Request(`http://localhost/api/projectGraph/file-functions?cwd=${encodeURIComponent(cwd)}&path=leaf.ts`));
      expect(await response.json()).toMatchObject({
        crossFileRevision: first.revision, crossFilePending: true, crossFileStale: true,
        upstreamCalls: [expect.anything()],
      });
    } finally { hold.release(); }
    const next = await updating;
    expect(await fileFunctionsForBrowse(cwd, 'leaf.ts')).toMatchObject({
      crossFileRevision: next.revision, crossFilePending: false, crossFileStale: false, upstreamCalls: [],
    });
  });

  it('uses a revision published while browsing awaits the focal file read', async () => {
    const first = await getCodeIndex(cwd);
    const hold = holdSourceRead();
    const browsing = fileFunctionsForBrowse(cwd, 'leaf.ts');
    await hold.reached;
    await write('caller.ts', 'export function caller() {}');
    try {
      const next = await getCodeIndex(cwd);
      expect(next).not.toBe(first);
      hold.release();
      expect(await browsing).toMatchObject({ crossFileRevision: next.revision, crossFilePending: false, upstreamCalls: [] });
    } finally { hold.release(); }
  });

  it('records failure before emitting done and never resurrects diagnostics after invalidation', async () => {
    await getCodeIndex(cwd);
    const read = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(cwd, 'leaf.ts')) throw Object.assign(new Error('query denied'), { code: 'EACCES' });
      return read(...args);
    }) as typeof fs.readFile);
    let response: ReturnType<typeof fileFunctionsForBrowse> | undefined;
    const off = subscribeBuildProgress(cwd, (event) => {
      if (event.phase === 'done') response = fileFunctionsForBrowse(cwd, 'caller.ts');
    });
    try {
      await expect(getCodeIndex(cwd)).rejects.toMatchObject({ _tag: 'FSError' });
      expect(await response).toMatchObject({ indexUpdateError: 'query denied', crossFilePending: false });
    } finally { off(); spy.mockRestore(); }
    const hold = holdSourceRead();
    ensureCodeIndex(cwd, { forceRefresh: true });
    await hold.reached;
    invalidateIndex(cwd);
    hold.release();
    // Wait for the superseded owner and its fire-and-forget catch to finish.
    await getCodeIndex(cwd);
    expect(await fileFunctionsForBrowse(cwd, 'caller.ts')).toMatchObject({ indexUpdateError: undefined });
  });

  it('drains sibling reads before releasing a failed update task', async () => {
    await getCodeIndex(cwd);
    let signalFailure!: () => void;
    const failed = new Promise<void>((resolve) => { signalFailure = resolve; });
    const hold = holdSourceRead(signalFailure);
    let settled = false;
    const task = getCodeIndex(cwd).finally(() => { settled = true; });
    const rejected = expect(task).rejects.toMatchObject({ _tag: 'FSError' });
    await failed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    hold.release();
    await rejected;
  });

  it('excludes tracked node_modules and resources while retaining test sources', async () => {
    await fs.mkdir(path.join(cwd, 'node_modules'));
    await write('node_modules/noise.ts', leaf);
    await write('.gitignore', 'ignored.ts\n');
    await write('ignored.ts', leaf);
    await write('leaf.test.ts', leaf);
    await write('asset.bin', 'resource');
    git('add', '-f', 'node_modules/noise.ts');
    const index = await getCodeIndex(cwd);
    expect([...index.files.keys()]).toEqual(['caller.ts', 'leaf.test.ts', 'leaf.ts']);
  });

  it('preserves whitespace and Unicode characters in Git paths', async () => {
    await write(' spaced file.ts', leaf);
    await write('文件.ts', leaf);
    const index = await getCodeIndex(cwd);
    expect(index.files.has(' spaced file.ts')).toBe(true);
    expect(index.files.has('文件.ts')).toBe(true);
  });

  // Windows rejects control characters in file names before Git can list them.
  it.skipIf(process.platform === 'win32')('preserves newlines in Git paths on supported filesystems', async () => {
    await write('line\nbreak.ts', leaf);
    const index = await getCodeIndex(cwd);
    expect(index.files.has('line\nbreak.ts')).toBe(true);
  });

  it('reloads aliases on configuration changes without reparsing unchanged sources', async () => {
    await write('caller.ts', "import { leaf } from '@/leaf';\nexport function caller() { leaf(); }\n");
    await write('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["./*"]}}}');
    expect((await getCodeIndex(cwd)).files.get('leaf.ts')?.incomingCalls).toHaveLength(1);
    await write('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["missing/*"]}}}');
    const changed = await getCodeIndex(cwd);
    expect(changed.update).toMatchObject({ mode: 'rebuild', parsedFiles: 0 });
    expect(changed.files.get('leaf.ts')?.incomingCalls).toEqual([]);
  });

  it.each([{ workspaces: ['packages/*'] }, { workspaces: { packages: ['packages/*'] } }])('resolves package.json workspaces without pnpm config: %j', async ({ workspaces }) => {
    await fs.mkdir(path.join(cwd, 'packages/lib'), { recursive: true });
    await write('package.json', JSON.stringify({ workspaces }));
    await write('packages/lib/package.json', JSON.stringify({ name: '@probe/lib', exports: './index.ts' }));
    await write('packages/lib/index.ts', leaf);
    await write('caller.ts', "import { leaf } from '@probe/lib';\nexport function caller() { leaf(); }\n");
    const index = await getCodeIndex(cwd);
    expect(index.workspaces.has('@probe/lib')).toBe(true);
    expect(callersFromIndex(index, 'leaf', 'packages/lib/index.ts').callers).toHaveLength(1);
    await write('pnpm-workspace.yaml', 'packages: []\n');
    expect((await getCodeIndex(cwd)).workspaces.size).toBe(0);
    await fs.unlink(path.join(cwd, 'pnpm-workspace.yaml'));
    expect((await getCodeIndex(cwd)).workspaces.has('@probe/lib')).toBe(true);
  });

  it('lets an event-loop callback run between parsing batches before the resolving phase', async () => {
    await Promise.all(Array.from({ length: 120 }, (_, i) => write(`batch${i}.ts`, leaf)));
    const handler = getHandler('typescript');
    const extract = handler.extractSymbols.bind(handler);
    let parsed = 0;
    let observedAt: number | undefined;
    let callback: ReturnType<typeof setImmediate> | undefined;
    vi.spyOn(handler, 'extractSymbols').mockImplementation((...args) => {
      if (parsed++ === 0) callback = setImmediate(() => { observedAt = parsed; });
      // Deterministically exhaust the batch time budget on a few files.
      const start = performance.now();
      while (performance.now() - start < 1) { /* simulate synchronous extraction */ }
      return extract(...args);
    });
    let observedBeforeResolving = false;
    const off = subscribeBuildProgress(cwd, (event) => {
      if (event.phase === 'resolving') observedBeforeResolving = observedAt !== undefined;
    });
    try {
      const index = await getCodeIndex(cwd);
      expect(observedBeforeResolving).toBe(true);
      expect(observedAt).toBeGreaterThan(0);
      expect(observedAt).toBeLessThan(index.files.size);
      expect(index.files.size).toBe(122);
    } finally { off(); if (callback) clearImmediate(callback); }
  });

  it('resolves contexts from the configuration actually fingerprinted by the scan', async () => {
    const config = '{"compilerOptions":{"paths":{"@/*":["./*"]}}}';
    await write('caller.ts', "import { leaf } from '@/leaf';\nexport function caller() { leaf(); }\n");
    await write('tsconfig.json', config);
    const handler = getHandler('typescript');
    const original = handler.buildProjectContext.bind(handler);
    vi.spyOn(handler, 'buildProjectContext').mockImplementationOnce(async (...args) => {
      await write('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["missing/*"]}}}');
      return original(...args);
    });
    const first = await getCodeIndex(cwd);
    expect(first.files.get('leaf.ts')?.incomingCalls).toHaveLength(1);
    await write('tsconfig.json', config);
    expect(await getCodeIndex(cwd)).toBe(first);
  });

  it('builds Go and Rust context-dependent relations from captured project files', async () => {
    await write('go.mod', 'module example.test/demo\n');
    await write('main.go', 'package main\nfunc Leaf() {}\nfunc Caller() { Leaf() }\n');
    await fs.mkdir(path.join(cwd, 'src'));
    await write('src/lib.rs', 'mod leaf;\nuse crate::leaf::target;\npub fn caller() { target(); }\n');
    await write('src/leaf.rs', 'pub fn target() {}\n');
    const index = await getCodeIndex(cwd);
    expect(index.files.get('main.go')?.intraCalls).toEqual([expect.objectContaining({ from: 'Caller', to: 'Leaf' })]);
    expect(index.files.get('src/leaf.rs')?.incomingCalls).toHaveLength(1);
  });

  it('marks oversized coverage incomplete and reuses an unchanged incomplete revision', async () => {
    await write('huge.ts', ' '.repeat(INDEX_SOURCE_LIMIT_BYTES + 1));
    const first = await getCodeIndex(cwd);
    expect(first.truncated).toBe(true);
    expect(first.files.has('huge.ts')).toBe(false);
    expect(await getCodeIndex(cwd)).toBe(first);
  });

  it('refreshes a focal file without mutating or rebuilding the project snapshot', async () => {
    const first = await getCodeIndex(cwd);
    await write('leaf.ts', 'export function browsed() {}');
    const local = await fileFunctionsForBrowse(cwd, 'leaf.ts');
    expect(local).toMatchObject({ crossFileStale: true, functions: [expect.objectContaining({ name: 'browsed' })] });
    expect(peekCodeIndex(cwd)).toBe(first);
    expect(first.files.get('leaf.ts')?.flatSymbols[0].name).toBe('leaf');
  });

  it('releases subscriptions on invalidation and re-establishes them on demand', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    registerWatcherSubscriber(subscribe);
    await getCodeIndex(cwd);
    invalidateIndex(cwd);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await getCodeIndex(cwd);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('releases the project subscription on idle eviction too', async () => {
    const unsubscribe = vi.fn();
    registerWatcherSubscriber(() => unsubscribe);
    await getCodeIndex(cwd);
    expect(evictIdleCodeIndexes(Date.now() + INDEX_IDLE_MS + 1)).toContain(cwd);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(peekCodeIndex(cwd)).toBeNull();
  });

  it('surfaces explicit rebuild failures to file browsing without an automatic retry loop', async () => {
    await getCodeIndex(cwd);
    const read = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === path.join(cwd, 'leaf.ts')) throw Object.assign(new Error('rebuild denied'), { code: 'EACCES' });
      return read(...args);
    }) as typeof fs.readFile);
    ensureCodeIndex(cwd, { forceRefresh: true });
    await expect(getCodeIndex(cwd)).rejects.toMatchObject({ _tag: 'FSError' });
    spy.mockRestore();
    const response = await fileFunctionsForBrowse(cwd, 'caller.ts');
    expect(response).toMatchObject({ indexUpdateError: 'rebuild denied', crossFilePending: false });
    expect(peekCodeIndex(cwd)).not.toBeNull();
  });

  it('rejects non-Git projects rather than walking them', async () => {
    await fs.rm(path.join(cwd, '.git'), { recursive: true });
    await expect(getCodeIndex(cwd)).rejects.toMatchObject({ _tag: 'ValidationError', reason: 'Non-Git projects are not supported' });
  });

  it('serves fresh caller results through the real route and exposes unsupported project errors', async () => {
    const url = `http://localhost/api/projectGraph/callers?cwd=${encodeURIComponent(cwd)}&qname=leaf&filePath=leaf.ts`;
    const first = await callersGET(new Request(url));
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Code-Index-Incomplete')).toBe('0');
    expect(Number(first.headers.get('X-Code-Index-Revision'))).toBeGreaterThan(0);
    expect((await first.json()).callers).toHaveLength(1);
    await write('caller.ts', 'export function caller() {}');
    const next = await callersGET(new Request(url));
    expect(next.status).toBe(200);
    expect((await next.json()).callers).toEqual([]);
    await fs.rm(path.join(cwd, '.git'), { recursive: true });
    const invalid = await callersGET(new Request(url));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('Non-Git projects are not supported') });
  });

  it('reports incomplete coverage through the real query route', async () => {
    await write('huge.ts', ' '.repeat(INDEX_SOURCE_LIMIT_BYTES + 1));
    const response = await callersGET(new Request(`http://localhost/api/projectGraph/callers?cwd=${encodeURIComponent(cwd)}&qname=leaf`));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Code-Index-Incomplete')).toBe('1');
  });

  it('returns local updated content through the file route without mutating the shared revision', async () => {
    const first = await getCodeIndex(cwd);
    await write('leaf.ts', 'export function fresh() {}');
    const response = await functionsGET(new Request(`http://localhost/api/projectGraph/file-functions?cwd=${encodeURIComponent(cwd)}&path=leaf.ts`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ crossFileStale: true, functions: [expect.objectContaining({ name: 'fresh' })] });
    expect(peekCodeIndex(cwd)).toBe(first);
  });

  it('queries project relations on graph open and verifies no-event edits on subsequent graph reads', async () => {
    const url = `http://localhost/api/projectGraph/file-functions?cwd=${encodeURIComponent(cwd)}&path=leaf.ts&relations=1`;
    const first = await functionsGET(new Request(url));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ crossFilePending: false, upstreamCalls: [expect.anything()] });
    const baseline = peekCodeIndex(cwd)!;
    await write('caller.ts', 'export function caller() {}');
    const next = await functionsGET(new Request(url));
    expect(await next.json()).toMatchObject({ crossFilePending: false, upstreamCalls: [] });
    expect(peekCodeIndex(cwd)!.revision).not.toBe(baseline.revision);
    expect(peekCodeIndex(cwd)!.update?.parsedFiles).toBe(1);
    const forced = await functionsGET(new Request(`${url}&refresh=1`));
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ crossFilePending: false, upstreamCalls: [] });
    expect(peekCodeIndex(cwd)!.update).toMatchObject({ mode: 'rebuild', parsedFiles: 2 });
  });

  it('handles real rebase conflicts, explicit conflict inspection and completion in a linked worktree', async () => {
    const commit = (message: string) => git('-c', 'user.name=Index Test', '-c', 'user.email=index@example.test', 'commit', '-qm', message);
    git('add', '.'); commit('base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'upstream');
    await write('leaf.ts', 'export function upstream() {}\n');
    git('add', '.'); commit('upstream');
    git('checkout', '-qb', 'topic', base);
    await write('leaf.ts', 'export function topic() {}\n');
    git('add', '.'); commit('topic');
    const worktree = `${cwd}-linked`;
    git('worktree', 'add', '-q', '--detach', worktree, 'topic');
    const workGit = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8', stdio: 'pipe' });
    try {
      await getCodeIndex(worktree);
      expect(() => workGit('-c', 'user.name=Index Test', '-c', 'user.email=index@example.test', 'rebase', 'upstream')).toThrow();
      await expect(getCodeIndex(worktree)).rejects.toMatchObject({ message: expect.stringContaining('Workspace is changing') });
      const conflict = await getCodeIndex(worktree, { forceRefresh: true });
      expect(conflict.update?.mode).toBe('rebuild');
      await expect(getCodeIndex(worktree)).rejects.toMatchObject({ message: expect.stringContaining('Workspace is changing') });
      workGit('rebase', '--abort');
      const done = await getCodeIndex(worktree);
      expect(done.update?.mode).toBe('rebuild');
      expect(done.files.get('leaf.ts')?.flatSymbols[0].name).toBe('topic');
      workGit('checkout', '--detach', 'upstream');
      const switched = await getCodeIndex(worktree);
      expect(switched.update?.mode).toBe('rebuild');
      expect(switched.files.get('leaf.ts')?.flatSymbols[0].name).toBe('upstream');
    } finally {
      invalidateIndex(worktree);
      git('worktree', 'remove', '--force', worktree);
    }
  });
});

describe('full rebuild thresholds', () => {
  const manifest = (n: number) => new Map(Array.from({ length: n }, (_, i) => [`${i}.ts`, 'same']));
  const changed = (n: number, d: number) => {
    const after = manifest(n);
    for (let i = 0; i < d; i++) after.set(`${i}.ts`, 'changed');
    return diffIndexFiles(manifest(n), after);
  };
  it('uses actual unique changes and both absolute and proportional boundaries', () => {
    expect(changed(5000, 499).rebuild).toBe(false);
    expect(changed(5000, 500).rebuild).toBe(true);
    expect(changed(100, 19).rebuild).toBe(false);
    expect(changed(100, 20).rebuild).toBe(true);
    expect(changed(101, 20).rebuild).toBe(false);
    expect(changed(5000, 0).count).toBe(0);
  });
});
