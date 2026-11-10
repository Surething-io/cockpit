/**
 * Decision-mode AI extraction (docs/DECISION_MODE.md §9): goal, result
 * summary and candidate decisions for a review range.
 *
 * Pipeline: deterministic input assembly → one-shot structured model call per
 * chunk → deterministic validation → cache. The model never decides a source,
 * and nothing it cites is trusted until it is found in the range.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { AgentError, AppError, FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { SnapshotService } from '@cockpit/effect-services';
import {
  computeReview,
  requireProject,
  type DecisionCandidate,
  type EvidenceRef,
  type ExtractionEngine,
  type ExtractionMessage,
  type ExtractionResult,
  type SummaryItem,
  type VerificationRunInput,
} from '@cockpit/feature-decisions/server';
import { projectDir } from '@cockpit/feature-decisions/server/paths';
import { OLLAMA_FALLBACK_CTX, ollamaContextWindow, oneShotJson } from './oneShot';
import { verifyRange } from './verification';

/** Bump when the prompt or schema changes — invalidates the cache. */
export const PROMPT_VERSION = 2;

const SYSTEM = `You review one task an AI coding agent did in a software project, for the developer who must decide whether to accept it.

From the conversation, changed files and checks below, extract:
1. "goal": what the user wanted, one short sentence.
2. "summary": the observable result — behaviour changes, what was and was not done. Every item cites its evidence labels ([M#] message, [F#] file, [R#] check) in "refs". Do not claim anything you cannot cite.
3. "decisions": choices between real alternatives with lasting consequences — external behaviour or compatibility, a new dependency or long-term maintenance cost, a change of responsibilities, an accepted limitation for speed or performance, or a change to an earlier constraint. Skip naming and local implementation details. Return an empty list when there are none.
   Each decision is ONE choice. Do not merge choices made by different people or at different times — e.g. something the user asked for and a parameter the agent picked are two decisions.
   For each decision: "quote" is text COPIED EXACTLY (character for character, at most 200 characters) from the ONE message where THAT choice was made, and "ref" is that message's label. If the agent made the choice, quote the agent. Do not paraphrase the quote. "files" lists the [F#] labels the decision is about.
   Do not put [M#] / [F#] / [R#] labels inside "goal" or any text field; use "refs".

Never invent alternatives, reasons or quotes that are not in the material. Write in the language the user writes in.`;

