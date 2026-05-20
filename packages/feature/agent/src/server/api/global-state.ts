/**
 * /api/global-state — P8+ migration
 */
import { Effect } from "effect"
import { GLOBAL_STATE_FILE, readJsonFile } from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  updateGlobalState,
  getLastUserMessage,
  type SessionStatus,
} from "../state/globalState"

interface GlobalSession {
  cwd: string
  sessionId: string
  lastActive: number
  status: SessionStatus
  title?: string
  lastUserMessage?: string
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
    for (const s of state.sessions) {
      if (!s.status) {
        const legacy = s as GlobalSession & { isLoading?: boolean }
        s.status = legacy.isLoading ? "loading" : "normal"
      }
    }
    state.sessions.sort((a, b) => b.lastActive - a.lastActive)
    const recent = state.sessions.slice(0, 15)
    const sessions = yield* Effect.promise(() =>
      Promise.all(
        recent.map(async (session) => {
          const lastUserMessage = await getLastUserMessage(
            session.cwd,
            session.sessionId
          )
          return {
            ...session,
            lastUserMessage: lastUserMessage ?? session.lastUserMessage,
          }
        })
      )
    )
    return ok({ sessions })
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
