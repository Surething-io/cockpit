/**
 * Decision-mode review over REAL snapshots (docs/DECISION_MODE.md §4.3–§4.4):
 * two sessions interleave tool calls in one project; the review must attribute
 * each file, and accepting must freeze the task's files with blob ids that
 * match the project's own git objects.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotService } from '@cockpit/effect-services';

let home: string;
let work: string;
let runtime: ManagedRuntime.ManagedRuntime<SnapshotService, never>;
let decisions: typeof import('@cockpit/feature-decisions/server');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-review-home-'));
  work = await mkdtemp(join(tmpdir(), 'cockpit-review-work-'));
  process.env.COCKPIT_HOME = home; // before the modules below resolve COCKPIT_DIR
  const { SnapshotServiceLive } = await import('./snapshotLive');
  decisions = await import('@cockpit/feature-decisions/server');
  runtime = ManagedRuntime.make(SnapshotServiceLive as Layer.Layer<SnapshotService>);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work, stdio: 'pipe' });
  await writeFile(join(work, 'seed.ts'), `seed ${work}\n`);
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterAll(async () => {
  await runtime.dispose();
  delete process.env.COCKPIT_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const run = <A, E>(e: Effect.Effect<A, E, SnapshotService>) => runtime.runPromise(e);
const snap = (sessionKey: string, toolId: string, toolName: string, files: string[] = []) =>
  run(Effect.flatMap(SnapshotService, (s) => s.record({ cwd: work, sessionKey, provider: 'claude', toolId, toolName, toolFiles: files.map((f) => join(work, f)) })));

describe('decision-mode review on real snapshots', () => {
  it('attributes interleaved sessions and freezes the task on accept', async () => {
    await run(Effect.flatMap(SnapshotService, (s) => s.baseline(work, 'S1', 'claude')));

    await writeFile(join(work, 'a.ts'), 'a1\n');
    await snap('S1', 't1', 'Edit', ['a.ts']);
    await writeFile(join(work, 'b.ts'), 'b\n');
    await writeFile(join(work, 'shared.ts'), 'from S2\n');
    await snap('S2', 'o1', 'Edit', ['b.ts']);
    await writeFile(join(work, 'gen.ts'), 'generated\n');
    await writeFile(join(work, 'shared.ts'), 'from S1 bash\n');
    await snap('S1', 't2', 'Bash');
    await writeFile(join(work, 'a.ts'), 'a2\n');
    await snap('S1', 't3', 'Edit', ['a.ts']);

    const review = await run(decisions.computeReview(work, ['t1', 't2', 't3'], false));
    expect(review.empty).toBe(false);
    if (review.empty) return;
    const cat = Object.fromEntries(review.files.map((f) => [f.path, f.category]));
    expect(cat).toEqual({ 'a.ts': 'task', 'gen.ts': 'task-maybe', 'shared.ts': 'mixed', 'b.ts': 'other-session' });
    expect(review.files.every((f) => f.oldContent === null && f.newContent === null)).toBe(true);

    // Accepting needs decision mode on.
    await Effect.runPromise(decisions.setEnabled(work, true));
    const task = await run(
      decisions.acceptTask((await Effect.runPromise(decisions.requireProject(work))).projectId, {
        cwd: work,
        sessionId: 'S1',
        goal: 'fix a',
        turns: [{ id: 'u1', text: 'fix a', toolIds: ['t1', 't2', 't3'] }],
      }),
    );
    expect(task.files.map((f) => f.path).sort()).toEqual(['a.ts', 'gen.ts', 'shared.ts']);
    expect(task.otherSessionFiles).toEqual(['b.ts']);
    const aBlob = execFileSync('git', ['hash-object', join(work, 'a.ts')]).toString().trim();
    expect(task.files.find((f) => f.path === 'a.ts')?.blob).toBe(aBlob);
    expect(task.projectHead).toMatch(/^[0-9a-f]{40}$/);

    // Written once, listed for the session, readable back.
    const projectId = (await Effect.runPromise(decisions.requireProject(work))).projectId;
    const list = await Effect.runPromise(decisions.listSessionTasks(projectId, 'S1'));
    expect(list.map((x) => x.id)).toEqual([task.id]);
    expect(await Effect.runPromise(decisions.listSessionTasks(projectId, 'S2'))).toEqual([]);
    const raw = JSON.parse(await readFile(join(home, 'decisions', projectId, 'tasks', `${task.id}.json`), 'utf8'));
    expect(raw.snapshot.head).toBe(review.head);
  });

  it('a range with no snapshot commits is empty, and accepting it is refused', async () => {
    expect(await run(decisions.computeReview(work, ['never-ran'], false))).toEqual({ empty: true });
    const projectId = (await Effect.runPromise(decisions.requireProject(work))).projectId;
    const exit = await runtime.runPromiseExit(
      decisions.acceptTask(projectId, { cwd: work, sessionId: 'S1', goal: '', turns: [{ id: 'u', text: '', toolIds: ['never-ran'] }] }),
    );
    expect(exit._tag).toBe('Failure');
  });
});
