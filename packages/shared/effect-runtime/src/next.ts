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
import { errorToStatus, type CockpitError } from "@cockpit/effect-core"

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

const errorToResponse = (cause: Cause.Cause<unknown>): Response => {
  const failure = Cause.failureOption(cause)

  if (Option.isSome(failure)) {
    // Declared business / IO error.
    const e = failure.value as CockpitError
    const status = errorToStatus(e)
    return new Response(JSON.stringify({ error: e }), {
      status,
      headers: { "content-type": "application/json" },
    })
  }

  // Defect (undeclared throw / programmer error) — 500 with a log entry.
  console.error("[handler] uncaught defect:\n" + Cause.pretty(cause))
  return new Response(
    JSON.stringify({ error: { _tag: "InternalError", message: "see server logs" } }),
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

import { ValidationError } from "@cockpit/effect-core"

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
