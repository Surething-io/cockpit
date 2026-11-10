import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Decision } from '../shared/types';

const root = mkdtempSync(join(tmpdir(), 'cockpit-decisions-derived-'));
process.env.COCKPIT_HOME = join(root, 'home');

let derived: typeof import('./derived');
let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd: repo, stdio: 'pipe' }).toString().trim();
const blobOf = (content: string) => execFileSync('git', ['hash-object', '--stdin'], { input: content }).toString().trim();

const decision = (id: string, links: Decision['links'], over: Partial<Decision> = {}): Decision => ({
  id, choice: id, alternatives: [], rationale: '', tradeoffs: '', premises: [],
  source: { kind: 'manual' }, links, status: 'active', createdAt: 1, updatedAt: 1, revisions: 0, ...over,
});

beforeAll(async () => {
  derived = await import('./derived');
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git('init', '-q');
  writeFileSync(join(repo, 'src/a.ts'), 'a v1\n');
  writeFileSync(join(repo, 'src/b.ts'), 'b v1\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  // A change that only exists on another branch.
  git('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'src/a.ts'), 'a on feature\n');
  git('commit', '-qam', 'feature');
  git('checkout', '-q', 'main');
});

const P = 'git-derived';
const states = async (ds: Decision[]) => {
  const ctx = await Effect.runPromise(derived.derivedContext(P, repo, ds));
  return Promise.all(ds.map((d) => Effect.runPromise(derived.deriveState(d, ctx))));
};

describe('derived decision state', () => {
  it('applicable / other branch / not landed / link lost / lifecycle', async () => {
    writeFileSync(join(repo, 'src/b.ts'), 'b uncommitted\n');
    rmSync(join(repo, 'src/gone.ts'), { force: true });
    const ds = [
      decision('here', [{ path: 'src/a.ts', blob: blobOf('a v1\n') }]),
      decision('feature', [{ path: 'src/a.ts', blob: blobOf('a on feature\n') }]),
      decision('local', [{ path: 'src/b.ts', blob: blobOf('b uncommitted\n') }]),
      decision('lost', [{ path: 'src/gone.ts', blob: blobOf('x\n') }]),
      decision('manual', []),
      decision('old', [{ path: 'src/a.ts' }], { status: 'superseded' }),
    ];
    expect(await states(ds)).toEqual(['applicable', 'other-branch', 'not-landed', 'link-lost', 'applicable', 'superseded']);
  });

  it('a decision lands once its content is committed (cache does not pin "not found")', async () => {
    const d = decision('later', [{ path: 'src/b.ts', blob: blobOf('b uncommitted\n') }]);
    expect(await states([d])).toEqual(['not-landed']);
    git('commit', '-qam', 'commit b');
    expect(await states([d])).toEqual(['applicable']);
  });
});

describe('findTouched', () => {
  it('direct before neighbor, other-branch skipped, retired skipped, "unrelated" last', async () => {
    const ds = [
      decision('n', [{ path: 'src/b.ts' }]),
      decision('d-unrelated', [{ path: 'src/a.ts' }], { lastReview: { at: 1, taskId: 't', verdict: 'unrelated' } }),
      decision('d', [{ path: 'src/a.ts', blob: blobOf('a v1\n') }]),
      decision('branch', [{ path: 'src/a.ts', blob: blobOf('a on feature\n') }]),
      decision('retired', [{ path: 'src/a.ts' }], { status: 'retired' }),
      decision('far', [{ path: 'src/zzz.ts' }]),
    ];
    const t = await Effect.runPromise(derived.findTouched(P, repo, ds, new Set(['src/a.ts']), new Set(['src/b.ts'])));
    expect(t.map((x) => [x.decision.id, x.reason])).toEqual([
      ['d', 'direct'],
      ['d-unrelated', 'direct'],
      ['n', 'neighbor'],
    ]);
  });
});
