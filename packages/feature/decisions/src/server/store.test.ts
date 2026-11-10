import { appendFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';
import { ValidationError } from '@cockpit/effect-core';
import type { DecisionContent } from '../shared/types';

// paths.ts resolves COCKPIT_DIR once at module load — redirect it first.
process.env.COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-decisions-store-'));

let store: typeof import('./store');
let paths: typeof import('./paths');
beforeAll(async () => {
  store = await import('./store');
  paths = await import('./paths');
});

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e);
const P = 'git-test';
const content = (choice: string): DecisionContent => ({
  choice,
  alternatives: ['unify storage'],
  rationale: 'keep native resume',
  tradeoffs: 'several parsers',
  premises: ['engines keep native history'],
});
const lines = (id: string) => readFileSync(paths.recordFile(P, id), 'utf8').trim().split('\n');

describe('decision store', () => {
  it('creates, lists and folds a decision', async () => {
    const d = await run(
      store.createDecision(P, { content: content('keep per-engine storage'), source: { kind: 'user', quote: 'keep it native' }, links: [{ path: 'src/a.ts' }] }),
    );
    expect(d).toMatchObject({ choice: 'keep per-engine storage', status: 'active', revisions: 0, source: { kind: 'user' } });
    expect(d.id).toMatch(paths.DECISION_ID);
    const all = await run(store.listDecisions(P));
    expect(all.map((x) => x.id)).toContain(d.id);
  });

  it('is append-only: an edit adds a line and the original stays readable', async () => {
    const d = await run(store.createDecision(P, { content: content('v1'), source: { kind: 'manual' }, links: [] }));
    const edited = await run(store.editDecision(P, d.id, { content: { choice: 'v2', rationale: 'keep native resume' } }));
    expect(edited.choice).toBe('v2');
    expect(edited.revisions).toBe(1);
    const log = lines(d.id);
    expect(log).toHaveLength(2);
    expect(JSON.parse(log[0]).content.choice).toBe('v1');
    // Unchanged fields are not written into the revision.
    expect(JSON.parse(log[1]).content).toEqual({ choice: 'v2' });

    const noop = await run(store.editDecision(P, d.id, { content: { choice: 'v2' } }));
    expect(noop.revisions).toBe(1);
    expect(lines(d.id)).toHaveLength(2);
  });

  it('records files owner-only', async () => {
    if (process.platform === 'win32') return;
    const d = await run(store.createDecision(P, { content: content('private'), source: { kind: 'manual' }, links: [] }));
    expect(statSync(paths.recordFile(P, d.id)).mode & 0o077).toBe(0);
    expect(statSync(paths.recordsDir(P)).mode & 0o077).toBe(0);
  });

  it('supersede links both ways and cannot happen twice', async () => {
    const old = await run(store.createDecision(P, { content: content('old'), source: { kind: 'manual' }, links: [] }));
    const next = await run(store.createDecision(P, { content: content('new'), source: { kind: 'manual' }, links: [], supersedes: old.id }));
    expect(next.supersedes).toBe(old.id);
    const all = await run(store.listDecisions(P));
    expect(all.find((x) => x.id === old.id)).toMatchObject({ status: 'superseded', supersededBy: next.id });

    const again = await Effect.runPromiseExit(
      store.createDecision(P, { content: content('newer'), source: { kind: 'manual' }, links: [], supersedes: old.id }),
    );
    expect(again._tag).toBe('Failure');
    // A superseded decision's status is frozen.
    expect((await Effect.runPromiseExit(store.setDecisionStatus(P, old.id, 'retired', 'gone')))._tag).toBe('Failure');
  });

  it('retire needs a reason and can be undone', async () => {
    const d = await run(store.createDecision(P, { content: content('feature x'), source: { kind: 'manual' }, links: [] }));
    expect((await Effect.runPromiseExit(store.setDecisionStatus(P, d.id, 'retired')))._tag).toBe('Failure');
    const retired = await run(store.setDecisionStatus(P, d.id, 'retired', 'feature x was removed'));
    expect(retired).toMatchObject({ status: 'retired', statusReason: 'feature x was removed' });
    const back = await run(store.setDecisionStatus(P, d.id, 'active'));
    expect(back.status).toBe('active');
    expect(lines(d.id)).toHaveLength(3);
  });

  it('skips a torn line instead of failing the whole log', async () => {
    const d = await run(store.createDecision(P, { content: content('torn'), source: { kind: 'manual' }, links: [] }));
    appendFileSync(paths.recordFile(P, d.id), '{"type":"edited","at":1,"cont');
    const all = await run(store.listDecisions(P));
    expect(all.find((x) => x.id === d.id)?.choice).toBe('torn');
  });

  it('rejects ids that are not server-generated (no path traversal)', async () => {
    const exit = await Effect.runPromiseExit(store.readEvents(P, '../../etc/passwd'));
    expect(exit._tag).toBe('Failure');
  });

  it('lists nothing for a project without records', async () => {
    expect(await run(store.listDecisions('git-empty'))).toEqual([]);
  });
});

describe('decision input validation', () => {
  it('requires a quote for user / agent sources', () => {
    expect(store.parseSource({ kind: 'user' })).toBeInstanceOf(ValidationError);
    expect(store.parseSource({ kind: 'agent', quote: '  ' })).toBeInstanceOf(ValidationError);
    expect(store.parseSource({ kind: 'model-said-so' })).toBeInstanceOf(ValidationError);
    expect(store.parseSource({ kind: 'manual' })).toEqual({ kind: 'manual' });
  });

  it('keeps links relative to the repo root', () => {
    expect(store.parseLinks([{ path: '/etc/passwd' }])).toBeInstanceOf(ValidationError);
    expect(store.parseLinks([{ path: 'a/../../b' }])).toBeInstanceOf(ValidationError);
    expect(store.parseLinks([{ path: 'C:\\x' }])).toBeInstanceOf(ValidationError);
    expect(store.parseLinks([{ path: 'src\\a.ts', symbol: 'f' }])).toEqual([{ path: 'src/a.ts', symbol: 'f' }]);
    expect(store.parseLinks([{ path: 'a.ts', blob: 'nothex' }])).toBeInstanceOf(ValidationError);
  });

  it('requires a non-empty choice', () => {
    expect(store.parseContent({ rationale: 'x' }, false)).toBeInstanceOf(ValidationError);
    expect(store.parseContent({ choice: ' ' }, true)).toBeInstanceOf(ValidationError);
    expect(store.parseContent({ choice: ' a ', premises: [' p ', ''] }, false)).toEqual({
      choice: 'a', alternatives: [], rationale: '', tradeoffs: '', premises: ['p'],
    });
  });
});
