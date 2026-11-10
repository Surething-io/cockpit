/**
 * Decision store — append-only event logs under <COCKPIT_DIR>/decisions/<projectId>/records.
 *
 * Every mutation is one appended JSONL line; nothing is ever rewritten or
 * deleted, so the revision history and the original rationale stay on record
 * (docs/DECISION_MODE.md §7.1). Files are owner-only: decisions quote private
 * conversations.
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { Effect } from 'effect';
import { FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { withFileLock } from '@cockpit/shared-utils';
import {
  foldDecision,
  type Decision,
  type DecisionContent,
  type DecisionEvent,
  type DecisionLink,
  type DecisionOrigin,
  type DecisionSource,
} from '../shared/types';
import { DECISION_ID, recordFile, recordsDir } from './paths';

const SOURCE_KINDS = new Set(['user', 'agent', 'inferred', 'manual']);

// ─────────────────────────────────────────────────────────
// Input validation (pure). Request bodies are untrusted JSON.
// ─────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string';
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every(isStr) ? v.map((s) => s.trim()).filter(Boolean) : null;

const invalid = (field: string, reason: string) => new ValidationError({ field, reason });

export function parseContent(raw: unknown, partial: true): Partial<DecisionContent> | ValidationError;
export function parseContent(raw: unknown, partial: false): DecisionContent | ValidationError;
export function parseContent(raw: unknown, partial: boolean): Partial<DecisionContent> | ValidationError {
  if (typeof raw !== 'object' || raw === null) return invalid('content', 'must be an object');
  const r = raw as Record<string, unknown>;
  const out: Partial<DecisionContent> = {};
  for (const key of ['choice', 'rationale', 'tradeoffs'] as const) {
    if (r[key] === undefined) continue;
    if (!isStr(r[key])) return invalid(`content.${key}`, 'must be a string');
    out[key] = (r[key] as string).trim();
  }
  for (const key of ['alternatives', 'premises'] as const) {
    if (r[key] === undefined) continue;
    const list = strList(r[key]);
    if (!list) return invalid(`content.${key}`, 'must be a string array');
    out[key] = list;
  }
  if (out.choice !== undefined && !out.choice) return invalid('content.choice', 'must not be empty');
  if (partial) return out;
  if (!out.choice) return invalid('content.choice', 'missing');
  return { choice: out.choice, alternatives: out.alternatives ?? [], rationale: out.rationale ?? '', tradeoffs: out.tradeoffs ?? '', premises: out.premises ?? [] };
}

export function parseSource(raw: unknown): DecisionSource | ValidationError {
  if (typeof raw !== 'object' || raw === null) return invalid('source', 'must be an object');
  const r = raw as Record<string, unknown>;
  if (!isStr(r.kind) || !SOURCE_KINDS.has(r.kind)) return invalid('source.kind', 'unknown');
  for (const k of ['quote', 'sessionId', 'messageId']) if (r[k] !== undefined && !isStr(r[k])) return invalid(`source.${k}`, 'must be a string');
  if ((r.kind === 'user' || r.kind === 'agent') && !(isStr(r.quote) && r.quote.trim())) return invalid('source.quote', 'required for user / agent sources');
  return {
    kind: r.kind as DecisionSource['kind'],
    ...(isStr(r.quote) ? { quote: r.quote } : {}),
    ...(isStr(r.sessionId) ? { sessionId: r.sessionId } : {}),
    ...(isStr(r.messageId) ? { messageId: r.messageId } : {}),
  };
}

/** Links are toplevel-relative; absolute paths and `..` segments are rejected. */
export function parseLinks(raw: unknown): DecisionLink[] | ValidationError {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return invalid('links', 'must be an array');
  const out: DecisionLink[] = [];
  for (const l of raw) {
    if (typeof l !== 'object' || l === null || !isStr((l as DecisionLink).path)) return invalid('links.path', 'missing');
    const { path, symbol, blob } = l as DecisionLink;
    const segs = path.split(/[\\/]/);
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || segs.includes('..')) return invalid('links.path', 'must be relative to the repo root');
    if (symbol !== undefined && !isStr(symbol)) return invalid('links.symbol', 'must be a string');
    if (blob !== undefined && !(isStr(blob) && /^[0-9a-f]{40,64}$/.test(blob))) return invalid('links.blob', 'must be a git object id');
    out.push({ path: segs.join('/'), ...(symbol ? { symbol } : {}), ...(blob ? { blob } : {}) });
  }
  return out;
}

