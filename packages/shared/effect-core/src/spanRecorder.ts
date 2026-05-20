/**
 * SpanRecorder — In-memory tracing backend
 *
 * Pure Effect-native implementation; @opentelemetry is intentionally not used.
 * Design trade-offs:
 *
 * 1. Cockpit is a local-first tool and does not run on a server facing
 *    Jaeger/Honeycomb, so a full OTel stack (@effect/opentelemetry +
 *    @opentelemetry/sdk + exporter) costs far more than it returns.
 * 2. What is actually needed: span data visibility plus programmatic
 *    retrieval (for the dev panel / debug endpoints).
 * 3. Implemented as a ring buffer + custom Tracer, capacity MAX_SPANS=500,
 *    FIFO eviction.
 *
 * Usage pattern:
 *   - Business code is unchanged — `Effect.withSpan("name", { attributes: ... })`
 *     is used as before
 *   - `getRecordedSpans()` returns the most recent N spans (with full timelines)
 *   - The `/api/dev/spans` route can serialize the output directly
 *
 * HMR safe: the ring buffer is a globalThis singleton so duplicate instances
 * or module reloads do not drop data.
 */
import { Effect, Option, type Tracer } from "effect"

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface RecordedSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | null
  readonly name: string
  readonly kind: Tracer.SpanKind
  /** Span start time — Unix epoch nanoseconds (kept as string to preserve bigint precision) */
  readonly startTimeNs: string
  /** Span end time; null while still active */
  readonly endTimeNs: string | null
  /** Duration in milliseconds; null while still active */
  readonly durationMs: number | null
  readonly attributes: Record<string, unknown>
  readonly events: ReadonlyArray<{
    name: string
    timeNs: string
    attributes?: Record<string, unknown>
  }>
  /** 'started' / 'ok' / 'error' */
  readonly status: "started" | "ok" | "error"
  /** Cause summary for failed spans */
  readonly errorMessage?: string
}

// ─────────────────────────────────────────────────────────
// Global ring buffer (HMR safe)
// ─────────────────────────────────────────────────────────

const MAX_SPANS = 500

interface SpanRing {
  buffer: RecordedSpan[]
  /** spanId → buffer index; populated while the span is active and retained
   *  after `end` until the entry is evicted */
  index: Map<string, number>
}

const g = globalThis as unknown as { __cockpitSpanRing?: SpanRing }
const ring: SpanRing = (g.__cockpitSpanRing ??= {
  buffer: [],
  index: new Map(),
})

// ─────────────────────────────────────────────────────────
// Internal recording API (called by RecordingTracer; not exported to callers)
// ─────────────────────────────────────────────────────────

export function recordSpanStart(span: RecordedSpan): void {
  ring.buffer.push(span)
  ring.index.set(span.spanId, ring.buffer.length - 1)
  // FIFO eviction once capacity is exceeded (rebuild index, O(n) but bounded at 500)
  if (ring.buffer.length > MAX_SPANS) {
    const removed = ring.buffer.shift()!
    ring.index.clear()
    for (let i = 0; i < ring.buffer.length; i++) {
      ring.index.set(ring.buffer[i].spanId, i)
    }
    // `removed` is evicted; no notification required
    void removed
  }
}

export function recordSpanEnd(
  spanId: string,
  endTimeNs: bigint,
  exit: { _tag: "Success" } | { _tag: "Failure"; cause: unknown }
): void {
  const idx = ring.index.get(spanId)
  if (idx === undefined) return
  const existing = ring.buffer[idx]
  if (!existing) return
  const startNs = BigInt(existing.startTimeNs)
  const durationMs = Number(endTimeNs - startNs) / 1_000_000
  ring.buffer[idx] = {
    ...existing,
    endTimeNs: endTimeNs.toString(),
    durationMs: Math.round(durationMs * 100) / 100,
    status: exit._tag === "Success" ? "ok" : "error",
    errorMessage:
      exit._tag === "Failure"
        ? prettyPrintCause(exit.cause)
        : undefined,
  }
}

