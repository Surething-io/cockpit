import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DecisionCandidate, ExtractionResult } from '../shared/extraction';

const root = mkdtempSync(join(tmpdir(), 'cockpit-decisions-inbox-'));
process.env.COCKPIT_HOME = join(root, 'home');

let inbox: typeof import('./candidates');
let identity: typeof import('./projectIdentity');
let store: typeof import('./store');
let paths: typeof import('./paths');
beforeAll(async () => {
  inbox = await import('./candidates');
  identity = await import('./projectIdentity');
  store = await import('./store');
  paths = await import('./paths');
});

const cand = (choice: string, source: DecisionCandidate['source'], files: string[] = []): DecisionCandidate => ({
  key: 'c0', content: { choice, alternatives: [], rationale: '', tradeoffs: '', premises: [] }, source, files,
});
const result = (candidates: DecisionCandidate[], extra: Partial<ExtractionResult> = {}): ExtractionResult => ({
  goal: '', summary: [], candidates, engine: 'codex', model: 'm', chunks: 1, cached: false, ...extra,
});
const quoted = (q: string, id = 'u1') => ({ kind: 'user' as const, quote: q, messageId: id });

describe('collectCandidates', () => {
  it('the same quote across overlapping extractions is one candidate, newest wording wins', () => {
    const out = inbox.collectCandidates(
      [
        { at: 2, result: result([cand('Cap at 200 messages', quoted('200 条 OK'))]) },
        { at: 1, result: result([cand('Limit to 200', quoted('200  条 OK'))]) },
        { at: 3, result: result([cand('Cap at 200 messages and 800k tokens', quoted('200 条 OK')), cand('5 minute window', { kind: 'inferred' })]) },
      ],
      new Set(),
    );
    expect(out.map((c) => c.content.choice)).toEqual(['Cap at 200 messages and 800k tokens', '5 minute window']);
  });

  it('without a verified quote, identical choice text is one candidate', () => {
    const out = inbox.collectCandidates(
      [{ at: 1, result: result([cand('Use a queue', { kind: 'inferred' }), cand('use  a QUEUE', { kind: 'inferred' })]) }],
      new Set(),
    );
    expect(out).toHaveLength(1);
  });

  it('near-duplicates quoted from different turns merge (calibrated on real data); unrelated ones do not', () => {
    const out = inbox.collectCandidates(
      [
        { at: 1, result: result([cand('首次初始化最多纳入最近 200 条可见消息，并以累计 80 万 tokens 为上限。', quoted('a', 'u1'))]) },
        { at: 2, result: result([cand('首次初始化限制为最近 200 条可见消息，累计最多 80 万 tokens。', quoted('b', 'u2'))]) },
        { at: 3, result: result([cand('启用 main 的 Merge Queue，并保留显式入队。', { kind: 'agent', quote: 'c', messageId: 'a3' })]) },
        { at: 4, result: result([cand('保留显式入队，沿用 merge commit，并计划启用队列后关闭传统保护中的 strict 同步要求，同时保留 review 要求', { kind: 'agent', quote: 'd', messageId: 'a4' })]) },
      ],
      new Set(),
    );
    expect(out).toHaveLength(3);
    const merged = out.find((c) => c.content.choice.startsWith('首次初始化'))!;
    expect(merged.content.choice).toBe('首次初始化限制为最近 200 条可见消息，累计最多 80 万 tokens。'); // newest wording
    expect(merged.keys).toHaveLength(2);
  });

  it('a re-worded repeat of something kept or dismissed stays hidden', () => {
    const out = inbox.collectCandidates(
      [{ at: 1, result: result([cand('首次初始化最多取最近 200 条可见消息，并设累计 80 万 tokens 上限。', quoted('x', 'u9'))]) }],
      new Set(),
      ['首次初始化最多纳入最近 200 条可见消息，并以累计 80 万 tokens 为上限。'],
    );
    expect(out).toEqual([]);
  });

  it('handled keys are gone; old caches are cleaned of evidence labels', () => {
    const c = { ...cand('In memory [M3]', quoted('先别落盘')), content: { choice: 'In memory [M3]', alternatives: ['[F1]'], rationale: 'r [M2]', tradeoffs: '', premises: ['[M35]', 'single process [M44]'] } };
    const [only] = inbox.collectCandidates([{ at: 1, result: result([c]) }], new Set());
    expect(only.content).toEqual({ choice: 'In memory', alternatives: [], rationale: 'r', tradeoffs: '', premises: ['single process'] });
    expect(inbox.collectCandidates([{ at: 1, result: result([c]) }], new Set([only.key]))).toEqual([]);
  });
});

describe('keep / dismiss on a real project', () => {
  it('keep creates a linked decision with the file blob; both actions remove it from the inbox', async () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, stdio: 'pipe' }).toString().trim();
    git('init', '-q');
    writeFileSync(join(repo, 'src/send.ts'), 'send\n');
    git('add', '.');
    git('commit', '-qm', `init ${repo}`);
    await Effect.runPromise(identity.setEnabled(repo, true));
    const { projectId } = await Effect.runPromise(identity.requireProject(repo));

    const dir = join(paths.projectDir(projectId), 'extractions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.json'), JSON.stringify(result(
      [cand('Keep ids in memory', quoted('先别落盘'), ['src/send.ts']), cand('Window is 5 min', { kind: 'agent', quote: '5 minutes', messageId: 'a1' })],
      { cwd: repo, sessionId: 'S1' },
    )));
    utimesSync(join(dir, 'a.json'), new Date(), new Date());

    const listed = await Effect.runPromise(inbox.listCandidates(projectId));
    expect(listed).toHaveLength(2);
    const keepMe = listed.find((c) => c.content.choice === 'Keep ids in memory')!;
    const dropMe = listed.find((c) => c.content.choice === 'Window is 5 min')!;

    const d = await Effect.runPromise(inbox.keepCandidate(projectId, repo, keepMe.key));
    const blob = execFileSync('git', ['hash-object', join(repo, 'src/send.ts')]).toString().trim();
    expect(d).toMatchObject({ choice: 'Keep ids in memory', source: { kind: 'user', quote: '先别落盘' }, links: [{ path: 'src/send.ts', blob }], origin: { sessionId: 'S1' } });
    await Effect.runPromise(inbox.dismissCandidate(projectId, dropMe.key));

    expect(await Effect.runPromise(inbox.listCandidates(projectId))).toEqual([]);
    expect((await Effect.runPromise(store.listDecisions(projectId))).map((x) => x.choice)).toEqual(['Keep ids in memory']);
    // A kept key cannot be kept twice.
    expect((await Effect.runPromiseExit(inbox.keepCandidate(projectId, repo, keepMe.key)))._tag).toBe('Failure');
  });
});