export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'summary', 'decisions'],
  properties: {
    goal: { type: 'string' },
    summary: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'refs'],
        properties: { text: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } },
      },
    },
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['choice', 'alternatives', 'rationale', 'tradeoffs', 'premises', 'quote', 'ref', 'files'],
        properties: {
          choice: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
          tradeoffs: { type: 'string' },
          premises: { type: 'array', items: { type: 'string' } },
          quote: { type: 'string' },
          ref: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────
// Input assembly (pure)
// ─────────────────────────────────────────────────────────

export interface LabelledInput {
  messages: Array<{ label: string; msg: ExtractionMessage }>;
  files: Array<{ label: string; path: string; line: string }>;
  runs: Array<{ label: string; toolId: string; line: string }>;
}

export function labelInput(
  messages: ExtractionMessage[],
  files: Array<{ path: string; status: string; additions: number; deletions: number }>,
  runs: Array<{ toolId: string; command: string; state: string }>,
): LabelledInput {
  return {
    messages: messages.map((msg, i) => ({ label: `M${i + 1}`, msg })),
    files: files.map((f, i) => ({ label: `F${i + 1}`, path: f.path, line: `${f.path} (${f.status} +${f.additions} -${f.deletions})` })),
    runs: runs.map((r, i) => ({ label: `R${i + 1}`, toolId: r.toolId, line: `${r.command} — ${r.state}` })),
  };
}

const TOOL_LINE_MAX = 200;

function renderMessage({ label, msg }: LabelledInput['messages'][number]): string {
  // User text is never shortened; tool lines are capped — they are pointers, not evidence.
  const tools = msg.tools.length ? `\n  tools: ${msg.tools.map((t) => t.slice(0, TOOL_LINE_MAX)).join('; ')}` : '';
  return `[${label}] ${msg.role === 'user' ? 'USER' : 'AGENT'}:\n${msg.text}${tools}`;
}

/**
 * Prompts that each fit `budgetChars`. Files and checks go in every chunk;
 * messages are split in order. One message larger than the whole budget gets
 * a chunk of its own rather than being cut.
 */
export function buildPrompts(input: LabelledInput, budgetChars: number): string[] {
  const shared = [
    '## Files changed',
    ...(input.files.length ? input.files.map((f) => `[${f.label}] ${f.line}`) : ['(none)']),
    '',
    '## Checks run',
    ...(input.runs.length ? input.runs.map((r) => `[${r.label}] ${r.line}`) : ['(none)']),
  ].join('\n');
  const room = Math.max(budgetChars - shared.length - 200, 1000);
  const chunks: string[][] = [[]];
  let used = 0;
  for (const m of input.messages) {
    const text = renderMessage(m);
    if (used > 0 && used + text.length > room) {
      chunks.push([]);
      used = 0;
    }
    chunks[chunks.length - 1].push(text);
    used += text.length + 2;
  }
  return chunks.map((c, i) =>
    [`## Conversation${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}`, ...c, '', shared].join('\n\n'),
  );
}

// ─────────────────────────────────────────────────────────
// Validation (pure)
// ─────────────────────────────────────────────────────────

/** Whitespace-insensitive, and blind to the quote marks models like to normalise. */
export const normalizeForQuote = (s: string): string =>
  s
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => str(x, 500)).filter(Boolean) : []);
const stripLabel = (s: string) => s.replace(/^\[|\]$/g, '').trim();
/** Labels belong in refs; some models still write `[M1]` into prose. */
const unlabel = (s: string) => s.replace(/\s*\[(?:M|F|R)\d+\]/g, '').trim();

export function validateExtraction(
  raw: unknown,
  input: LabelledInput,
  sessionId: string | undefined,
): Pick<ExtractionResult, 'goal' | 'summary' | 'candidates'> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const msgByLabel = new Map(input.messages.map((m) => [m.label, m.msg]));
  const fileByLabel = new Map(input.files.map((f) => [f.label, f.path]));
  const runByLabel = new Map(input.runs.map((r) => [r.label, r.toolId]));

  const evidence = (refs: unknown): EvidenceRef[] => {
    const out: EvidenceRef[] = [];
    for (const r of strs(refs).map(stripLabel)) {
      const m = msgByLabel.get(r);
      if (m) out.push({ kind: 'message', id: m.id, label: r });
      else if (fileByLabel.has(r)) out.push({ kind: 'file', id: fileByLabel.get(r)!, label: r });
      else if (runByLabel.has(r)) out.push({ kind: 'run', id: runByLabel.get(r)!, label: r });
    }
    return out;
  };

  const summary: SummaryItem[] = (Array.isArray(o.summary) ? o.summary : [])
    .map((it) => (it && typeof it === 'object' ? (it as Record<string, unknown>) : {}))
    .map((it) => ({ text: unlabel(str(it.text, 600)), evidence: evidence(it.refs) }))
    .filter((it) => it.text);

  const candidates: DecisionCandidate[] = [];
  (Array.isArray(o.decisions) ? o.decisions : []).forEach((d, i) => {
    const r = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
    const choice = str(r.choice, 500);
    if (!choice) return;
    const quote = str(r.quote, 600);
    const ref = stripLabel(str(r.ref, 20));
    const cited = msgByLabel.get(ref);
    // The quote must be found in the message it cites; the role of THAT message is the source.
    const verbatim = !!cited && !!quote && normalizeForQuote(cited.text).includes(normalizeForQuote(quote));
    candidates.push({
      key: `c${i}`,
      content: { choice, alternatives: strs(r.alternatives), rationale: str(r.rationale), tradeoffs: str(r.tradeoffs), premises: strs(r.premises) },
      source: verbatim
        ? { kind: cited!.role === 'user' ? 'user' : 'agent', quote, messageId: cited!.id, ...(sessionId ? { sessionId } : {}) }
        : { kind: 'inferred', ...(quote ? { quote } : {}) },
      files: strs(r.files).map(stripLabel).map((l) => fileByLabel.get(l)).filter((p): p is string => !!p),
    });
  });

  return { goal: unlabel(str(o.goal, 200)), summary, candidates };
}

