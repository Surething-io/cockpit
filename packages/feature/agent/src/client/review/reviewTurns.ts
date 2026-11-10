/**
 * Turns of a conversation for decision-mode review (docs/DECISION_MODE.md §3). Pure.
 *
 * A turn starts at a user message and runs until the next one; its tool-call
 * ids are what identify its snapshot commits. Tool-call ids are engine ids
 * that survive a history reload, unlike live bubble ids, which is why "already
 * accepted" is decided by tool ids rather than by turn ids.
 */
import type { ReviewTurn } from '@cockpit/feature-decisions';
import type { ChatMessage } from '../types';

const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120);

export function buildReviewTurns(messages: readonly ChatMessage[]): ReviewTurn[] {
  const turns: ReviewTurn[] = [];
  let cur: ReviewTurn | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      cur = { id: m.id, text: firstLine(m.content), toolIds: [], ...(m.timestamp ? { at: m.timestamp } : {}) };
      turns.push(cur);
    } else if (m.role === 'assistant' && cur && m.toolCalls) {
      for (const tc of m.toolCalls) if (tc.id) cur.toolIds.push(tc.id);
    }
  }
  return turns;
}

/**
 * Default review range: every turn after the last one whose tool calls were
 * all accepted already. With nothing accepted yet, start at the turn the
 * decision-mode switch was turned on (§2) — older history is not swept into
 * the first review.
 */
export function defaultRangeStart(
  turns: readonly ReviewTurn[],
  acceptedToolIds: ReadonlySet<string>,
  enabledAt: number | undefined,
): number {
  let lastCovered = -1;
  turns.forEach((t, i) => {
    if (t.toolIds.length > 0 && t.toolIds.every((id) => acceptedToolIds.has(id))) lastCovered = i;
  });
  if (lastCovered >= 0) return lastCovered + 1;
  if (enabledAt === undefined) return 0;
  const i = turns.findIndex((t) => !t.at || Date.parse(t.at) >= enabledAt);
  return i < 0 ? turns.length : i;
}
