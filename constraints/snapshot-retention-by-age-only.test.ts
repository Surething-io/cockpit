/**
 * Constraint: SnapshotRetentionByAgeOnly (invariant, L2).
 *
 * Snapshot cleanup deletes a project's shadow repo only when it has been
 * inactive for the repo TTL. A missing project directory is NOT a reason: an
 * unmounted drive, a renamed folder or a project deleted by mistake is exactly
 * when the snapshot history is needed to recover it. Space is still reclaimed —
 * a repo whose project is gone gets no new snapshots and ages out on the TTL.
 *
 * Why: cleanup treated "cwd not found" as stale and rm -rf'ed the whole history
 * on the next daily pass.
 *
 * Real git and throwaway dirs, like snapshotLive.test.ts.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotService } from '@cockpit/effect-services';
import {
  SnapshotServiceLive,
  snapshotRepoDirName,
} from '../packages/feature/agent/src/effect/snapshotLive';

let home: string;
let runtime: ManagedRuntime.ManagedRuntime<SnapshotService, never>;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-snap-retention-'));
  process.env.COCKPIT_HOME = home;
  runtime = ManagedRuntime.make(SnapshotServiceLive as Layer.Layer<SnapshotService>);
});

afterAll(async () => {
  await runtime.dispose();
  delete process.env.COCKPIT_HOME;
  await rm(home, { recursive: true, force: true });
});

const svc = <A, E>(f: (s: SnapshotService) => Effect.Effect<A, E>) =>
  runtime.runPromise(Effect.flatMap(SnapshotService, f));

/** A project with one baseline snapshot; returns its dir and its shadow repo dir. */
async function projectWithSnapshot(tag: string) {
  const work = await mkdtemp(join(tmpdir(), `cockpit-snap-${tag}-`));
  await writeFile(join(work, 'a.txt'), 'x\n');
  await svc((s) => s.baseline(work, `session-${tag}`, 'claude'));
  const repoDir = join(home, 'snapshots', snapshotRepoDirName(work));
  expect(existsSync(repoDir)).toBe(true);
  return { work, repoDir };
}

async function ageRepo(repoDir: string, days: number) {
  const metaPath = join(repoDir, 'meta.json');
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  meta.lastSnapshotAt = Date.now() - days * 24 * 3600 * 1000;
  await writeFile(metaPath, JSON.stringify(meta));
}

describe('SnapshotRetentionByAgeOnly', () => {
  it('keeps a recent repo whose project directory is missing', async () => {
    const { work, repoDir } = await projectWithSnapshot('gone');
    await rm(work, { recursive: true, force: true }); // drive unmounted / folder renamed / deleted

    await svc((s) => s.cleanup);
    expect(existsSync(repoDir)).toBe(true);
  });

  it('still removes it once inactive past the TTL', async () => {
    const { work, repoDir } = await projectWithSnapshot('gone-old');
    await rm(work, { recursive: true, force: true });
    await ageRepo(repoDir, 31);

    await svc((s) => s.cleanup);
    expect(existsSync(repoDir)).toBe(false);
  });
});
