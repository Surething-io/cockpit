/**
 * POST /api/decisions/extraction
 *   { cwd, sessionId?, engine, model, messages, orderedToolIds, runs, claimedPass }
 *   → ExtractionResult (docs/DECISION_MODE.md §9)
 *
 * Goal, result summary and candidate decisions for a review range, from a
 * one-shot model call that leaves no session behind, validated
 * deterministically and cached. Requires decision mode on.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { ValidationError } from '@cockpit/effect-core';
import { requireProject, type ExtractionEngine, type ExtractionMessage } from '@cockpit/feature-decisions/server';
import { extract } from '../review/extraction';
import { EXTRACTION_ENGINES } from '../review/oneShot';
import { parseRuns } from '../review/verification';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_MESSAGES = 2000;
const MAX_TEXT = 200_000;

function parseMessages(raw: unknown): ExtractionMessage[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_MESSAGES) return null;
  const out: ExtractionMessage[] = [];
  for (const m of raw as Array<Record<string, unknown>>) {
    if (!m || typeof m.id !== 'string' || (m.role !== 'user' && m.role !== 'agent') || typeof m.text !== 'string') return null;
    const tools = Array.isArray(m.tools) ? m.tools.filter((t): t is string => typeof t === 'string').slice(0, 200) : [];
    out.push({ id: m.id, role: m.role, text: m.text.slice(0, MAX_TEXT), tools });
  }
  return out;
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Record<string, unknown>;
    const bad = (field: string, reason = 'missing') => Effect.fail(new ValidationError({ field, reason }));
    if (typeof body.cwd !== 'string' || !body.cwd) return yield* bad('cwd');
    if (!EXTRACTION_ENGINES.includes(body.engine as ExtractionEngine)) return yield* bad('engine', 'unsupported');
    if (typeof body.model !== 'string' || !body.model.trim()) return yield* bad('model');
    const messages = parseMessages(body.messages);
    if (!messages) return yield* bad('messages', 'malformed');
    if (!Array.isArray(body.orderedToolIds) || !body.orderedToolIds.every((x) => typeof x === 'string')) return yield* bad('orderedToolIds', 'must be a string array');
    const runs = parseRuns(body.runs);
    if (!runs) return yield* bad('runs', 'malformed');
    const project = yield* requireProject(body.cwd);
    if (!project.enabled) return yield* bad('decisionMode', 'disabled for this project');
    return ok(
      yield* extract({
        cwd: body.cwd,
        ...(typeof body.sessionId === 'string' && body.sessionId ? { sessionId: body.sessionId } : {}),
        engine: body.engine as ExtractionEngine,
        model: body.model.trim(),
        messages,
        orderedToolIds: body.orderedToolIds as string[],
        runs,
        claimedPass: body.claimedPass === true,
      }),
    );
  }),
);
