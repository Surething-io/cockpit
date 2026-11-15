import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getCodeIndex, invalidateIndex, peekCodeIndex, callersFromIndex,
  MAX_CACHED_BYTES, __indexCacheTesting as cache,
} from './codeIndex';
import { readGitIndexState } from './indexFiles';
import { getHandler } from '../handlers';

let base: string, a: string, b: string;
const leaf = 'export function leaf() {}\n';
const caller = "import { leaf } from './leaf';\nexport function caller() { leaf(); }\n";
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (cwd: string, file: string, source: string) => fs.writeFile(path.join(cwd, file), source);

function pauseFinalGitCheck(): { reached: Promise<void>; release: () => void } {
  let enter!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const realpath = fs.realpath.bind(fs);
  let calls = 0;
  vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
    const value = await realpath(...args);
    if (++calls === 2) { enter(); await gate; }
    return value;
  }) as typeof fs.realpath);
  return { reached, release };
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(tmpdir(), 'cg-sharing-'));
  a = path.join(base, 'main');
  b = path.join(base, 'worktree');
  await fs.mkdir(a);
  git(a, 'init', '-q');
  await write(a, 'leaf.ts', leaf);
  await write(a, 'caller.ts', caller);
  git(a, 'add', '.');
  git(a, '-c', 'user.name=Code Index Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture');
  git(a, 'worktree', 'add', '-q', '--detach', b, 'HEAD');
});

afterEach(async () => {
  vi.restoreAllMocks();
  invalidateIndex();
  await fs.rm(base, { recursive: true, force: true });
});

