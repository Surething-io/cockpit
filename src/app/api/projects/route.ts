/**
 * /api/projects — list and persist the user's project workspace.
 *
 * Implementation contract (see EFFECT.md §3):
 * - No bare try/catch — failures flow as Tagged Errors (FSError).
 * - No bare fs IO — file access goes through the ProjectService Tag.
 * - `handler` maps FSError → 503 and ValidationError → 400 automatically.
 * - Signature is the contract: Effect<Response, FSError | ValidationError, ProjectService>.
 */
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import {
  ProjectService,
  ProjectServiceLive,
  type ProjectsData,
} from "@cockpit/feature-workspace/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// ─────────────────────────────────────────────────────────
// GET — read the project list
// ─────────────────────────────────────────────────────────

export const GET = handler(() =>
  Effect.gen(function* () {
    const service = yield* ProjectService
    const data = yield* service.read
    return ok(data)
  }).pipe(Effect.provide(ProjectServiceLive))
)

// ─────────────────────────────────────────────────────────
// POST — save the project list
// ─────────────────────────────────────────────────────────

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ProjectsData
    const service = yield* ProjectService
    yield* service.write(body)
    return ok({ success: true })
  }).pipe(Effect.provide(ProjectServiceLive))
)
