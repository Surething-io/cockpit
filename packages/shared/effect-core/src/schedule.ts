/**
 * Schedule Policies — Cockpit's unified scheduling / retry policies
 *
 * Replaces the various ad-hoc patterns scattered across the codebase:
 *   - setTimeout(retry, delay)
 *   - Hand-written exponential backoff such as
 *     Math.min(1000 * Math.pow(1.5, n), 10000)
 *   - setInterval(fn, interval) heartbeats
 *   - Custom cron implementations
 *
 * Business code:
 *   yield* eff.pipe(Effect.retry(SchedulePolicies.reconnect))
 *   yield* eff.pipe(Effect.repeat(SchedulePolicies.heartbeat))
 */
import { Duration, Schedule } from "effect"

// ─────────────────────────────────────────────────────────
// Reconnect / retry policies (capped exponential backoff)
// ─────────────────────────────────────────────────────────

/**
 * WebSocket reconnect: starts at 1s, grows 1.5x, capped at 10s, up to 10 attempts.
 * Equivalent to useWebSocket.ts's current `Math.min(1000 * Math.pow(1.5, n), 10000)`.
 */
export const wsReconnect = Schedule.exponential(
  Duration.seconds(1),
  1.5
).pipe(
  Schedule.either(Schedule.spaced(Duration.seconds(10))), // cap at 10s
  Schedule.intersect(Schedule.recurs(10)) // up to 10 attempts
)

/**
 * DB retry: starts at 200ms, grows 2x, capped at 5s, up to 5 attempts.
 * Suitable for transient connection errors (not for SQL syntax errors).
 */
export const dbRetry = Schedule.exponential(
  Duration.millis(200),
  2.0
).pipe(
  Schedule.either(Schedule.spaced(Duration.seconds(5))),
  Schedule.intersect(Schedule.recurs(5))
)

/**
 * Agent API retry: jittered, suitable for LLM provider rate-limit / transient errors.
 */
export const agentRetry = Schedule.exponential(
  Duration.seconds(1),
  2.0
).pipe(
  Schedule.jittered, // jitter to avoid thundering herd
  Schedule.either(Schedule.spaced(Duration.seconds(30))),
  Schedule.intersect(Schedule.recurs(8))
)

// ─────────────────────────────────────────────────────────
// Heartbeat / periodic policies
// ─────────────────────────────────────────────────────────

/** WS heartbeat every 30s */
export const wsHeartbeat = Schedule.spaced(Duration.seconds(30))

/** Short poll every 1s */
export const shortPoll = Schedule.spaced(Duration.seconds(1))

/** Long poll every 30s */
export const longPoll = Schedule.spaced(Duration.seconds(30))

// ─────────────────────────────────────────────────────────
// Debounce / throttle helpers
// ─────────────────────────────────────────────────────────

/**
 * File-change debounce window (matches the 50/100ms used by v1 fileWatcher).
 */
export const fileChangeDebounce = Duration.millis(50)

/**
 * Cron expression → Schedule.
 *
 * Note: Effect 3.21 ships `Schedule.cron(expression)`, but it requires a
 * timezone-aware caller. This is just a thin re-export; business code can
 * use `Schedule.cron()` directly.
 */
export const cron = Schedule.cron

// Business code usage:
//   effect.pipe(Effect.retry(wsReconnect))
//   effect.pipe(Effect.repeat(wsHeartbeat))

// ─────────────────────────────────────────────────────────
// Pure-function variants (for React hooks and other non-Effect contexts)
//
// Same semantics as the Schedules above, but as scalar computations that can
// be called directly from a React useEffect. Can be removed once React hooks
// are migrated to Effect in a later phase.
// ─────────────────────────────────────────────────────────

/**
 * WebSocket reconnect delay in milliseconds: exponential 1.5x, capped at 10s.
 * Equivalent to the step-by-step output of the `wsReconnect` Schedule.
 */
export const wsReconnectDelayMs = (attempt: number): number =>
  Math.min(1000 * Math.pow(1.5, attempt), 10000)

/** DB retry delay in milliseconds: exponential 2x, capped at 5s. */
export const dbRetryDelayMs = (attempt: number): number =>
  Math.min(200 * Math.pow(2, attempt), 5000)
