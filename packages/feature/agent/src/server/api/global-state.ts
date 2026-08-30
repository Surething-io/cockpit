/**
 * /api/global-state — P8+ migration
 */
import { Effect } from "effect"
import { GLOBAL_STATE_FILE, readJsonFile } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  updateGlobalState,
  getSessionPreview,
  attachEngines,
  normalizeStatuses,
  type SessionStatus,
} from "../state/globalState"

interface GlobalSession {
  cwd: string
  sessionId: string
  lastActive: number
  status: SessionStatus
  title?: string
  lastUserMessage?: string
  firstMessages?: string[]
  lastMessages?: string[]
  engine?: string
}

interface GlobalState {
  sessions: GlobalSession[]
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const state = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] }),
      catch: (cause) =>
        new FSError({ path: GLOBAL_STATE_FILE, op: "read", cause }),
    })
    normalizeStatuses(state.sessions)
    state.sessions.sort((a, b) => b.lastActive - a.lastActive)
    // Return the full persisted list (week-bounded, 15–100) enriched with a
    // first/last user-message preview so the search panel can render the same
    // card layout as ProjectSessionsModal. Each entry reads its transcript once;
    // IO is local (<10ms) so a one-shot read on panel open is acceptable.
    const sessions = yield* Effect.all(
      state.sessions.map((session) =>
        Effect.promise(() =>
          // Search panel needs the full-text corpus; the WS snapshot omits it.
          getSessionPreview(session.cwd, session.sessionId, { includeSearchText: true })
        ).pipe(
          Effect.map((preview) => {
            // Live title (summary line preferred). The persisted title is a
            // teardown-time snapshot that predates the summary, so prefer the
            // freshly read one; fall back only when the transcript is gone.
            const title =
              preview.title && preview.title !== "Untitled Session"
                ? preview.title
                : (session.title ?? preview.title)
            return {
              ...session,
              title,
              lastUserMessage: preview.lastUserMessage ?? session.lastUserMessage,
              firstMessages: preview.firstMessages,
              lastMessages: preview.lastMessages,
              // Untruncated full-text corpus for the search panel: cwd + title +
              // summary + every user message (preview.searchText). Display fields
              // above stay truncated; matching reads this instead.
              searchText: `${session.cwd}\n${title}\n${preview.searchText}`,
            }
          })
        )
      ),
      { concurrency: "unbounded" }
    )
    // Engine per session (session.json's `engines` map) — the badge the cards
    // already render but never had data for.
    const withEngines = yield* Effect.promise(() => attachEngines(sessions))
    return ok({ sessions: withEngines })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      sessionId?: string
      status?: SessionStatus
      title?: string
    }
    if (!body.cwd || !body.sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "sessionId",
          reason: "missing",
        })
      )
    }
    const { cwd, sessionId, status, title } = body
    yield* Effect.tryPromise({
      try: () =>
        updateGlobalState(cwd, sessionId, status || "normal", title),
      catch: (cause) =>
        new FSError({ path: GLOBAL_STATE_FILE, op: "write", cause }),
    })
    const state = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] }),
      catch: (cause) =>
        new FSError({ path: GLOBAL_STATE_FILE, op: "read", cause }),
    })
    state.sessions.sort((a, b) => b.lastActive - a.lastActive)
    return ok(state)
  })
)
