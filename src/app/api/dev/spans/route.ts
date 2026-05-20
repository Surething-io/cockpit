/**
 * /api/dev/spans — Effect Tracer ring buffer inspection (**dev only**)
 *
 * Every span emitted by business code via `Effect.withSpan(...)` is recorded
 * in a process-level in-memory ring (MAX_SPANS=500, FIFO). This endpoint
 * exposes that buffer for the dev panel and curl-based debugging.
 *
 * Query params:
 *   - limit=N         return only the most recent N entries
 *   - errorsOnly=1    return only status=error spans
 *   - traceId=...     filter by traceId
 *   - namePrefix=...  filter by span name prefix (e.g. "pg.")
 *   - minDurationMs=N only spans whose duration is >= N ms (slow-call analysis)
 *
 * DELETE /api/dev/spans — clear the ring buffer.
 *
 * Security: enabled only when `COCKPIT_ENV=dev`. Production returns 404 to
 *      avoid leaking span names (which may contain connection string IDs),
 *      ring capacity, and other metadata. Recording itself is also dev-only
 *      (`TracerLivePretty` vs `TracerLiveNoop`), so even if the endpoint
 *      were accidentally exposed in prod the data would be empty — but
 *      endpoint existence is itself information disclosure, hence the 404
 *      guard.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  getRecordedSpans,
  clearRecordedSpans,
  getSpanRingStats,
  type SpansQueryFilter,
} from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const isDev = process.env.COCKPIT_ENV === "dev"

const notFoundInProd = (): Response =>
  new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    if (!isDev) return notFoundInProd()
    const sp = new URL(req.url).searchParams
    const filter: SpansQueryFilter = {
      limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      errorsOnly: sp.get("errorsOnly") === "1",
      traceId: sp.get("traceId") ?? undefined,
      namePrefix: sp.get("namePrefix") ?? undefined,
      minDurationMs: sp.get("minDurationMs")
        ? Number(sp.get("minDurationMs"))
        : undefined,
    }
    const [spans, stats] = yield* Effect.all([
      getRecordedSpans(filter),
      getSpanRingStats(),
    ])
    return ok({ spans, stats })
  })
)

export const DELETE = handler(() =>
  Effect.gen(function* () {
    if (!isDev) return notFoundInProd()
    yield* clearRecordedSpans()
    return ok({ ok: true })
  })
)
