import { readProjectTitles } from '../../effect/sessionTitles';
/**
 * /api/global-state — P8+ migration
 */
import type { GlobalSessionInfo } from "../../shared/sessionDto"
import { Effect } from "effect"
import { GLOBAL_STATE_FILE, readJsonFile, encodePath } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  updateGlobalState,
  touchGlobalSession,
  updateGlobalSessionStatus,
  getSessionPreview,
  attachEngines,
  normalizeStatuses,
  type SessionStatus,
} from "../state/globalState"


interface GlobalState {
  sessions: GlobalSessionInfo[]
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    if (new URL(req.url).searchParams.get("readBoundary") === "1") {
      return Response.json({ readBefore: Date.now() }, { headers: { "Cache-Control": "no-store" } })
    }
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
    const encodedProjects = [...new Set(state.sessions.map((s) => encodePath(s.cwd)))];
    const titleFiles = new Map(yield* Effect.forEach(encodedProjects, (encoded) => readProjectTitles(encoded).pipe(Effect.map((data) => [encoded, data] as const))));
    const sessions = yield* Effect.all(
      state.sessions.map((session) =>
        Effect.promise(() =>
          // Search panel needs the full-text corpus; the WS snapshot omits it.
          getSessionPreview(session.cwd, session.sessionId, { includeSearchText: true, titleData: titleFiles.get(encodePath(session.cwd)) })
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
              customTitle: preview.customTitle,
              defaultTitle: preview.defaultTitle,
              titleRevision: preview.titleRevision,
              title,
              lastUserMessage: preview.lastUserMessage ?? session.lastUserMessage,
              // Disk wins over the value persisted at insert time — same rule as
              // the WS snapshot (getGlobalSessionsSnapshot).
              bot: preview.bot ?? session.bot,
              firstMessages: preview.firstMessages,
              lastMessages: preview.lastMessages,
              // Untruncated body corpus; clients match the effective title separately: cwd +
              // summary + every user message (preview.searchText). Display fields
              // above stay truncated; matching reads this instead.
              searchText: `${session.cwd}\n${preview.searchText}`,
            }
          })
        )
      ),
      { concurrency: 4 }
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
      action?: "activity" | "status" | "touch"
      readBefore?: number
      engine?: string
    }
    if (!body.cwd || !body.sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "sessionId",
          reason: "missing",
        })
      )
    }
    const { cwd, sessionId, status, title, action = "activity" } = body
    if ((body.readBefore !== undefined && (typeof body.readBefore !== "number" || !Number.isFinite(body.readBefore)))
      || (body.engine !== undefined && typeof body.engine !== "string")) {
      return yield* Effect.fail(new ValidationError({ field: "readBefore|engine", reason: "invalid read boundary" }))
    }
    yield* Effect.tryPromise({
      try: () => {
        if (action === "touch") return touchGlobalSession(cwd, sessionId)
        if (action === "status") {
          return updateGlobalSessionStatus(cwd, sessionId, status || "normal",
            body.readBefore === undefined ? undefined : { readBefore: body.readBefore, engine: body.engine })
        }
        return updateGlobalState(cwd, sessionId, status || "normal", title)
      },
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
