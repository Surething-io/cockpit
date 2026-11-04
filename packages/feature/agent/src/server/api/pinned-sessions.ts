import { getSessionTitle } from '../state/globalState';
import { readProjectTitles } from '../../effect/sessionTitles';
import { encodePath } from '@cockpit/shared-utils';
/**
 * /api/pinned-sessions — P6 migration
 *
 * JSON file CRUD template (similar to /api/projects):
 * - GET reads ~/.cockpit/pinned-sessions.json; on failure falls back to an empty array
 * - POST writes (validate body shape via ValidationError)
 */
import { Effect } from "effect"
import {
  PINNED_SESSIONS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

import type { PinnedSession } from '../../shared/pinnedSession';
export type { PinnedSession } from '../../shared/pinnedSession';

export const GET = handler(() =>
  Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<PinnedSession[]>(PINNED_SESSIONS_FILE, []),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => [] as PinnedSession[]))
    const enriched = yield* Effect.forEach(sessions, (session) => Effect.tryPromise({
      try: async () => ({ cwd: session.cwd, sessionId: session.sessionId, title: await getSessionTitle(session.cwd, session.sessionId) }),
      catch: (cause) => new FSError({ path: PINNED_SESSIONS_FILE, op: 'read', cause }),
    }), { concurrency: 8 })
    return ok({ sessions: enriched })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { sessions?: PinnedSession[] }
    if (!Array.isArray(body.sessions) || body.sessions.some((s) => !s || typeof s.cwd !== 'string' || !s.cwd || typeof s.sessionId !== 'string' || !s.sessionId)) {
      return yield* Effect.fail(
        new ValidationError({ field: "sessions", reason: "must be an array of cwd and sessionId records" })
      )
    }
    // Snapshot legacy names before any old record can be removed or overwritten.
    const previous = yield* Effect.tryPromise({ try: () => readJsonFile<PinnedSession[]>(PINNED_SESSIONS_FILE, []), catch: (cause) => new FSError({ path: PINNED_SESSIONS_FILE, op: 'read', cause }) })
    yield* Effect.forEach([...new Set([...previous, ...body.sessions].map((s) => encodePath(s.cwd)))], readProjectTitles)
    yield* Effect.tryPromise({
      try: () =>
        withFileLock(PINNED_SESSIONS_FILE, () =>
          writeJsonFile(PINNED_SESSIONS_FILE, body.sessions!.map(({ cwd, sessionId }) => ({ cwd, sessionId })))
        ),
      catch: (cause) =>
        new FSError({
          path: PINNED_SESSIONS_FILE,
          op: "write",
          cause,
        }),
    })
    return ok({ success: true })
  })
)
