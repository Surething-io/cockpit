import { describe, expect, it } from 'vitest';
import type { Decision } from '../shared/types';
import { rankDecisions, tokens } from './relevance';

const d = (id: string, over: Partial<Decision>): Decision => ({
  id, choice: '', alternatives: [], rationale: '', tradeoffs: '', premises: [], source: { kind: 'manual' },
  links: [], status: 'active', createdAt: 1, updatedAt: 1, revisions: 0, ...over,
});

const decisions = [
  d('mem', { choice: 'Keep dedupe ids in memory only', premises: ['single process'], links: [{ path: 'src/send.ts' }] }),
  d('cn', { choice: '会话存储按引擎保留原生格式', rationale: '为了恢复会话', links: [{ path: 'src/history.ts' }] }),
  d('sym', { choice: 'greet stays sync', links: [{ path: 'src/lib.ts', symbol: 'greet' }] }),
  d('old', { choice: 'dedupe ids on disk', status: 'superseded', links: [{ path: 'src/send.ts' }] }),
];
const rank = (text: string, changed: string[] = [], exclude: string[] = []) =>
  rankDecisions(decisions, text, new Set(changed), new Set(exclude)).map((r) => [r.decision.id, r.reasons.sort()]);

describe('rankDecisions', () => {
  it('a named file or symbol is enough on its own', () => {
    expect(rank('please refactor send.ts')).toEqual([['mem', ['mentioned']]]);
    expect(rank('make greet() async')).toEqual([['sym', ['mentioned']]]);
  });
  it('keywords alone need a real overlap; one shared word is noise', () => {
    expect(rank('persist the dedupe ids across restarts in memory')).toEqual([['mem', ['keywords']]]);
    expect(rank('memory usage is high')).toEqual([]);
    expect(rank('把会话存储统一成一种格式')).toEqual([['cn', ['keywords']]]);
  });
  it('a file changed in this range plus some overlap qualifies', () => {
    expect(rank('tweak how dedupe ids expire', ['src/send.ts'])).toEqual([['mem', ['changed', 'keywords']]]);
    expect(rank('tweak how dedupe ids expire')).toEqual([]); // the same two words without the change: noise
  });
  it('superseded decisions and ones already injected at this revision are skipped', () => {
    expect(rank('send.ts', [], ['mem@1'])).toEqual([]);
  });
  it('regression: a long decision no longer collides with an unrelated message on common words', () => {
    const inbox = d('inbox', {
      choice: '把“留住决策”与“接受审阅”分开：候选决策可以在待确认收件箱中单独保留或丢弃，接受整段审阅变为可选项，而不再是决策进入决策库的唯一途径。',
      rationale: '正式版 41 次提取生成了 54 条候选决策，但一次接受都没有发生，所有候选都停留在提取缓存里，决策库为空。',
      alternatives: ['保持现状：决策只能通过打开审阅、勾选候选并点“接受此区间”进入决策库'],
      premises: ['候选决策已存在于提取缓存中', '用户接受了这一方向'],
      links: [{ path: 'packages/feature/decisions/src/server/candidates.ts' }],
    });
    const text = '就解决一个列表标题问题，怎么解决方案这么重，影响第一次打开用户体验了';
    expect(rankDecisions([inbox], text, new Set(), new Set())).toEqual([]);
    // Even with its file changed in this range, common words do not tip it over.
    expect(rankDecisions([inbox], text, new Set(['packages/feature/decisions/src/server/candidates.ts']), new Set())).toEqual([]);
    // A message that is actually about it still matches.
    expect(rankDecisions([inbox], '候选决策还是要接受审阅才能进决策库吗', new Set(), new Set()).map((r) => r.decision.id)).toEqual(['inbox']);
  });

  it('tokens: words and CJK bigrams', () => {
    expect([...tokens('The Dedupe ids 会话存储')].sort()).toEqual(['dedupe', 'ids', '会话', '存储', '话存']);
  });
});