/** Merge per-chunk results: first goal wins, the rest concatenates (keys stay unique). */
export function mergeChunks(parts: Array<Pick<ExtractionResult, 'goal' | 'summary' | 'candidates'>>): Pick<ExtractionResult, 'goal' | 'summary' | 'candidates'> {
  return {
    goal: parts.find((p) => p.goal)?.goal ?? '',
    summary: parts.flatMap((p) => p.summary),
    candidates: parts.flatMap((p, i) => p.candidates.map((c) => ({ ...c, key: `${i}-${c.key}` }))),
  };
}

// ─────────────────────────────────────────────────────────
// Effect: assemble → call → validate → cache
// ─────────────────────────────────────────────────────────

/** Prompt budget in characters (≈ 3 chars / token, leaving room for the answer). */
function budgetFor(engine: ExtractionEngine, ollamaCtx: number): number {
  if (engine === 'ollama') return Math.max(Math.floor(ollamaCtx * 2.5) - 6000, 4000);
  return 300_000;
}

const CALL_TIMEOUT_MS = 180_000;

export interface ExtractionRequest {
  cwd: string;
  sessionId?: string;
  engine: ExtractionEngine;
  model: string;
  messages: ExtractionMessage[];
  orderedToolIds: string[];
  runs: VerificationRunInput[];
  claimedPass: boolean;
}

export const extract = (
  req: ExtractionRequest,
): Effect.Effect<ExtractionResult, AgentError | AppError | FSError | NotFoundError | ValidationError, SnapshotService> =>
  Effect.gen(function* () {
    const project = yield* requireProject(req.cwd);
    const review = yield* computeReview(req.cwd, req.orderedToolIds, false);
    const files = review.empty ? [] : review.files.filter((f) => f.category !== 'other-session');
    const verification = yield* verifyRange(req.cwd, req.orderedToolIds, req.runs, req.claimedPass);
    const input = labelInput(req.messages, files, verification.runs);

    const ctxWindow = req.engine === 'ollama'
      ? (yield* Effect.promise(() => ollamaContextWindow(req.model, AbortSignal.timeout(8000)).catch(() => null))) ?? OLLAMA_FALLBACK_CTX
      : 0;
    const prompts = buildPrompts(input, budgetFor(req.engine, ctxWindow));

    const key = createHash('sha256').update(JSON.stringify({ v: PROMPT_VERSION, engine: req.engine, model: req.model, sessionId: req.sessionId, prompts })).digest('hex');
    const cacheFile = join(projectDir(project.projectId), 'extractions', `${key.slice(0, 32)}.json`);
    const cached = yield* Effect.tryPromise(() => readFile(cacheFile, 'utf8')).pipe(
      Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as ExtractionResult)),
      Effect.orElseSucceed(() => null),
    );
    if (cached) return { ...cached, cached: true };

    const parts = yield* Effect.forEach(
      prompts,
      (prompt) =>
        oneShotJson({ engine: req.engine, model: req.model, system: SYSTEM, prompt, schema: EXTRACTION_SCHEMA, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) }, ctxWindow).pipe(
          // One retry for a malformed answer (§9): providers differ in how well they follow a schema.
          Effect.retry({ times: 1 }),
          Effect.map((raw) => validateExtraction(raw, input, req.sessionId)),
        ),
      { concurrency: 1 },
    );
    const result: ExtractionResult = { ...mergeChunks(parts), engine: req.engine, model: req.model, chunks: prompts.length, cached: false };

    yield* Effect.tryPromise(async () => {
      await mkdir(join(projectDir(project.projectId), 'extractions'), { recursive: true, mode: 0o700 });
      await writeFile(cacheFile, JSON.stringify(result), { mode: 0o600 });
    }).pipe(Effect.orElseSucceed(() => undefined)); // a failed cache write only costs a re-run
    return result;
  });