export function recordSpanAttribute(
  spanId: string,
  key: string,
  value: unknown
): void {
  const idx = ring.index.get(spanId)
  if (idx === undefined) return
  const existing = ring.buffer[idx]
  if (!existing) return
  ring.buffer[idx] = {
    ...existing,
    attributes: { ...existing.attributes, [key]: value },
  }
}

export function recordSpanEvent(
  spanId: string,
  eventName: string,
  timeNs: bigint,
  attributes?: Record<string, unknown>
): void {
  const idx = ring.index.get(spanId)
  if (idx === undefined) return
  const existing = ring.buffer[idx]
  if (!existing) return
  ring.buffer[idx] = {
    ...existing,
    events: [
      ...existing.events,
      { name: eventName, timeNs: timeNs.toString(), attributes },
    ],
  }
}

function prettyPrintCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "string") return cause
  try {
    return JSON.stringify(cause)
  } catch {
    return String(cause)
  }
}

// ─────────────────────────────────────────────────────────
// Public read API (Effect-shaped, consumed by /api/dev/spans and dev panel)
// ─────────────────────────────────────────────────────────

export interface SpansQueryFilter {
  /** Return only the most recent N entries */
  readonly limit?: number
  /** Return only entries with status === 'error' */
  readonly errorsOnly?: boolean
  /** Filter by traceId */
  readonly traceId?: string
  /** Filter by name prefix */
  readonly namePrefix?: string
  /** Minimum durationMs (for slow-span debugging) */
  readonly minDurationMs?: number
}

/**
 * Synchronously return a snapshot of the current ring (shallow copy so callers
 * cannot mutate it).
 */
export function getRecordedSpansSync(
  filter: SpansQueryFilter = {}
): ReadonlyArray<RecordedSpan> {
  let result: ReadonlyArray<RecordedSpan> = ring.buffer
  if (filter.errorsOnly) {
    result = result.filter((s) => s.status === "error")
  }
  if (filter.traceId) {
    result = result.filter((s) => s.traceId === filter.traceId)
  }
  if (filter.namePrefix) {
    const prefix = filter.namePrefix
    result = result.filter((s) => s.name.startsWith(prefix))
  }
  if (typeof filter.minDurationMs === "number") {
    const min = filter.minDurationMs
    result = result.filter((s) => (s.durationMs ?? 0) >= min)
  }
  if (typeof filter.limit === "number" && filter.limit > 0) {
    result = result.slice(-filter.limit)
  }
  return result
}

/** Effect-shaped wrapper */
export const getRecordedSpans = (
  filter: SpansQueryFilter = {}
): Effect.Effect<ReadonlyArray<RecordedSpan>, never> =>
  Effect.sync(() => getRecordedSpansSync(filter))

/**
 * Clear the ring (one-shot reset for tests / the dev panel).
 */
export const clearRecordedSpans = (): Effect.Effect<void, never> =>
  Effect.sync(() => {
    ring.buffer.length = 0
    ring.index.clear()
  })

/**
 * Snapshot of current ring capacity / utilization.
 */
export const getSpanRingStats = (): Effect.Effect<
  { capacity: number; size: number; oldestStartNs: string | null },
  never
> =>
  Effect.sync(() => ({
    capacity: MAX_SPANS,
    size: ring.buffer.length,
    oldestStartNs: ring.buffer[0]?.startTimeNs ?? null,
  }))

// ─────────────────────────────────────────────────────────
// Helper for the Tracer factory: an "unfinished" RecordedSpan snapshot
// ─────────────────────────────────────────────────────────

export function makeStartedRecord(
  spanId: string,
  traceId: string,
  parentSpanId: string | null,
  name: string,
  kind: Tracer.SpanKind,
  startTimeNs: bigint
): RecordedSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTimeNs: startTimeNs.toString(),
    endTimeNs: null,
    durationMs: null,
    attributes: {},
    events: [],
    status: "started",
  }
}

/** Extract the parent spanId from a Tracer.AnySpan (returns null when absent) */
export function getParentSpanId(
  parent: Option.Option<Tracer.AnySpan>
): string | null {
  return Option.isSome(parent) ? parent.value.spanId : null
}