export function parseOrigin(raw: unknown): DecisionOrigin | undefined | ValidationError {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null) return invalid('origin', 'must be an object');
  const r = raw as Record<string, unknown>;
  const out: DecisionOrigin = {};
  for (const k of ['sessionId', 'taskId', 'head'] as const) {
    if (r[k] === undefined) continue;
    if (!isStr(r[k])) return invalid(`origin.${k}`, 'must be a string');
    out[k] = r[k] as string;
  }
  return out;
}

// ─────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────

const newDecisionId = (): string => `dec-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

/** Append one event. `create` refuses to touch an existing file (append-only from the very first line). */
const appendEvent = (
  projectId: string,
  decisionId: string,
  event: DecisionEvent,
  create = false,
): Effect.Effect<void, FSError> => {
  const file = recordFile(projectId, decisionId);
  return Effect.tryPromise({
    try: () =>
      withFileLock(file, async () => {
        await mkdir(recordsDir(projectId), { recursive: true, mode: 0o700 });
        await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600, flag: create ? 'wx' : 'a' });
      }),
    catch: (cause) => new FSError({ path: file, op: 'write', cause }),
  });
};

/** Parse a log. A torn / corrupt line is skipped, never "repaired" by rewriting the file. */
export function parseEvents(raw: string): DecisionEvent[] {
  const events: DecisionEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as DecisionEvent;
      if (ev && typeof ev === 'object' && typeof ev.type === 'string' && typeof ev.at === 'number') events.push(ev);
    } catch {
      continue;
    }
  }
  return events;
}

export const readEvents = (projectId: string, decisionId: string): Effect.Effect<DecisionEvent[], NotFoundError | ValidationError | FSError> =>
  Effect.gen(function* () {
    if (!DECISION_ID.test(decisionId)) return yield* Effect.fail(invalid('id', 'malformed'));
    const file = recordFile(projectId, decisionId);
    const raw = yield* Effect.tryPromise({
      try: () => readFile(file, 'utf8'),
      catch: (cause) =>
        (cause as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? new NotFoundError({ resource: 'decision', id: decisionId })
          : new FSError({ path: file, op: 'read', cause }),
    });
    return parseEvents(raw);
  });

const readDecision = (projectId: string, decisionId: string): Effect.Effect<Decision, NotFoundError | ValidationError | FSError> =>
  readEvents(projectId, decisionId).pipe(
    Effect.flatMap((events) => {
      const d = foldDecision(decisionId, events);
      return d ? Effect.succeed(d) : Effect.fail(new NotFoundError({ resource: 'decision', id: decisionId }));
    }),
  );

/** All decision ids of a project (empty when it has none yet). */
const listIds = (projectId: string): Effect.Effect<string[], FSError> => {
  const dir = recordsDir(projectId);
  return Effect.tryPromise({
    try: () => readdir(dir),
    catch: (cause) => new FSError({ path: dir, op: 'read', cause }),
  }).pipe(
    Effect.catchIf(
      (e) => (e.cause as NodeJS.ErrnoException)?.code === 'ENOENT',
      () => Effect.succeed([] as string[]),
    ),
    Effect.map((names) => names.filter((n) => n.endsWith('.jsonl')).map((n) => n.slice(0, -'.jsonl'.length)).filter((id) => DECISION_ID.test(id))),
  );
};

export interface DecisionWithHistory {
  id: string;
  events: DecisionEvent[];
}

export const listHistories = (projectId: string): Effect.Effect<DecisionWithHistory[], FSError> =>
  Effect.gen(function* () {
    const ids = yield* listIds(projectId);
    const all = yield* Effect.forEach(
      ids,
      (id) =>
        readEvents(projectId, id).pipe(
          Effect.map((events) => ({ id, events })),
          Effect.catchTags({ NotFoundError: () => Effect.succeed(null), ValidationError: () => Effect.succeed(null) }),
        ),
      { concurrency: 16 },
    );
    return all.filter((x): x is DecisionWithHistory => x !== null);
  });

/** Current state of every decision, newest first. */
export const listDecisions = (projectId: string): Effect.Effect<Decision[], FSError> =>
  listHistories(projectId).pipe(
    Effect.map((hs) =>
      hs
        .map((h) => foldDecision(h.id, h.events))
        .filter((d): d is Decision => d !== null)
        .sort((a, b) => b.createdAt - a.createdAt),
    ),
  );

export interface CreateDecisionInput {
  content: DecisionContent;
  source: DecisionSource;
  links: DecisionLink[];
  origin?: DecisionOrigin;
  supersedes?: string;
}

/**
 * Create a decision. With `supersedes`, the replaced decision gets a
 * `superseded` status event pointing back here — after the new record exists,
 * so a crash in between leaves a dangling forward link, never a dead end.
 */
export const createDecision = (
  projectId: string,
  input: CreateDecisionInput,
): Effect.Effect<Decision, FSError | NotFoundError | ValidationError> =>
  Effect.gen(function* () {
    if (input.supersedes !== undefined) {
      const old = yield* readDecision(projectId, input.supersedes);
      if (old.status === 'superseded') return yield* Effect.fail(invalid('supersedes', 'already superseded'));
    }
    const id = newDecisionId();
    const at = Date.now();
    yield* appendEvent(
      projectId,
      id,
      {
        type: 'created',
        at,
        content: input.content,
        source: input.source,
        links: input.links,
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      },
      true,
    );
    if (input.supersedes) {
      yield* appendEvent(projectId, input.supersedes, { type: 'status', at, status: 'superseded', supersededBy: id });
    }
    return yield* readDecision(projectId, id);
  });

/** Record an edit. Only fields that actually changed are written; a no-op edit writes nothing. */
export const editDecision = (
  projectId: string,
  decisionId: string,
  patch: { content?: Partial<DecisionContent>; links?: DecisionLink[] },
): Effect.Effect<Decision, FSError | NotFoundError | ValidationError> =>
  Effect.gen(function* () {
    const cur = yield* readDecision(projectId, decisionId);
    const content: Partial<DecisionContent> = {};
    for (const [k, v] of Object.entries(patch.content ?? {}) as Array<[keyof DecisionContent, DecisionContent[keyof DecisionContent]]>) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(v)) (content as Record<string, unknown>)[k] = v;
    }
    const linksChanged = patch.links !== undefined && JSON.stringify(cur.links) !== JSON.stringify(patch.links);
    if (Object.keys(content).length === 0 && !linksChanged) return cur;
    yield* appendEvent(projectId, decisionId, {
      type: 'edited',
      at: Date.now(),
      ...(Object.keys(content).length ? { content } : {}),
      ...(linksChanged ? { links: patch.links } : {}),
    });
    return yield* readDecision(projectId, decisionId);
  });

/** Record a review verdict on a decision (append-only; does not count as an edit). */
export const recordReview = (
  projectId: string,
  decisionId: string,
  taskId: string,
  verdict: 'holds' | 'unrelated',
): Effect.Effect<void, FSError | NotFoundError | ValidationError> =>
  readDecision(projectId, decisionId).pipe(
    Effect.flatMap(() => appendEvent(projectId, decisionId, { type: 'reviewed', at: Date.now(), taskId, verdict })),
  );

/**
 * Retire a decision (its subject no longer exists; reason required) or bring a
 * retired one back. Superseding goes through createDecision so it always has a
 * replacement to point at.
 */
export const setDecisionStatus = (
  projectId: string,
  decisionId: string,
  status: 'retired' | 'active',
  reason?: string,
): Effect.Effect<Decision, FSError | NotFoundError | ValidationError> =>
  Effect.gen(function* () {
    const cur = yield* readDecision(projectId, decisionId);
    if (status === 'retired' && !reason?.trim()) return yield* Effect.fail(invalid('reason', 'required to retire a decision'));
    if (cur.status === 'superseded') return yield* Effect.fail(invalid('status', 'a superseded decision cannot change status'));
    if (cur.status === status) return cur;
    yield* appendEvent(projectId, decisionId, { type: 'status', at: Date.now(), status, ...(reason?.trim() ? { reason: reason.trim() } : {}) });
    return yield* readDecision(projectId, decisionId);
  });
