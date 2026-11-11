/**
 * Candidate inbox: every candidate decision any extraction of this project
 * produced, kept or dismissed one by one — without accepting a whole review.
 *
 * Extractions are cached per input under decisions/<projectId>/extractions,
 * and a long session is extracted many times over overlapping ranges, so the
 * same decision shows up again and again with slightly different wording.
 * Identity: a verified quote (message + verbatim text) names one decision;
 * without one, the normalised choice text does. The newest wording wins.
 * On top of that, choices that read alike (word / CJK-bigram Jaccard ≥ 0.4,
 * calibrated on real extractions) are merged — the same decision quoted
 * from different turns. A merged group is handled as a whole, and anything
 * that reads like an existing decision or a dismissed candidate stays hidden,
 * so handled candidates never come back.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Effect } from 'effect';
import { FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { mutateJsonFile, readJsonFile } from '@cockpit/shared-utils';
import { cleanDecisionContent, type DecisionCandidate, type ExtractionResult } from '../shared/extraction';
import type { Decision, DecisionContent } from '../shared/types';
import { projectDir } from './paths';
import { readGitInfo } from './projectIdentity';
import { createDecision, listDecisions } from './store';
import { tokens } from './relevance';

const execFileAsync = promisify(execFile);

export interface InboxCandidate {
  /** Stable identity across extractions (the representative of its group). */
  key: string;
  /** Every key merged into this candidate — handled together. */
  keys: string[];
  content: DecisionContent;
  source: DecisionCandidate['source'];
  /** Paths as the extraction saw them (relative to its cwd). */
  files: string[];
  /** cwd of the extraction (absent on caches written before it was recorded). */
  cwd?: string;
  sessionId?: string;
  /** When the newest extraction carrying it was written (ms). */
  seenAt: number;
}

interface InboxState {
  kept: string[];
  dismissed: string[];
  /** Choice text of dismissed candidates, so a re-worded repeat stays hidden too. */
  dismissedChoices?: string[];
}

export const SIMILAR = 0.4;

/** Word / CJK-bigram Jaccard similarity of two choices (pure). */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  const union = x.size + y.size - shared;
  return union === 0 ? 0 : shared / union;
}

const stateFile = (projectId: string) => join(projectDir(projectId), 'candidates.json');
const extractionsDir = (projectId: string) => join(projectDir(projectId), 'extractions');

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);

/** Identity of a candidate (pure). */
export function candidateKey(c: Pick<DecisionCandidate, 'content' | 'source'>): string {
  const verified = (c.source.kind === 'user' || c.source.kind === 'agent') && c.source.messageId && c.source.quote;
  return verified ? `q-${sha(`${c.source.messageId}\n${norm(c.source.quote!)}`)}` : `c-${sha(norm(c.content.choice))}`;
}

/** Fold extraction results (oldest → newest) into the inbox, minus handled keys (pure). */
export function collectCandidates(
  results: ReadonlyArray<{ result: ExtractionResult; at: number }>,
  handled: ReadonlySet<string>,
  /** Choices already decided (kept decisions, dismissed candidates). */
  suppress: readonly string[] = [],
): InboxCandidate[] {
  const byKey = new Map<string, InboxCandidate>();
  for (const { result, at } of [...results].sort((a, b) => a.at - b.at)) {
    for (const c of result.candidates ?? []) {
      const content = cleanDecisionContent(c.content);
      if (!content.choice) continue;
      const key = candidateKey({ content, source: c.source });
      if (handled.has(key)) continue;
      byKey.set(key, {
        key,
        keys: [key],
        content,
        source: c.source,
        files: c.files ?? [],
        ...(result.cwd ? { cwd: result.cwd } : {}),
        ...(result.sessionId ?? c.source.sessionId ? { sessionId: result.sessionId ?? c.source.sessionId } : {}),
        seenAt: at,
      });
    }
  }
  // Newest first; a later-seen near-duplicate folds into the newest one.
  const out: InboxCandidate[] = [];
  for (const c of [...byKey.values()].sort((a, b) => b.seenAt - a.seenAt)) {
    if (suppress.some((s) => similarity(s, c.content.choice) >= SIMILAR)) continue;
    const same = out.find((o) => similarity(o.content.choice, c.content.choice) >= SIMILAR);
    if (same) same.keys.push(c.key);
    else out.push(c);
  }
  return out;
}

