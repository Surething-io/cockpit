/**
 * Which decisions to put in front of the next message (docs/DECISION_MODE.md §7.2).
 *
 * Signals, strongest first: the message names a linked file or symbol; a
 * linked file was changed in the current review range; enough words overlap
 * with the decision's text. Only active decisions that apply here (or are
 * still uncommitted locally) are offered, at most three, and never one the
 * session has already seen at the same revision.
 */
import { Effect } from 'effect';
import type { Decision } from '../shared/types';
import { derivedContext, deriveState } from './derived';

export const MAX_INJECTED = 3;
const MIN_SCORE = 3;
/** Share of shared words (of the shorter of choice / message) needed for a keyword match. */
const KEYWORD_SHARE = 0.3;
const KEYWORD_SHARE_WEAK = 0.2;

export type RelevanceReason = 'mentioned' | 'changed' | 'keywords';

export interface RankedDecision {
  decision: Decision;
  score: number;
  reasons: RelevanceReason[];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'use', 'can', 'all', 'any', 'into', 'when', 'then', 'than', 'only', 'keep', 'make', 'will', 'should', 'would', 'could', 'have', 'has']);

/** Lower-case words (3+ chars) and CJK character bigrams — no tokenizer dependency. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9_]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const run of lower.match(/[一-鿿]{2,}/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

const basename = (p: string) => p.split('/').pop() ?? p;

/** Pure ranking. `changedFiles` are toplevel-relative. */
export function rankDecisions(
  decisions: readonly Decision[],
  text: string,
  changedFiles: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): RankedDecision[] {
  const words = tokens(text);
  const lowerText = text.toLowerCase();
  const out: RankedDecision[] = [];
  for (const d of decisions) {
    if (d.status !== 'active' || exclude.has(`${d.id}@${d.updatedAt}`)) continue;
    let score = 0;
    const reasons = new Set<RelevanceReason>();
    for (const l of d.links) {
      const base = basename(l.path).toLowerCase();
      const named = lowerText.includes(l.path.toLowerCase()) || (base.length >= 4 && base.includes('.') && lowerText.includes(base));
      const symbol = !!l.symbol && l.symbol.length >= 3 && new RegExp(`\\b${l.symbol.split('>').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
      if (named || symbol) reasons.add('mentioned');
      if (changedFiles.has(l.path)) reasons.add('changed');
    }
    if (reasons.has('mentioned')) score += 3;
    if (reasons.has('changed')) score += 2;
    // Keywords compare against the CHOICE only, and must cover a real share of it.
    // Matching the whole record (rationale, alternatives, premises) let a long
    // decision collide with any message on common words — a real case attached a
    // decision about the review inbox to "list titles load slowly" on 一次 / 用户 / 打开.
    const own = tokens(d.choice);
    let overlap = 0;
    for (const w of own) if (words.has(w)) overlap++;
    // Share of the shorter text, so neither a long choice nor a long message dilutes a real match.
    const share = overlap / Math.max(1, Math.min(own.size, words.size));
    if (overlap >= 3 && share >= KEYWORD_SHARE) {
      score += 3;
      reasons.add('keywords');
    } else if (overlap >= 2 && share >= KEYWORD_SHARE_WEAK) {
      // Only enough to tip a "changed in this range" match over the threshold.
      score += 1;
      reasons.add('keywords');
    }
    if (score >= MIN_SCORE) out.push({ decision: d, score, reasons: [...reasons] });
  }
  return out.sort((a, b) => b.score - a.score || b.decision.updatedAt - a.decision.updatedAt);
}

/** Rank, then keep only decisions that apply here; derived state is computed for the top few only. */
export const relevantDecisions = (
  projectId: string,
  cwd: string,
  decisions: readonly Decision[],
  text: string,
  changedFiles: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): Effect.Effect<RankedDecision[]> =>
  Effect.gen(function* () {
    const ranked = rankDecisions(decisions, text, changedFiles, exclude).slice(0, MAX_INJECTED * 3);
    if (ranked.length === 0) return [];
    const ctx = yield* derivedContext(projectId, cwd, ranked.map((r) => r.decision));
    const out: RankedDecision[] = [];
    for (const r of ranked) {
      const state = yield* deriveState(r.decision, ctx);
      if (state === 'applicable' || state === 'not-landed') out.push(r);
      if (out.length === MAX_INJECTED) break;
    }
    return out;
  });
