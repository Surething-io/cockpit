/**
 * /api/terminal/bubble-order — per-tab bubble persistence.
 *
 * SCHEMA EVOLUTION (v1.0.217+):
 *   Original on-disk shape: `string[]` (just bubble ids, ordered).
 *   New shape:              `{ order: string[]; titles: Record<string, string> }`
 *
 * Reads transparently upgrade the legacy shape to the new shape (in-memory),
 * so existing JSON files keep working without a migration script. Writes are
 * partial-patch friendly:
 *   - POST body `{ order }` → updates order only, preserves titles
 *   - POST body `{ titles }` → merges into existing titles (key delete via
 *     setting the value to empty string)
 *   - POST body `{ order, titles }` → updates both
 */
import { Effect } from "effect"
import {
  getBubbleOrderPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface BubbleOrderFile {
  order: string[]
  titles: Record<string, string>
}

/** Normalise on-disk shape to {order, titles}; legacy `string[]` → wrapped. */
export function normaliseBubbleOrderFile(raw: unknown): BubbleOrderFile {
  return normalise(raw)
}

/**
 * Read the title map for a per-tab bubble-titles store. Used by
 * /api/connection/list to join titles into the unified bubble listing.
 * Returns an empty record on read error / missing file.
 */
export async function readBubbleTitles(
  cwd: string,
  tabId: string,
): Promise<Record<string, string>> {
  try {
    const raw = await readJsonFile<unknown>(getBubbleOrderPath(cwd, tabId), [])
    return normalise(raw).titles
  } catch {
    return {}
  }
}

function normalise(raw: unknown): BubbleOrderFile {
  if (Array.isArray(raw)) return { order: raw as string[], titles: {} }
  if (raw && typeof raw === "object") {
    const r = raw as Partial<BubbleOrderFile>
    return {
      order: Array.isArray(r.order) ? r.order : [],
      titles: r.titles && typeof r.titles === "object" ? r.titles : {},
    }
  }
  return { order: [], titles: {} }
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd")
    const tabId = sp.get("tabId")
    if (!cwd || !tabId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? "cwd" : "tabId",
          reason: "missing",
        })
      )
    }
    const orderPath = getBubbleOrderPath(cwd, tabId)
    const raw = yield* Effect.tryPromise({
      try: () => readJsonFile<unknown>(orderPath, []),
      catch: (cause) =>
        new FSError({ path: orderPath, op: "read", cause }),
    })
    const file = normalise(raw)
    // Back-compat for older clients that only know about `order`.
    return ok({ order: file.order, titles: file.titles })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      tabId?: string
      order?: string[]
      /** Partial patch: existing entries kept; entries set to "" are deleted. */
      titles?: Record<string, string>
    }
    if (!body.cwd || !body.tabId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "tabId",
          reason: "missing",
        })
      )
    }
    const hasOrder = Array.isArray(body.order)
    const hasTitles = body.titles && typeof body.titles === "object"
    if (!hasOrder && !hasTitles) {
      return yield* Effect.fail(
        new ValidationError({ field: "order|titles", reason: "missing — provide at least one" })
      )
    }

    const orderPath = getBubbleOrderPath(body.cwd, body.tabId)

    // Read-merge-write so partial patches don't clobber the sibling field.
    const existing = normalise(
      yield* Effect.tryPromise({
        try: () => readJsonFile<unknown>(orderPath, []),
        catch: (cause) => new FSError({ path: orderPath, op: "read", cause }),
      })
    )

    const next: BubbleOrderFile = {
      order: hasOrder ? (body.order as string[]) : existing.order,
      titles: hasTitles
        ? mergeTitles(existing.titles, body.titles as Record<string, string>)
        : existing.titles,
    }

    yield* Effect.tryPromise({
      try: () => writeJsonFile(orderPath, next),
      catch: (cause) =>
        new FSError({ path: orderPath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)

function mergeTitles(
  base: Record<string, string>,
  patch: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v !== "string") continue
    if (v === "") delete out[k]
    else out[k] = v.slice(0, 256) // sane cap
  }
  return out
}