const readState = (projectId: string): Effect.Effect<InboxState> =>
  Effect.promise(() => readJsonFile<InboxState>(stateFile(projectId), { kept: [], dismissed: [] })).pipe(
    Effect.map((s) => ({
      kept: Array.isArray(s.kept) ? s.kept : [],
      dismissed: Array.isArray(s.dismissed) ? s.dismissed : [],
      dismissedChoices: Array.isArray(s.dismissedChoices) ? s.dismissedChoices : [],
    })),
  );

export const listCandidates = (projectId: string): Effect.Effect<InboxCandidate[]> =>
  Effect.gen(function* () {
    const state = yield* readState(projectId);
    const dir = extractionsDir(projectId);
    const names = yield* Effect.tryPromise(() => readdir(dir)).pipe(Effect.orElseSucceed(() => [] as string[]));
    const results = yield* Effect.forEach(
      names.filter((n) => n.endsWith('.json')),
      (n) =>
        Effect.tryPromise(async () => {
          const file = join(dir, n);
          const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
          return { result: JSON.parse(raw) as ExtractionResult, at: st.mtimeMs };
        }).pipe(Effect.orElseSucceed(() => null)),
      { concurrency: 16 },
    );
    const decided = (yield* listDecisions(projectId).pipe(Effect.orElseSucceed(() => []))).map((d) => d.choice);
    return collectCandidates(
      results.filter((r): r is { result: ExtractionResult; at: number } => r !== null),
      new Set([...state.kept, ...state.dismissed]),
      [...decided, ...(state.dismissedChoices ?? [])],
    );
  });

const markHandled = (projectId: string, c: InboxCandidate, as: 'kept' | 'dismissed'): Effect.Effect<void, FSError> => {
  const file = stateFile(projectId);
  return Effect.tryPromise({
    try: () =>
      mutateJsonFile<InboxState>(file, { kept: [], dismissed: [] }, (cur) => ({
        kept: as === 'kept' ? [...new Set([...(cur.kept ?? []), ...c.keys])] : cur.kept ?? [],
        dismissed: as === 'dismissed' ? [...new Set([...(cur.dismissed ?? []), ...c.keys])] : cur.dismissed ?? [],
        dismissedChoices: as === 'dismissed' ? [...(cur.dismissedChoices ?? []), c.content.choice] : cur.dismissedChoices ?? [],
      })),
    catch: (cause) => new FSError({ path: file, op: 'write', cause }),
  }).pipe(Effect.asVoid);
};

/** Blob id of a working-tree file (null when absent / not hashable). */
const blobOf = (toplevel: string, path: string): Effect.Effect<string | null> =>
  Effect.tryPromise(() => execFileAsync('git', ['hash-object', '--', path], { cwd: toplevel })).pipe(
    Effect.map((r) => r.stdout.trim() || null),
    Effect.orElseSucceed(() => null),
  );

/**
 * Keep a candidate as a decision. Links point at its files as they are now —
 * their content fingerprint lets derived state find where it lands, just like
 * a decision kept from an accepted review. `content` may carry the user's edits.
 */
export const keepCandidate = (
  projectId: string,
  cwd: string,
  key: string,
  content?: DecisionContent,
): Effect.Effect<Decision, FSError | NotFoundError | ValidationError> =>
  Effect.gen(function* () {
    const c = (yield* listCandidates(projectId)).find((x) => x.keys.includes(key));
    if (!c) return yield* Effect.fail(new NotFoundError({ resource: 'candidate', id: key }));
    const toplevel = (yield* readGitInfo(cwd))?.toplevel ?? cwd;
    const base = yield* Effect.promise(() => realpath(c.cwd ?? cwd).catch(() => c.cwd ?? cwd));
    const links = [];
    for (const f of c.files) {
      const rel = relative(toplevel, isAbsolute(f) ? f : resolve(base, f)).split(sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      const blob = yield* blobOf(toplevel, rel);
      links.push({ path: rel, ...(blob ? { blob } : {}) });
    }
    const decision = yield* createDecision(projectId, {
      content: content ?? c.content,
      source: c.source,
      links,
      ...(c.sessionId ? { origin: { sessionId: c.sessionId } } : {}),
    });
    yield* markHandled(projectId, c, 'kept');
    return decision;
  });

export const dismissCandidate = (projectId: string, key: string): Effect.Effect<void, FSError | NotFoundError> =>
  Effect.gen(function* () {
    const c = (yield* listCandidates(projectId)).find((x) => x.keys.includes(key));
    if (!c) return yield* Effect.fail(new NotFoundError({ resource: 'candidate', id: key }));
    yield* markHandled(projectId, c, 'dismissed');
  });
