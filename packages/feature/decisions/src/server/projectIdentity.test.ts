import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

// paths.ts resolves COCKPIT_DIR once at module load — redirect it first.
const root = mkdtempSync(join(tmpdir(), 'cockpit-decisions-id-'));
process.env.COCKPIT_HOME = join(root, 'home');

let id: typeof import('./projectIdentity');
beforeAll(async () => {
  id = await import('./projectIdentity');
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString().trim();

function makeRepo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'a.txt'), name); // distinct root commit per repo
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);

describe('decision project identity', () => {
  it('keys a git checkout by its root commit, shared by worktrees', async () => {
    const repo = makeRepo('wt-main');
    const rootCommit = git(repo, 'rev-list', '--max-parents=0', 'HEAD');
    const wt = join(root, 'wt-linked');
    git(repo, 'worktree', 'add', '-q', wt);

    const a = await run(id.resolveProject(repo));
    const b = await run(id.resolveProject(wt));
    expect(a).toMatchObject({ status: 'resolved', kind: 'git', projectId: `git-${rootCommit}`, enabled: false });
    expect(b).toMatchObject({ status: 'resolved', projectId: `git-${rootCommit}` });
  });

  it('follows a moved checkout without asking', async () => {
    const repo = makeRepo('move-src');
    const before = await run(id.resolveProject(repo));
    const moved = join(root, 'move-dst');
    renameSync(repo, moved);
    const after = await run(id.resolveProject(moved));
    expect(after).toMatchObject({ status: 'resolved', projectId: (before as { projectId: string }).projectId });
  });

  it('asks when a second live clone shares the root commit, and binds on request', async () => {
    const repo = makeRepo('clone-src');
    const first = (await run(id.resolveProject(repo))) as { projectId: string };
    const clone = join(root, 'clone-copy');
    git(root, 'clone', '-q', repo, clone);

    const r = await run(id.resolveProject(clone));
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') return;
    expect(r.candidates.map((c) => c.projectId)).toEqual([first.projectId]);

    // Unbound until the user chooses: enabling is refused.
    const refused = await Effect.runPromiseExit(id.setEnabled(clone, true));
    expect(refused._tag).toBe('Failure');

    const separate = await run(id.bindProject(clone, 'new'));
    expect(separate.projectId).not.toBe(first.projectId);
    expect(separate.projectId.startsWith(`${first.projectId}-`)).toBe(true);
    expect(await run(id.resolveProject(clone))).toMatchObject({ status: 'resolved', projectId: separate.projectId });

    // Joining must name a project with the same root commit.
    const bogus = await Effect.runPromiseExit(id.bindProject(clone, 'git-deadbeef'));
    expect(bogus._tag).toBe('Failure');
  });

  it('can join the existing project instead', async () => {
    const repo = makeRepo('join-src');
    const first = (await run(id.resolveProject(repo))) as { projectId: string };
    const clone = join(root, 'join-copy');
    git(root, 'clone', '-q', repo, clone);
    expect((await run(id.resolveProject(clone))).status).toBe('ambiguous');
    const joined = await run(id.bindProject(clone, first.projectId));
    expect(joined.projectId).toBe(first.projectId);
  });

  it('falls back to a path key outside git', async () => {
    const dir = join(root, 'plain');
    mkdirSync(dir);
    const a = await run(id.resolveProject(dir));
    const b = await run(id.resolveProject(dir));
    expect(a).toMatchObject({ status: 'resolved', kind: 'path' });
    expect((a as { projectId: string }).projectId).toMatch(/^path-[0-9a-f]{16}$/);
    expect(a).toEqual(b);
  });

  it('switch: on stamps enabledAt once, off keeps it, project-wide', async () => {
    const repo = makeRepo('switch');
    const wt = join(root, 'switch-wt');
    git(repo, 'worktree', 'add', '-q', wt);

    const on = await run(id.setEnabled(repo, true));
    expect(on.enabled).toBe(true);
    expect(typeof on.enabledAt).toBe('number');
    const again = await run(id.setEnabled(wt, true));
    expect(again.enabledAt).toBe(on.enabledAt);

    const off = await run(id.setEnabled(wt, false));
    expect(off.enabled).toBe(false);
    expect(await run(id.resolveProject(repo))).toMatchObject({ enabled: false, enabledAt: on.enabledAt });
  });
});
