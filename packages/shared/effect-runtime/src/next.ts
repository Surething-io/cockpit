/**
 * Next.js boundary adapter — handler / ok / errorToResponse.
 *
 * All 108 API routes are wrapped with `handler(fn)`, which automatically:
 * - runs the Effect (against AppRuntime),
 * - maps declared errors to HTTP responses,
 * - turns undeclared defects into a 500 with a log entry.
 */
import { Cause, Effect, Exit, Option } from "effect"
// next.ts is server-only (Next.js Route handler); pull AppRuntime from
// ./server/runtime.
import { AppRuntime, type AppContext } from "./server/runtime"
import {
  errorToStatus,
  ValidationError,
  type CockpitError,
  type AppError,
  type DBError,
  type FSError,
  type WSError,
  type AgentError,
  type NotFoundError,
  type PermissionError,
} from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// Response constructors
// ─────────────────────────────────────────────────────────

export const ok = <A>(body: A, status: number = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

export const noContent = (): Response => new Response(null, { status: 204 })

// ─────────────────────────────────────────────────────────
// Error mapping — shared by every route to keep responses uniform.
// ─────────────────────────────────────────────────────────

/**
 * Extract a human-readable string from a CockpitError for the wire `error`
 * field.
 *
 * Why `data.error` must be a string (not the raw tagged-error object):
 *
 *   The original (pre-Effect-migration) routes returned
 *     `Response.json({ error: msg }, { status })`
 *   where `msg` was the underlying `Error.message`, i.e. a plain string.
 *   Every client (`pluginApiPost`, `gitClient.httpGet`, `filesClient`,
 *   `useFileTree`, `skillsClient`, …) was written against that contract:
 *
 *     throw new Error(data.error || `HTTP ${res.status}`)
 *
 *   The migration to `handler()` swapped the body to `{ error: e }` where
 *   `e` is the entire CockpitError object. `new Error(<object>)` runs
 *   `ToString(message)` in the constructor → `'[object Object]'`, which
 *   is what users see on PG bubble connect failures, SQL execution
 *   failures, and anywhere else the route falls into the failure branch.
 *
 *   Fixing the wire format restores the old "string in, string out"
 *   contract — no client needs to change to render error messages
 *   correctly — while the new `tag` field (kept structured) gives
 *   forward-evolving callers a typed handle for categorisation.
 *
 * Extraction priority (per tag):
 *   1. AppError carries its own `message`; use it.
 *   2. IO errors (DB/FS/WS/Agent) wrap an underlying Error in `cause`;
 *      use `cause.message` so the user sees the real PostgreSQL /
 *      filesystem / network failure description.
 *   3. Business errors (Validation/NotFound/Permission) synthesise from
 *      their structured fields.
 *   4. Final fallback is the tag itself — never returns the empty string.
 */
const extractErrorMessage = (e: CockpitError): string => {
  // (1) AppError-style: a message field already carries the description.
  const maybeMsg = (e as Partial<AppError>).message
  if (typeof maybeMsg === "string" && maybeMsg.length > 0) {
    return maybeMsg
  }

  // (2) IO errors: the underlying exception lives in `cause` (typed
  // `unknown` in errors.ts, in practice an Error subclass returned by
  // the relevant client library — pg's DatabaseError, node fs's
  // SystemError, ws's CloseEvent, …).
  const cause = (e as Partial<DBError | FSError | WSError | AgentError>).cause
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message
  }

  // (3) Structured business errors — synthesise something readable from
  // the typed fields so the UI doesn't have to grow per-tag branches.
  switch (e._tag) {
    case "ValidationError": {
      const v = e as ValidationError
      return `Invalid ${v.field}: ${v.reason}`
    }
    case "NotFoundError": {
      const n = e as NotFoundError
      return `${n.resource} not found: ${n.id}`
    }
    case "PermissionError": {
      const p = e as PermissionError
      return `Permission denied: ${p.action} on ${p.resource}`
    }
    case "DBError": {
      const d = e as DBError
      return `${d.db} ${d.op} failed`
    }
    case "FSError": {
      const f = e as FSError
      return `${f.op} ${f.path} failed`
    }
    case "WSError": {
      const w = e as WSError
      return `${w.proto} ${w.kind} failed`
    }
    case "AgentError": {
      const a = e as AgentError
      return `${a.provider} ${a.kind} failed`
    }
    default:
      return e._tag
  }
}

const errorToResponse = (cause: Cause.Cause<unknown>): Response => {
  const failure = Cause.failureOption(cause)

  if (Option.isSome(failure)) {
    // Declared business / IO error — wire format is
    //   { error: <human-readable string>, tag: <CockpitError _tag> }
    // String `error` is the contract every legacy client was written
    // against (see `extractErrorMessage` doc). The structured `tag`
    // sits alongside as an opt-in handle for callers that want to
    // categorise (e.g. show a different toast for ValidationError vs
    // DBError).
    const e = failure.value as CockpitError
    const status = errorToStatus(e)
    return new Response(
      JSON.stringify({ error: extractErrorMessage(e), tag: e._tag }),
      {
        status,
        headers: { "content-type": "application/json" },
      }
    )
  }

  // Defect (undeclared throw / programmer error) — 500 with a log entry.
  console.error("[handler] uncaught defect:\n" + Cause.pretty(cause))
  return new Response(
    JSON.stringify({ error: "Internal Server Error", tag: "InternalError" }),
    {
      status: 500,
      headers: { "content-type": "application/json" },
    }
  )
}

// ─────────────────────────────────────────────────────────
// handler — the only wrapper a Next.js Route is allowed to export.
// ─────────────────────────────────────────────────────────

/**
 * Usage:
 *
 *   export const GET = handler(() =>
 *     Effect.gen(function* () {
 *       const service = yield* ProjectService
 *       const data = yield* service.list
 *       return ok(data)
 *     })
 *   )
 *
 *   export const POST = handler((req) =>
 *     Effect.gen(function* () {
 *       const body = yield* parseJson(req, ProjectSchema)
 *       ...
 *     })
 *   )
 */
export const handler = <E>(
  fn: (req: Request) => Effect.Effect<Response, E, AppContext>
) =>
  async (req: Request): Promise<Response> => {
    const exit = await AppRuntime.runPromiseExit(fn(req))
    return Exit.match(exit, {
      onFailure: (cause) => errorToResponse(cause as Cause.Cause<unknown>),
      onSuccess: (res) => res,
    })
  }

/**
 * Next.js dynamic params handler.
 *
 * Usage:
 *   export const GET = dynamicHandler<{ id: string }>((req, { id }) =>
 *     Effect.gen(function* () {
 *       const data = yield* MyService.getById(id)
 *       return ok(data)
 *     })
 *   )
 */
export const dynamicHandler = <P, E>(
  fn: (req: Request, params: P) => Effect.Effect<Response, E, AppContext>
) =>
  async (
    req: Request,
    ctx: { params: Promise<P> }
  ): Promise<Response> => {
    const params = await ctx.params
    const exit = await AppRuntime.runPromiseExit(fn(req, params))
    return Exit.match(exit, {
      onFailure: (cause) => errorToResponse(cause as Cause.Cause<unknown>),
      onSuccess: (res) => res,
    })
  }

// ─────────────────────────────────────────────────────────
// JSON parsing — will be replaced by @effect/schema integration later.
// ─────────────────────────────────────────────────────────

export const parseJsonRaw = (
  req: Request
): Effect.Effect<unknown, ValidationError> =>
  Effect.tryPromise({
    try: () => req.json(),
    catch: () =>
      new ValidationError({
        field: "body",
        reason: "invalid JSON",
      }),
  })
