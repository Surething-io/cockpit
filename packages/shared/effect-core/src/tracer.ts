/**
 * Tracer Layer — Cockpit tracing strategy
 *
 * Evolution: the earlier `Layer.empty` placeholder is now backed by a real
 * in-memory ring buffer.
 *
 * Design principles:
 *   1. @opentelemetry is intentionally not used — Cockpit is a local-first
 *      tool and the OTel stack (sdk-base + exporter-otlp-http + resource +
 *      semantic-conventions) would pull in five-plus packages, far beyond
 *      what local debugging needs.
 *   2. Reuse Effect's built-in Tracer abstraction — business code keeps using
 *      `Effect.withSpan(...)` unchanged.
 *   3. The custom Tracer invokes the `spanRecorder` module on every Span
 *      lifecycle event, persisting span data into a global ring buffer
 *      (MAX_SPANS=500, FIFO).
 *   4. The read path is exposed via the `getRecordedSpans(filter)` Effect API
 *      for the `/api/dev/spans` route and dev panel.
 *
 * Layer variants:
 *   - `TracerLivePretty`: development mode — enables recording for full
 *     business-side observability.
 *   - `TracerLiveNoop`: production mode — Layer.empty, inheriting the default
 *     NativeTracer with no ring overhead.
 *
 * Note: LoggerLivePretty already enables `Logger.withSpanAnnotations` by
 *       default, automatically attaching the current fiber's span chain to
 *       every log line. The two paths are complementary: Logger covers
 *       "live output + correlated logs", the ring covers "historical spans +
 *       performance analysis".
 */
import { Layer, Option, Tracer } from "effect"
import {
  makeStartedRecord,
  getParentSpanId,
  recordSpanStart,
  recordSpanEnd,
  recordSpanAttribute,
  recordSpanEvent,
} from "./spanRecorder"

// ─────────────────────────────────────────────────────────
// RecordingSpan — semantically equivalent to Effect's built-in NativeSpan,
// but synchronously writes into the ring buffer at every lifecycle point.
// ─────────────────────────────────────────────────────────

const randomHexString = (length: number): string => {
  const chars = "abcdef0123456789"
  let s = ""
  for (let i = 0; i < length; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return s
}

class RecordingSpan implements Tracer.Span {
  readonly _tag = "Span" as const
  readonly spanId: string
  readonly traceId: string
  readonly sampled = true
  status: Tracer.SpanStatus
  readonly attributes: Map<string, unknown> = new Map()
  readonly events: Array<[string, bigint, Record<string, unknown>]> = []
  readonly links: Tracer.SpanLink[]

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly context: import("effect").Context.Context<never>,
    links: ReadonlyArray<Tracer.SpanLink>,
    readonly startTime: bigint,
    readonly kind: Tracer.SpanKind
  ) {
    this.traceId = Option.isSome(parent)
      ? parent.value.traceId
      : randomHexString(32)
    this.spanId = randomHexString(16)
    this.status = { _tag: "Started", startTime }
    this.links = Array.from(links)

    // Record into the ring buffer
    recordSpanStart(
      makeStartedRecord(
        this.spanId,
        this.traceId,
        getParentSpanId(parent),
        name,
        kind,
        startTime
      )
    )
  }

  end(
    endTime: bigint,
    exit: import("effect").Exit.Exit<unknown, unknown>
  ): void {
    this.status = {
      _tag: "Ended",
      endTime,
      exit,
      startTime: this.status.startTime,
    }
    recordSpanEnd(
      this.spanId,
      endTime,
      exit._tag === "Success"
        ? { _tag: "Success" }
        : { _tag: "Failure", cause: exit.cause }
    )
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
    recordSpanAttribute(this.spanId, key, value)
  }

  event(
    name: string,
    startTime: bigint,
    attributes?: Record<string, unknown>
  ): void {
    this.events.push([name, startTime, attributes ?? {}])
    recordSpanEvent(this.spanId, name, startTime, attributes)
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links)
  }
}

// ─────────────────────────────────────────────────────────
// Custom Tracer instance
// ─────────────────────────────────────────────────────────

const recordingTracer: Tracer.Tracer = Tracer.make({
  span: (name, parent, context, links, startTime, kind) =>
    new RecordingSpan(name, parent, context, links, startTime, kind),
  context: (f) => f(),
})

// ─────────────────────────────────────────────────────────
// Public Layers
// ─────────────────────────────────────────────────────────

/**
 * Development mode: enables in-memory span recording.
 * Every business call to `Effect.withSpan(...)` is persisted into the ring
 * buffer and can be read via the `getRecordedSpans()` Effect API (exported
 * from the spanRecorder module).
 */
export const TracerLivePretty: Layer.Layer<never> = Layer.succeed(
  Tracer.Tracer,
  recordingTracer
)

/**
 * Production mode: ring buffer disabled; inherits Effect's default NativeTracer.
 * Logger.withSpanAnnotations still works (span context is injected into logs),
 * but the full span tree is not programmatically retrievable.
 */
export const TracerLiveNoop: Layer.Layer<never> = Layer.empty

// Re-export the spanRecorder read API — exposed from a single effect-core
// entry point so the /api/dev/spans route and the dev panel import it once.
export * from "./spanRecorder"
