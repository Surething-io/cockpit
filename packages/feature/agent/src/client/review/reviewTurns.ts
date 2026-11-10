/**
 * Turns of a conversation for decision-mode review (docs/DECISION_MODE.md §3). Pure.
 *
 * A turn starts at a user message and runs until the next one; its tool-call
 * ids are what identify its snapshot commits. Tool-call ids are engine ids
 * that survive a history reload, unlike live bubble ids, which is why "already
 * accepted" is decided by tool ids rather than by turn ids.
 */
import type { ExtractionMessage, ReviewTurn } from '@cockpit/feature-decisions';
import type { ChatMessage, ToolCallInfo } from '../types';
import { extractRuns, isShellTool, resolveExit, type CommandRun } from '../../shared/commandRuns';

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

/**
 * The agent saying tests pass. Only used to flag a claim with NO test run on
 * record (§5) — never as evidence that something passed.
 */
const PASS_CLAIM = /\b(all )?(the )?tests? (are |now )*(pass(ing|ed|es)?|green|succeed(ed|s)?)\b|测试(已经|已|都|全部|均)*(通过|过了)/gi;
/** "could not make the tests pass", "测试没有通过" — a negation just before the match. */
const NEGATED = /(\b(not|never|cannot|can't|couldn't|didn't|don't|doesn't|won't|unable|fail(ed|s)?)\b[^.!?\n]{0,24}|(没有|没|未|不|无法)[^。！？\n]{0,4})$/i;

function claimsPass(text: string): boolean {
  for (const m of text.matchAll(PASS_CLAIM)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const inside = m[0];
    if (!NEGATED.test(before) && !/(没有|没|未|不)(通过|过了)/.test(inside)) return true;
  }
  return false;
}

export interface RangeEvidence {
  /** Every tool call of the selected turns, in order. */
  orderedToolIds: string[];
  runs: CommandRun[];
  claimedPass: boolean;
}

/** Command runs and pass claims of the turns in `turnIds` (user message ids). */
export function rangeEvidence(messages: readonly ChatMessage[], turnIds: ReadonlySet<string>): RangeEvidence {
  const ordered: Array<{ call: ToolCallInfo; at?: string }> = [];
  let inRange = false;
  let claimedPass = false;
  for (const m of messages) {
    if (m.role === 'user') {
      inRange = turnIds.has(m.id);
      continue;
    }
    if (!inRange || m.role !== 'assistant') continue;
    if (claimsPass(m.content)) claimedPass = true;
    for (const tc of m.toolCalls ?? []) ordered.push({ call: tc, ...(m.timestamp ? { at: m.timestamp } : {}) });
  }
  return { orderedToolIds: ordered.map((o) => o.call.id), runs: extractRuns(ordered), claimedPass };
}

const toolTarget = (tc: ToolCallInfo): string => {
  const i = tc.input as Record<string, unknown>;
  const v = i.file_path ?? i.notebook_path ?? i.path ?? i.command ?? i.pattern ?? i.url ?? i.description;
  return typeof v === 'string' ? v : '';
};

/** One line per tool call — a pointer for the model, not evidence. */
function toolLine(tc: ToolCallInfo): string {
  const target = toolTarget(tc);
  const shown = isShellTool(tc.name) ? `\`${target}\`` : target;
  const outcome = isShellTool(tc.name) ? resolveExit(tc) : null;
  const tail = outcome?.kind === 'exit' ? ` (exit ${outcome.code})` : '';
  return `${tc.name}${shown ? ` ${shown}` : ''}${tail}`;
}

/**
 * The conversation of the selected turns, condensed for extraction (§9):
 * user and agent text kept whole, tool calls reduced to one line each.
 */
export function extractionMessages(messages: readonly ChatMessage[], turnIds: ReadonlySet<string>): ExtractionMessage[] {
  const out: ExtractionMessage[] = [];
  let inRange = false;
  for (const m of messages) {
    if (m.role === 'user') {
      inRange = turnIds.has(m.id);
      if (inRange) out.push({ id: m.id, role: 'user', text: m.content, tools: [] });
      continue;
    }
    if (!inRange || m.role !== 'assistant') continue;
    const tools = (m.toolCalls ?? []).map(toolLine);
    if (m.content.trim() || tools.length) out.push({ id: m.id, role: 'agent', text: m.content, tools });
  }
  return out;
}
