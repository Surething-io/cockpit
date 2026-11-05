import { readProjectTitles, titleFromProject, titleStore } from '../../../effect/sessionTitles';
import * as path from 'path';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR, GROK_SESSIONS_DIR, COCKPIT_PROJECTS_DIR, PI_SESSIONS_DIR, encodePath, normalizeCodexSessionId } from '@cockpit/shared-utils';
import { listPiSessions } from '../../../effect/piSessionLive';
import { dynamicHandler } from '@cockpit/effect-runtime/server';
import { isJsonObject, readJsonOr } from '@cockpit/effect-runtime/server/fs';
import { ValidationError, FSError } from '@cockpit/effect-core';
import { TranscriptIndex } from '@cockpit/effect-services';
import { detectBotName } from '../../../shared/botSession';
import type { SessionListItem } from '../../../shared/sessionDto';
import { defaultSessionTitle, isCodexSubagent, listMessages } from '../../transcriptViews';
import { listLogicalTranscriptFiles, readLogicalTranscript } from '../../../effect/logicalTranscript';
import { transcriptExists } from '../../../effect/transcriptPresence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** One row of this list. Field list: shared/sessionDto.ts. */
type SessionInfo = SessionListItem;

// Truncate a message to the specified length
function truncateMessage(msg: string, maxLength: number = 50): string {
  if (msg.length <= maxLength) return msg;
  return msg.slice(0, maxLength) + '...';
}

// Build the untruncated, lowercased search corpus: the display title (summary
// preferred) plus every user message in full. Keeps long-message tails and
// mid-conversation messages searchable despite the truncated/sampled display.
function buildSearchText(title: string, userMessages: string[]): string {
  return [title, ...userMessages].join('\n').toLowerCase();
}

function buildSessionInfo(
  filePath: string,
  sessionId: string,
  modifiedAt: Date,
  engine: SessionInfo['engine'],
  displayTitle: string,
  userMessages: string[],
): SessionInfo | null {
  if (userMessages.length === 0) return null;

  const firstMessages = userMessages.length <= 10
    ? userMessages.map(m => truncateMessage(m))
    : userMessages.slice(0, 5).map(m => truncateMessage(m));
  const lastMessages = userMessages.length <= 10
    ? []
    : userMessages.slice(-5).map(m => truncateMessage(m));
  const bot = detectBotName(userMessages[0]);

  return {
    sessionId,
    path: filePath,
    title: displayTitle,
    modifiedAt: modifiedAt.toISOString(),
    firstMessages,
    lastMessages,
    searchText: buildSearchText(displayTitle, userMessages),
    engine,
    // Free — this list already holds every user message; [0] is the line a Bot
    // dispatch writes.
    ...(bot ? { bot } : {}),
  };
}

interface SessionFile {
  name: string;
  path: string;
  engine?: SessionInfo['engine'];
}

const collectSessionFiles = (dir: string, engine: string): Effect.Effect<SessionFile[], FSError> =>
  listLogicalTranscriptFiles(dir, engine).pipe(
    Effect.map((files) => files.map((name) => ({ name, path: path.join(dir, name), engine: engine as SessionInfo['engine'] }))),
  );

// Read cockpit session.json to find codex session IDs. Codex is the only engine left
// that needs this indirection: its transcripts live outside the cwd-encoded layout
// (~/.codex/sessions/<date-dirs>/rollout-…jsonl), so the session.json engines map is the
// only way to learn which ids belong to this project. Every other engine is found by
// scanning its own project directory above.
const getCodexSessionIds = (encodedPath: string): Effect.Effect<string[], never> =>
  readJsonOr<{ sessions?: unknown; engines?: Record<string, unknown> } | null>(
    path.join(COCKPIT_PROJECTS_DIR, encodedPath, 'session.json'),
    null,
    isJsonObject,
  ).pipe(
    Effect.map((state) => {
      if (!Array.isArray(state?.sessions) || !state.engines || typeof state.engines !== 'object') return [];
      const engines = state.engines;
      return state.sessions.filter((id): id is string => typeof id === 'string' && engines[id] === 'codex');
    })
  );

export const GET = dynamicHandler<
  { encodedPath: string },
  ValidationError | import("@cockpit/effect-core").FSError
