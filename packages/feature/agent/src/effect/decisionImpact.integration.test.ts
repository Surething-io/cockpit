/**
 * Impact & decision check over a REAL project (docs/DECISION_MODE.md §6, §7.2):
 * real snapshots, real code index. A signature change must surface its
 * untouched caller, the affected test must show as not run, and a decision on
 * the caller's file must be found as an indirect touch — while a decision on
 * the changed file itself is a direct touch that blocks accept without a verdict.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotService } from '@cockpit/effect-services';

let home: string;
let work: string;
let runtime: ManagedRuntime.ManagedRuntime<SnapshotService, never>;
let decisions: typeof import('@cockpit/feature-decisions/server');
let impact: typeof import('../server/review/impact');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-impact-home-'));
  work = await mkdtemp(join(tmpdir(), 'cockpit-impact-work-'));
  process.env.COCKPIT_HOME = home;
  const { SnapshotServiceLive } = await import('./snapshotLive');
  decisions = await import('@cockpit/feature-decisions/server');
  impact = await import('../server/review/impact');
  runtime = ManagedRuntime.make(SnapshotServiceLive as Layer.Layer<SnapshotService>);

  await mkdir(join(work, 'src'), { recursive: true });
  await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'vitest run' } }));
  await writeFile(join(work, 'src/lib.ts'), `export function greet(name: string) {\n  return 'hi ' + name;\n}\nexport function count() {\n  return 1;\n}\n`);
  await writeFile(join(work, 'src/use.ts'), `import { greet } from './lib';\nexport function welcome() {\n  return greet('x');\n}\n`);
  await writeFile(join(work, 'src/lib.test.ts'), `import { count } from './lib';\nexport const t = count();\n`);
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: work, stdio: 'pipe' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', `init ${work}`);
});

afterAll(async () => {
  await runtime.dispose();
  delete process.env.COCKPIT_HOME;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const run = <A, E>(e: Effect.Effect<A, E, SnapshotService>) => runtime.runPromise(e);

describe('impact & decision check on a real project', () => {
  it('finds the caller gap, the unrun test, and touched decisions; accept needs the direct verdict', async () => {
    const { getCodeIndex } = await import('@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex');
    await getCodeIndex(work); // index ready before the change, as in a live project

    await Effect.runPromise(decisions.setEnabled(work, true));
    const projectId = (await Effect.runPromise(decisions.requireProject(work))).projectId;
    const onLib = await Effect.runPromise(decisions.createDecision(projectId, { content: { choice: 'greet stays sync', alternatives: [], rationale: '', tradeoffs: '', premises: [] }, source: { kind: 'manual' }, links: [{ path: 'src/lib.ts' }] }));
    const onUse = await Effect.runPromise(decisions.createDecision(projectId, { content: { choice: 'welcome is plain text', alternatives: [], rationale: '', tradeoffs: '', premises: [] }, source: { kind: 'manual' }, links: [{ path: 'src/use.ts' }] }));

    await run(Effect.flatMap(SnapshotService, (s) => s.baseline(work, 'S1', 'claude')));
    await writeFile(join(work, 'src/lib.ts'), `export function greet(name: string, loud: boolean) {\n  return 'hi ' + name;\n}\nexport function count() {\n  return 2;\n}\n`);
    await run(Effect.flatMap(SnapshotService, (s) => s.record({ cwd: work, sessionKey: 'S1', provider: 'claude', toolId: 'e1', toolName: 'Edit', toolFiles: [join(work, 'src/lib.ts')] })));

    const r = await run(impact.analyzeImpact(work, ['e1'], [], false));
    expect(r.interfaceGaps).toEqual([{ file: 'src/lib.ts', qname: 'greet', change: 'interface', callers: [{ file: 'src/use.ts', qname: 'welcome', lines: [3] }] }]);
    expect(r.bodyOnly.map((b) => b.qname)).toEqual(['count']);
    expect(r.tests).toEqual([{ test: 'src/lib.test.ts', state: 'not-run' }]);
    expect(r.blindSpots).toEqual([]);
    expect(r.touched.map((t) => [t.decision.id, t.reason])).toEqual([[onLib.id, 'direct'], [onUse.id, 'neighbor']]);

    // Accepting without a verdict on the direct touch is refused; with one, it records the review.
    const turns = [{ id: 'u1', text: 'loud greet', toolIds: ['e1'] }];
    const refused = await runtime.runPromiseExit(decisions.acceptTask(projectId, { cwd: work, sessionId: 'S1', goal: '', turns }));
    expect(refused._tag).toBe('Failure');
    const ok = await run(decisions.acceptTask(projectId, {
      cwd: work, sessionId: 'S1', goal: '', turns,
      verdicts: [
        { decisionId: onLib.id, verdict: 'superseded', replacement: { choice: 'greet takes a loud flag', alternatives: [], rationale: 'needed for alerts', tradeoffs: '', premises: [] } },
        { decisionId: onUse.id, verdict: 'holds' },
      ],
    }));
    const after = await Effect.runPromise(decisions.listDecisions(projectId));
    const byId = new Map(after.map((d) => [d.id, d]));
    const replacement = ok.decisions[0];
    expect(byId.get(onLib.id)).toMatchObject({ status: 'superseded', supersededBy: replacement.id });
    expect(replacement).toMatchObject({ supersedes: onLib.id, origin: { taskId: ok.task.id } });
    expect(replacement.links[0]).toMatchObject({ path: 'src/lib.ts' });
    expect(byId.get(onUse.id)?.lastReview).toMatchObject({ verdict: 'holds', taskId: ok.task.id });
  });
});
