/**
 * Integration test for SnapshotServiceLive — real git, throwaway dirs.
 *
 * Exercises the full loop: baseline → tool commit → listByToolIds → diff,
 * plus skip-on-no-change, .gitignore inheritance, and concurrent-change
 * attribution (file changed alongside the declared one still lands in the
 * same commit).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, truncate, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { SnapshotService } from '@cockpit/effect-services';
import {
  SnapshotServiceLive,
  snapshotRepoDirName,
  notePendingRecord,
  settlePendingRecord,
} from './snapshotLive';

let home: string;
let work: string;
let runtime: ManagedRuntime.ManagedRuntime<SnapshotService, never>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-snap-home-'));
  work = await mkdtemp(join(tmpdir(), 'cockpit-snap-work-'));
  process.env.COCKPIT_HOME = home;
  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, '.gitignore'), 'node_modules/\n');
  await writeFile(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  await mkdir(join(work, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(work, 'node_modules', 'x', 'junk.js'), 'junk\n');
  runtime = ManagedRuntime.make(SnapshotServiceLive as Layer.Layer<SnapshotService>);
});

afterAll(async () => {
  await runtime.dispose();
  delete process.env.COCKPIT_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const svc = <A, E>(f: (s: SnapshotService) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(SnapshotService, f));

describe('SnapshotServiceLive', () => {
  it('repo dir name is basename + 12-hex hash', () => {
    const name = snapshotRepoDirName('/tmp/My Project!');
    expect(name).toMatch(/^My_Project_-[0-9a-f]{12}$/);
  });

  it('baseline commits the initial tree (ignoring .gitignore entries)', async () => {
    const r = await svc((s) => s.baseline(work, 'session-1', 'claude'));
    expect(r.committed).toBe(true);
    // Second baseline with no changes → skip.
    const r2 = await svc((s) => s.baseline(work, 'session-1', 'claude'));
    expect(r2.committed).toBe(false);
  });

  it('records a tool snapshot and finds it by toolId with a correct diff', async () => {
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(work, 'src', 'b.ts'), 'export const b = 1;\n'); // concurrent change
    await writeFile(join(work, 'node_modules', 'x', 'junk.js'), 'changed junk\n'); // ignored

    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_123',
        toolName: 'Edit',
        toolFiles: [join(work, 'src', 'a.ts')],
      })
    );
    expect(r.committed).toBe(true);

    const commits = await svc((s) => s.listByToolIds(work, ['toolu_123']));
    expect(commits).toHaveLength(1);
    expect(commits[0].toolName).toBe('Edit');
    expect(commits[0].sessionKey).toBe('session-1');
    expect(commits[0].toolFiles).toEqual(['src/a.ts']);
    expect(commits[0].baseline).toBe(false);

    const diff = await svc((s) => s.diff(work, commits[0].hash));
    const paths = diff.files.map((f) => f.path).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']); // ignored junk.js absent
    const a = diff.files.find((f) => f.path === 'src/a.ts')!;
    expect(a.status).toBe('modified');
    expect(a.oldContent).toContain('a = 1');
    expect(a.newContent).toContain('a = 2');
    const b = diff.files.find((f) => f.path === 'src/b.ts')!;
    expect(b.status).toBe('added');
  });

  it('can scope tool-id lookups to one session', async () => {
    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 3;\n');
    const r1 = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'codex',
        toolId: 'item_0',
        toolName: 'Bash',
      })
    );
    expect(r1.committed).toBe(true);

    await writeFile(join(work, 'src', 'a.ts'), 'export const a = 4;\n');
    const r2 = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-2',
        provider: 'codex',
        toolId: 'item_0',
        toolName: 'Bash',
      })
    );
    expect(r2.committed).toBe(true);

    const all = await svc((s) => s.listByToolIds(work, ['item_0']));
    expect(all).toHaveLength(2);
    const current = await svc((s) => s.listByToolIds(work, ['item_0'], 'session-2'));
    expect(current).toHaveLength(1);
    expect(current[0].sessionKey).toBe('session-2');
  });

  it('skips the snapshot when nothing changed', async () => {
    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_456',
        toolName: 'Bash',
      })
    );
    expect(r.committed).toBe(false);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_456']));
    expect(commits).toHaveLength(0);
  });

  it('records file deletion', async () => {
    await rm(join(work, 'src', 'b.ts'));
    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_789',
        toolName: 'Bash',
      })
    );
    expect(r.committed).toBe(true);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_789']));
    const diff = await svc((s) => s.diff(work, commits[0].hash));
    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].status).toBe('deleted');
    expect(diff.files[0].oldContent).toContain('b = 1');
  });

  it('listByToolIds on an unknown cwd returns empty', async () => {
    const commits = await svc((s) => s.listByToolIds('/nonexistent/dir', ['x']));
    expect(commits).toEqual([]);
  });

  it('excludes an oversize file inside a NEW untracked directory (-uall)', async () => {
    // Sparse 3MB file (over the 2MB default cap) + a small sibling in a fresh dir.
    await mkdir(join(work, 'bigdir'), { recursive: true });
    await writeFile(join(work, 'bigdir', 'big.bin'), '');
    await truncate(join(work, 'bigdir', 'big.bin'), 3 * 1024 * 1024);
    await writeFile(join(work, 'bigdir', 'small.txt'), 'small\n');

    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_bigdir',
        toolName: 'Bash',
      })
    );
    expect(r.committed).toBe(true);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_bigdir']));
    const diff = await svc((s) => s.diff(work, commits[0].hash));
    const paths = diff.files.map((f) => f.path);
    expect(paths).toContain('bigdir/small.txt');
    expect(paths).not.toContain('bigdir/big.bin');
  });

  it('early-skips when the only pending change is a resident oversize file', async () => {
    // big.bin is still untracked from the previous test — with no other
    // changes the record must skip without attempting an empty commit.
    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_resident',
        toolName: 'Bash',
      })
    );
    expect(r.committed).toBe(false);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_resident']));
    expect(commits).toHaveLength(0);
  });

  it('cleanup deletes day branches older than the retention window and gc-reclaims them', async () => {
    // Fabricate an "expired" day branch pointing at today's tip.
    const repoDir = join(home, 'snapshots', snapshotRepoDirName(work));
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile('git', args, { env: { ...process.env, GIT_DIR: repoDir } }, (err, stdout, stderr) =>
          err ? reject(new Error(stderr)) : resolve(stdout)
        );
      });
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['branch', 'snap/2026-01-01', head]);

    await svc((s) => s.cleanup);

    const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/snap/'])).trim().split('\n');
    expect(branches).not.toContain('snap/2026-01-01');
    expect(branches.length).toBeGreaterThan(0); // today's branch retained
    // Repo itself retained (lastSnapshotAt is fresh).
    expect(existsSync(join(repoDir, 'HEAD'))).toBe(true);
  });

  it('cleanup removes a whole repo after 30 days of inactivity', async () => {
    const work3 = await mkdtemp(join(tmpdir(), 'cockpit-snap-ttl-'));
    await writeFile(join(work3, 'a.txt'), 'x\n');
    const r = await svc((s) => s.baseline(work3, 'session-ttl', 'claude'));
    expect(r.committed).toBe(true);

    const repoDir = join(home, 'snapshots', snapshotRepoDirName(work3));
    const metaPath = join(repoDir, 'meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    meta.lastSnapshotAt = Date.now() - 31 * 24 * 3600 * 1000;
    await writeFile(metaPath, JSON.stringify(meta));

    await svc((s) => s.cleanup);
    expect(existsSync(repoDir)).toBe(false);
    await rm(work3, { recursive: true, force: true });
  });

  it('cleanup removes a repo whose project directory no longer exists', async () => {
    const work4 = await mkdtemp(join(tmpdir(), 'cockpit-snap-gone-'));
    await writeFile(join(work4, 'a.txt'), 'x\n');
    await svc((s) => s.baseline(work4, 'session-gone', 'claude'));
    const repoDir = join(home, 'snapshots', snapshotRepoDirName(work4));
    expect(existsSync(repoDir)).toBe(true);

    await rm(work4, { recursive: true, force: true }); // project dir gone
    await svc((s) => s.cleanup);
    expect(existsSync(repoDir)).toBe(false);
  });

  it('uses the tool description as the commit subject when no files are declared', async () => {
    await writeFile(join(work, 'src', 'detail.txt'), 'd1\n');
    const r = await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_detail',
        toolName: 'Bash',
        toolDetail: 'Install project\ndependencies', // newline must be stripped
      })
    );
    expect(r.committed).toBe(true);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_detail']));
    expect(commits[0].subject).toBe('[Bash] Install project dependencies');

    // Long raw command falls back truncated to 80 chars.
    await writeFile(join(work, 'src', 'detail.txt'), 'd2\n');
    const long = 'x'.repeat(200);
    await svc((s) =>
      s.record({
        cwd: work,
        sessionKey: 'session-1',
        provider: 'claude',
        toolId: 'toolu_detail2',
        toolName: 'Bash',
        toolDetail: long,
      })
    );
    const c2 = await svc((s) => s.listByToolIds(work, ['toolu_detail2']));
    expect(c2[0].subject.length).toBeLessThanOrEqual(80);
    expect(c2[0].subject.startsWith('[Bash] xxx')).toBe(true);
  });

  it('baseline yields to a pending tool record for the same cwd', async () => {
    await writeFile(join(work, 'src', 'yield.ts'), 'export const y = 1;\n');
    notePendingRecord(work);
    const skipped = await svc((s) => s.baseline(work, 'session-1', 'claude'));
    expect(skipped.committed).toBe(false); // baseline stepped aside
    settlePendingRecord(work);
    // The pending record then captures the change under its own toolId.
    const r = await svc((s) =>
      s.record({ cwd: work, sessionKey: 'session-1', provider: 'claude', toolId: 'toolu_yield', toolName: 'Bash' })
    );
    expect(r.committed).toBe(true);
    const commits = await svc((s) => s.listByToolIds(work, ['toolu_yield']));
    expect(commits).toHaveLength(1);
  });

  it('cleanup repoints HEAD and deletes an expired branch HEAD was on', async () => {
    const repoDir = join(home, 'snapshots', snapshotRepoDirName(work));
    const git = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile('git', args, { env: { ...process.env, GIT_DIR: repoDir } }, (err, stdout, stderr) =>
          err ? reject(new Error(stderr)) : resolve(stdout)
        );
      });
    const head = (await git(['rev-parse', 'HEAD'])).trim();
    await git(['branch', 'snap/2026-02-02', head]);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/snap/2026-02-02']); // dormant-project shape

    await svc((s) => s.cleanup);

    const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/snap/'])).trim().split('\n');
    expect(branches).not.toContain('snap/2026-02-02'); // deleted despite HEAD
    const newHead = (await git(['symbolic-ref', 'HEAD'])).trim();
    expect(newHead).toMatch(/^refs\/heads\/snap\/\d{4}-\d{2}-\d{2}$/);
  });

  it('cleanup keeps a repo whose meta.json is corrupt (torn write)', async () => {
    const workC = await mkdtemp(join(tmpdir(), 'cockpit-snap-corrupt-'));
    await writeFile(join(workC, 'a.txt'), 'x\n');
    await svc((s) => s.baseline(workC, 'session-c', 'claude'));
    const repoDir = join(home, 'snapshots', snapshotRepoDirName(workC));
    await writeFile(join(repoDir, 'meta.json'), '{"cwd": "/tr'); // torn JSON

    await svc((s) => s.cleanup);
    expect(existsSync(join(repoDir, 'HEAD'))).toBe(true); // NOT deleted
    await rm(workC, { recursive: true, force: true });
    await rm(repoDir, { recursive: true, force: true });
  });

  it('cleanup removes a debris dir without HEAD', async () => {
    const debris = join(home, 'snapshots', 'debris-000000000000');
    await mkdir(debris, { recursive: true });
    await writeFile(join(debris, 'meta.json'), '{}');
    await svc((s) => s.cleanup);
    expect(existsSync(debris)).toBe(false);
  });

  it('skips the snapshot when total changed bytes exceed the runaway guard', async () => {
    // Fresh work dir; 600 sparse 2MB files (exactly at the per-file cap, so
    // they count toward the total) → 1.2GB logical > 1GB guard.
    const work2 = await mkdtemp(join(tmpdir(), 'cockpit-snap-guard-'));
    await mkdir(join(work2, 'data'), { recursive: true });
    for (let i = 0; i < 600; i++) {
      const p = join(work2, 'data', `f${i}.bin`);
      await writeFile(p, '');
      await truncate(p, 2 * 1024 * 1024);
    }
    const r = await svc((s) => s.baseline(work2, 'session-guard', 'claude'));
    expect(r.committed).toBe(false);
    // Guard trip is remembered (backoff): meta records it, and the next
    // attempt short-circuits without re-paying the full-tree scan.
    const repoDir = join(home, 'snapshots', snapshotRepoDirName(work2));
    const meta = JSON.parse(await readFile(join(repoDir, 'meta.json'), 'utf8'));
    expect(typeof meta.guardTrippedAt).toBe('number');
    const t0 = Date.now();
    const r2 = await svc((s) =>
      s.record({ cwd: work2, sessionKey: 'session-guard', provider: 'claude', toolId: 'toolu_g', toolName: 'Bash' })
    );
    expect(r2.committed).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500); // no 600-file stat pass
    await rm(work2, { recursive: true, force: true });
  });
});