>((_req, { encodedPath }) =>
  Effect.gen(function* () {
    if (!encodedPath) {
      return yield* Effect.fail(
        new ValidationError({ field: 'encodedPath', reason: 'missing' })
      );
    }
    const sessions = yield* loadSessions(encodedPath);
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);

interface ListSource {
  sessionId: string;
  path: string;
  engine: SessionInfo['engine'];
}

/**
 * Every session of one project across all engine stores. Row content comes from
 * the transcript index, so an unchanged transcript costs a stat, not a parse.
 */
const loadSessions = (encodedPath: string) =>
  Effect.gen(function* () {
    // Claude native files are indexed here; Pi and Codex use their own readers below.
    const stores = yield* Effect.forEach(
      [
        { dir: path.join(CLAUDE_PROJECTS_DIR, encodedPath), engine: 'claude' as const },
        { dir: path.join(GROK_SESSIONS_DIR, encodedPath), engine: 'grok' as const },
      ],
      ({ dir, engine }) => collectSessionFiles(dir, engine),
      { concurrency: 'unbounded' }
    );

    // Deduplicate by filename (same sessionId could theoretically appear in both)
    const seen = new Set<string>();
    const sources: ListSource[] = [];
    for (const f of stores.flat()) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      sources.push({ sessionId: f.name.replace(/\.jsonl$/, ''), path: f.path, engine: f.engine });
    }

    for (const pi of yield* listPiSessions().pipe(Effect.mapError((cause) => new FSError({ path: PI_SESSIONS_DIR, op: 'read', cause })))) {
      if (encodePath(pi.cwd) !== encodedPath) continue;
      sources.push({ sessionId: pi.id, path: pi.path, engine: pi.engine });
    }

    // Codex: current Cockpit state is the fast path, and the global index backfills
    // sessions registered by another COCKPIT_HOME.
    const index = yield* TranscriptIndex;
    const codexPaths = new Map<string, string>();
    for (const sessionId of yield* getCodexSessionIds(encodedPath)) {
      const entry = yield* index.resolveCodex(sessionId);
      if (entry) codexPaths.set(entry.path, normalizeCodexSessionId(sessionId));
    }
    // Sessions the user started in this project; sub-agent rollouts are reached from
    // their parent's Task bubble instead.
    for (const entry of yield* index.codexSessions) {
      if (isCodexSubagent(entry)) continue;
      if (encodePath(entry.cwd) !== encodedPath && encodePath(entry.cwdRealpath) !== encodedPath) continue;
      codexPaths.set(entry.path, entry.id);
    }
    for (const [filePath, sessionId] of codexPaths) {
      // Skip if already found (e.g. session was also saved as Claude format)
      if (seen.has(`${sessionId}.jsonl`)) continue;
      sources.push({ sessionId, path: filePath, engine: 'codex' });
    }

    const titles = yield* readProjectTitles(encodedPath);
    const views = yield* Effect.forEach(sources, (source) => readLogicalTranscript(source.path, source.engine ?? 'claude', (view) =>
      view.projection.pipe(Effect.map((projection) => ({ projection, mtimeMs: view.mtimeMs }))),
    ).pipe(Effect.catchAll((error) => transcriptExists(source.path, source.engine ?? 'claude').pipe(
      Effect.flatMap((exists) => exists ? Effect.fail(error) : Effect.succeed(null)),
    ))), { concurrency: 4 });
    const sessions: SessionInfo[] = [];
    sources.forEach((source, i) => {
      const view = views[i];
      if (!view) return;
      const snap = view.projection;
      const session = buildSessionInfo(
        source.path,
        source.sessionId,
        // fs.Stats.mtime rounds mtimeMs; match it so modifiedAt is unchanged.
        new Date(Math.round(view.mtimeMs)),
        source.engine,
        defaultSessionTitle(snap),
        listMessages(snap),
      );
      if (session) {
        const metadata = titleFromProject(titles, source.sessionId, session.title, titleStore(source.engine), snap.cwd);
        sessions.push({ ...session, ...metadata, searchText: session.searchText });
      }
    });

    // Sort all sessions by modification time descending
    sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    return sessions;
  });
