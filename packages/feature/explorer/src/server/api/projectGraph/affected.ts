import { indexResponse, withIndexHeaders } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/affected — file-level test impact closure.
 *
 * Given a SET of changed source files (e.g. from `git diff --name-only`),
 * trace the importedBy graph and return the test files transitively
 * affected. Sister to /risk (which is symbol-centric + precision-oriented).
 *
 * Two transport forms:
 *
 *   - GET: query params `files=a.ts,b.ts&depth=10&filter=...&includeAll=...&format=...`
 *          Use for ad-hoc / small input sets. URL length limits apply.
 *
 *   - POST: JSON body `{ cwd, files: [...], depth, filter, includeAll, format }`
 *          Use for pipeline / large input sets (CI, `git diff | ...`).
 *
 * Two output forms (both transports):
 *
 *   - JSON (default): full AffectedResponse with stats / byInput breakdown.
 *   - plain (`format=plain`): newline-separated test paths, Content-Type
 *          text/plain, ready for `xargs jest` pipelines. Diagnostics
 *          surface via response headers (X-Unresolved-Count etc.).
 */
import { Effect } from "effect"
import { getCodeIndex } from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { findAffected } from "@cockpit/feature-explorer/server/codeMap/analytics/index"
import type { AffectedResponse } from "@cockpit/feature-explorer/server/codeMap/analytics/index"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface ParsedInput {
  cwd: string
  files: string[]
  depth: number
  filter: string | undefined
  includeAll: boolean
  format: 'json' | 'plain'
}

function clampDepth(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? '10'), 10) || 10
  return Math.min(Math.max(n, 1), 20)
}

function parseFormat(v: unknown): 'json' | 'plain' {
  return v === 'plain' ? 'plain' : 'json'
}

function parseFilesParam(raw: string | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Build the plain-text response: newline-separated test paths + headers. */
function renderPlain(result: AffectedResponse): Response {
  const body = result.testFiles.join('\n') + (result.testFiles.length ? '\n' : '')
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Unresolved-Count': String(result.unresolved.length),
      'X-Visited': String(result.stats.visited),
      'X-Truncated': String(result.stats.truncated),
      'X-Degraded': String(result.degraded),
      ...(result.degradedReason
        ? { 'X-Degraded-Reason': result.degradedReason }
        : {}),
    },
  })
}

async function runQuery(input: ParsedInput): Promise<Response> {
  const index = await getCodeIndex(input.cwd)
  const result = findAffected(index, {
    files: input.files,
    depth: input.depth,
    filter: input.filter,
    includeAll: input.includeAll,
  })
  if (input.format === 'plain') return withIndexHeaders(index, renderPlain(result))
  return indexResponse(index, result)
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const files = parseFilesParam(sp.get("files"))
    const depth = clampDepth(sp.get("depth"))
    const filter = sp.get("filter") || undefined
    const includeAll = sp.get("includeAll") === 'true'
    const format = parseFormat(sp.get("format"))

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason }),
      )
    }
    if (files.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ field: "files", reason: "missing-or-empty" }),
      )
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        runQuery({
          cwd: cwdCheck.abs,
          files,
          depth,
          filter,
          includeAll,
          format,
        }),
      catch: (cause) =>
        indexQueryError(cause, "Affected lookup failed"),
    })
    return result
  }),
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = yield* Effect.tryPromise({
      try: () => req.json() as Promise<Record<string, unknown>>,
      catch: () =>
        new ValidationError({ field: "body", reason: "invalid-json" }),
    })

    const cwdParam = typeof body.cwd === 'string' ? body.cwd : null
    const filesRaw = Array.isArray(body.files) ? body.files : []
    const files: string[] = filesRaw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter(Boolean)
    const depth = clampDepth(body.depth)
    const filter = typeof body.filter === 'string' ? body.filter : undefined
    const includeAll = body.includeAll === true
    const format = parseFormat(body.format)

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason }),
      )
    }
    if (files.length === 0) {
      return yield* Effect.fail(
        new ValidationError({ field: "files", reason: "missing-or-empty" }),
      )
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        runQuery({
          cwd: cwdCheck.abs,
          files,
          depth,
          filter,
          includeAll,
          format,
        }),
      catch: (cause) =>
        indexQueryError(cause, "Affected lookup failed"),
    })
    return result
  }),
)