describe('worktree index sharing', () => {
  it('reuses parsing, lookup maps and complete relations while keeping worktree metadata local', async () => {
    const first = await getCodeIndex(a);
    const spy = vi.spyOn(getHandler('typescript'), 'extractSymbols');
    await fs.utimes(path.join(b, 'leaf.ts'), 2_000_000_000, 2_000_000_000);
    const second = await getCodeIndex(b);
    expect(spy).not.toHaveBeenCalled();
    expect(second.update?.parsedFiles).toBe(0);
    expect(second).not.toBe(first);
    expect(second.files).not.toBe(first.files);
    expect(second.fileSet).not.toBe(first.fileSet);
    expect(second.projectContexts).not.toBe(first.projectContexts);
    for (const p of first.files.keys()) {
      const fa = first.files.get(p)!, fb = second.files.get(p)!;
      expect(fa).not.toBe(fb);
      for (const key of [
        'symbolsTree', 'flatSymbols', 'literals', 'importBindings',
        'symbolsByName', 'symbolsByQname', 'bindingsByLocalName', 'reexportsByLocalName',
        'resolvedImports', 'importedFiles', 'importedBy', 'intraCalls',
        'outgoingCalls', 'incomingCalls', 'externalCalls', 'methodCalls',
      ] as const) expect(fb[key], `${p}.${key}`).toBe(fa[key]);
    }
    expect(second.files.get('leaf.ts')!.mtime).not.toBe(first.files.get('leaf.ts')!.mtime);
    expect((await readGitIndexState(a)).commonDir).toBe((await readGitIndexState(b)).commonDir);
    expect(cache.sharingStats()).toMatchObject({ roots: 2, repositories: 1, parses: 2, relations: 2 });
  });

  it('recomputes incoming relations for identical source when another worktree changes its caller', async () => {
    const first = await getCodeIndex(a);
    const originalB = await getCodeIndex(b);
    await write(b, 'caller.ts', "import { leaf } from './leaf';\nexport function caller() {}\n");
    const next = await getCodeIndex(b);
    expect(next.revision).toBe(2);
    expect(next.update?.parsedFiles).toBe(1);
    expect(next.files.get('leaf.ts')!.flatSymbols).toBe(first.files.get('leaf.ts')!.flatSymbols);
    expect(next.files.get('leaf.ts')!.incomingCalls).toEqual([]);
    expect(next.files.get('leaf.ts')!.incomingCalls).not.toBe(first.files.get('leaf.ts')!.incomingCalls);
    expect(callersFromIndex(first, 'leaf', 'leaf.ts').callers).toHaveLength(1);
    expect(callersFromIndex(originalB, 'leaf', 'leaf.ts').callers).toHaveLength(1);
    expect(callersFromIndex(next, 'leaf', 'leaf.ts').callers).toHaveLength(0);
    expect(await getCodeIndex(a)).toBe(first);
    await write(b, 'caller.ts', caller);
    const restored = await getCodeIndex(b);
    expect(restored.update?.parsedFiles).toBe(0);
    expect(restored.files.get('leaf.ts')!.incomingCalls).toBe(first.files.get('leaf.ts')!.incomingCalls);
    expect(cache.sharingStats()).toMatchObject({ parses: 2, relations: 2 });
  });

  it('resolves configuration changes independently despite shared source facts', async () => {
    for (const cwd of [a, b]) {
      await write(cwd, 'other.ts', leaf);
      await write(cwd, 'caller.ts', "import { leaf } from '@target';\nexport function caller() { leaf(); }\n");
      await write(cwd, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': ['./leaf.ts'] } } }));
    }
    const first = await getCodeIndex(a);
    await write(b, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@target': ['./other.ts'] } } }));
    const second = await getCodeIndex(b);
    expect(second.update?.parsedFiles).toBe(0);
    expect(second.files.get('caller.ts')!.flatSymbols).toBe(first.files.get('caller.ts')!.flatSymbols);
    expect(first.files.get('caller.ts')!.resolvedImports.get('@target')).toBe('leaf.ts');
    expect(second.files.get('caller.ts')!.resolvedImports.get('@target')).toBe('other.ts');
    expect(first.files.get('leaf.ts')!.incomingCalls).toHaveLength(1);
    expect(second.files.get('leaf.ts')!.incomingCalls).toHaveLength(0);
    expect(second.files.get('other.ts')!.incomingCalls).toHaveLength(1);
    expect(second.files.get('leaf.ts')!.flatSymbols).not.toBe(second.files.get('other.ts')!.flatSymbols);
  });

  it('keeps file membership and later rebuilds isolated', async () => {
    const first = await getCodeIndex(a);
    await getCodeIndex(b);
    await fs.unlink(path.join(b, 'leaf.ts'));
    const second = await getCodeIndex(b);
    expect(second.files.has('leaf.ts')).toBe(false);
    expect(second.files.get('caller.ts')!.outgoingCalls).toEqual([]);
    expect(first.files.get('caller.ts')!.outgoingCalls).toHaveLength(1);
    await write(a, 'leaf.ts', 'export function replacement() {}\n');
    const nextA = await getCodeIndex(a);
    expect(nextA.files.get('caller.ts')!.outgoingCalls).toEqual([]);
    expect(peekCodeIndex(b)).toBe(second);
    expect(first.files.get('caller.ts')!.outgoingCalls).toHaveLength(1);
  });

  it('keeps identical files from unrelated repositories in separate pools', async () => {
    const c = path.join(base, 'unrelated');
    await fs.mkdir(c);
    git(c, 'init', '-q');
    await write(c, 'leaf.ts', leaf);
    await write(c, 'caller.ts', caller);
    const first = await getCodeIndex(a), second = await getCodeIndex(c);
    expect(second.update?.parsedFiles).toBe(2);
    expect(second.files.get('leaf.ts')!.flatSymbols).not.toBe(first.files.get('leaf.ts')!.flatSymbols);
    expect(second.files.get('leaf.ts')!.incomingCalls).not.toBe(first.files.get('leaf.ts')!.incomingCalls);
    expect(cache.sharingStats()).toMatchObject({ repositories: 2, parses: 4, relations: 4 });
  });

  it('transfers ownership when a cwd now belongs to a different repository', async () => {
    const first = await getCodeIndex(a);
    await getCodeIndex(b);
    await fs.unlink(path.join(b, '.git'));
    git(b, 'init', '-q');
    const replacement = await getCodeIndex(b);
    expect(replacement.update?.parsedFiles).toBe(2);
    expect(replacement.files.get('leaf.ts')!.flatSymbols).not.toBe(first.files.get('leaf.ts')!.flatSymbols);
    expect(cache.sharingStats()).toMatchObject({ roots: 2, repositories: 2, parses: 4, relations: 4 });
    invalidateIndex(b);
    expect(cache.sharingStats()).toMatchObject({ roots: 1, repositories: 1, parses: 2, relations: 2 });
    expect(await getCodeIndex(a)).toBe(first);
  });

  it('deduplicates concurrent cold builds at publication and releases only the departing owner', async () => {
    const [first, second] = await Promise.all([getCodeIndex(a), getCodeIndex(b)]);
    expect(first.files.get('caller.ts')!.flatSymbols).toBe(second.files.get('caller.ts')!.flatSymbols);
    expect(first.files.get('leaf.ts')!.incomingCalls).toBe(second.files.get('leaf.ts')!.incomingCalls);
    expect(cache.sharingStats()).toMatchObject({ roots: 2, parses: 2, relations: 2 });
    invalidateIndex(a);
    expect(cache.sharingStats()).toMatchObject({ roots: 1, parses: 2, relations: 2 });
    expect(await getCodeIndex(b)).toBe(second);
    const rebuilt = await getCodeIndex(a);
    expect(rebuilt.update?.parsedFiles).toBe(0);
    invalidateIndex();
    expect(cache.sharingStats()).toEqual({ roots: 0, repositories: 0, parses: 0, relations: 0, estimatedBytes: 0 });
    expect(callersFromIndex(second, 'leaf', 'leaf.ts').callers).toHaveLength(1);
  });

  it('charges shared payloads once and retains them when budget eviction removes one worktree', async () => {
    await getCodeIndex(a);
    const bytesA = cache.estimatedBytes();
    const second = await getCodeIndex(b);
    expect(cache.estimatedBytes()).toBeLessThan(bytesA * 1.5);
    cache.evict(b, MAX_CACHED_BYTES);
    expect(peekCodeIndex(a)).toBeNull();
    expect(peekCodeIndex(b)).toBe(second);
    expect(cache.sharingStats()).toMatchObject({ roots: 1, parses: 2, relations: 2 });
    expect((await getCodeIndex(a)).update?.parsedFiles).toBe(0);
  });

  it('forces parsing but still interns equal results without changing the other worktree', async () => {
    const first = await getCodeIndex(a);
    await getCodeIndex(b);
    const forced = await getCodeIndex(b, { forceRefresh: true });
    expect(forced.update?.parsedFiles).toBe(2);
    expect(forced.files.get('leaf.ts')!.flatSymbols).toBe(first.files.get('leaf.ts')!.flatSymbols);
    expect(forced.files.get('leaf.ts')!.incomingCalls).toBe(first.files.get('leaf.ts')!.incomingCalls);
    expect(peekCodeIndex(a)).toBe(first);
    expect(cache.sharingStats()).toMatchObject({ roots: 2, parses: 2, relations: 2 });
  });

  it('does not retain partial results when the final Git check fails, then recovers', async () => {
    await getCodeIndex(a);
    const previous = await getCodeIndex(b);
    const before = cache.sharingStats();
    await write(b, 'leaf.ts', 'export function replacement() {}\n');
    const realpath = fs.realpath.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'realpath').mockImplementation((async (...args: Parameters<typeof fs.realpath>) => {
      if (++calls === 2) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realpath(...args);
    }) as typeof fs.realpath);
    await expect(getCodeIndex(b)).rejects.toMatchObject({ _tag: 'FSError' });
    expect(peekCodeIndex(b)).toBe(previous);
    expect(cache.sharingStats()).toEqual(before);
    vi.restoreAllMocks();
    expect((await getCodeIndex(b)).files.get('leaf.ts')!.flatSymbols[0].name).toBe('replacement');
  });

  it('prevents a superseded build from retaining blocks after another owner has published', async () => {
    const first = await getCodeIndex(a);
    const hold = pauseFinalGitCheck();
    const old = getCodeIndex(b).then(() => 'published', () => 'superseded');
    await hold.reached;
    invalidateIndex(b);
    hold.release();
    expect(await old).toBe('superseded');
    expect(peekCodeIndex(b)).toBeNull();
    expect(cache.sharingStats()).toMatchObject({ roots: 1, parses: 2, relations: 2 });
    expect(peekCodeIndex(a)).toBe(first);
    expect((await getCodeIndex(b)).update?.parsedFiles).toBe(0);
  });

  it('can publish borrowed facts after the last previous owner is released during the build', async () => {
    const first = await getCodeIndex(a);
    const hold = pauseFinalGitCheck();
    const building = getCodeIndex(b);
    await hold.reached;
    invalidateIndex(a);
    expect(cache.sharingStats()).toMatchObject({ roots: 0, repositories: 0, parses: 0, relations: 0 });
    hold.release();
    const second = await building;
    expect(second.update?.parsedFiles).toBe(0);
    expect(second.files.get('leaf.ts')!.flatSymbols).toBe(first.files.get('leaf.ts')!.flatSymbols);
    expect(callersFromIndex(second, 'leaf', 'leaf.ts').callers).toHaveLength(1);
    expect(cache.sharingStats()).toMatchObject({ roots: 1, repositories: 1, parses: 2, relations: 2 });
  });

  it('releases empty roots without leaving an empty repository behind', async () => {
    for (const cwd of [a, b]) {
      await fs.unlink(path.join(cwd, 'leaf.ts'));
      await fs.unlink(path.join(cwd, 'caller.ts'));
    }
    await getCodeIndex(a);
    await getCodeIndex(b);
    expect(cache.sharingStats()).toMatchObject({ roots: 2, repositories: 1, parses: 0, relations: 0 });
    await getCodeIndex(a, { forceRefresh: true });
    invalidateIndex(a);
    expect(cache.sharingStats()).toMatchObject({ roots: 1, repositories: 1 });
    invalidateIndex(b);
    expect(cache.sharingStats()).toEqual({ roots: 0, repositories: 0, parses: 0, relations: 0, estimatedBytes: 0 });
  });
});
