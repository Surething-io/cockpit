/**
 * Logger Layer — Cockpit logging strategy
 *
 * No custom Service Tag is introduced; Effect's built-in Logger system is used
 * directly. Business code uses:
 *   yield* Effect.logInfo("...", { meta })
 *   yield* Effect.logError("...", cause)
 *   yield* Effect.logDebug("...")
 *   yield* Effect.logWarning("...")
 *
 * Two Layers are provided:
 *   - LoggerLivePretty: development mode, pretty output to stdout
 *   - LoggerLiveProd:   production mode, JSON output plus append to
 *                       ~/.cockpit/logs/cockpit.log
 */
import {
  Effect,
  Layer,
  Logger,
  LogLevel,
  Cause,
  type LogLevel as TLogLevel,
} from "effect"

// ─────────────────────────────────────────────────────────
// Level parsing — supports the COCKPIT_LOG_LEVEL env var
// ─────────────────────────────────────────────────────────

const parseLevel = (raw: string | undefined): TLogLevel.LogLevel => {
  switch ((raw ?? "").toLowerCase()) {
    case "all":
      return LogLevel.All
    case "trace":
      return LogLevel.Trace
    case "debug":
      return LogLevel.Debug
    case "info":
      return LogLevel.Info
    case "warning":
    case "warn":
      return LogLevel.Warning
    case "error":
      return LogLevel.Error
    case "fatal":
      return LogLevel.Fatal
    case "none":
      return LogLevel.None
    default:
      return LogLevel.Info
  }
}

// ─────────────────────────────────────────────────────────
// LoggerLivePretty — development mode (shared by Browser + Server)
// ─────────────────────────────────────────────────────────

export const LoggerLivePretty = Layer.mergeAll(
  Logger.pretty,
  Logger.minimumLogLevel(parseLevel(process.env.COCKPIT_LOG_LEVEL))
)

// ─────────────────────────────────────────────────────────
// LoggerLiveProd — production mode (Server only, with file sink)
// ─────────────────────────────────────────────────────────

/**
 * Asynchronously append a JSON line to cockpit.log.
 * Note: @cockpit/shared-utils is intentionally not used (would risk a
 * circular import); fs/promises is used directly.
 */
const appendLogFile = async (line: string, filePath: string): Promise<void> => {
  const { appendFile, mkdir } = await import("fs/promises")
  const { dirname } = await import("path")
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, line + "\n", "utf-8")
  } catch {
    // Silent — otherwise logging would log itself in a loop
  }
}

/**
 * Build a file-sink Logger for the given cockpit log path.
 */
const normalizeMessage = (m: unknown): unknown => {
  if (Array.isArray(m)) {
    return m.length === 1 ? m[0] : m
  }
  return m
}

const fileLogger = (filePath: string) =>
  Logger.make<unknown, void>(({ logLevel, message, date, fiberId, spans, annotations }) => {
    const payload = {
      time: date.toISOString(),
      level: logLevel.label,
      // fiberId is a FiberId object; extract its numeric id
      fiber:
        typeof fiberId === "object" && fiberId !== null && "id" in fiberId
          ? (fiberId as { id: number }).id
          : String(fiberId),
      msg: normalizeMessage(message),
      spans: Array.from(spans).map((s) => ({
        label: s.label,
        startTime: s.startTime,
      })),
      annotations: Object.fromEntries(annotations),
    }
    // Not awaited — file IO must not block the effect main loop
    void appendLogFile(JSON.stringify(payload), filePath)
  })

/**
 * Server production Layer: pretty stdout + file sink.
 * Usage: Layer.merge(LoggerLiveProd("/path/to/cockpit.log"), ...)
 */
export const LoggerLiveProd = (logFile: string): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.pretty, // still write to stdout for ops readability
    Logger.add(fileLogger(logFile)), // also append to the file
    Logger.minimumLogLevel(parseLevel(process.env.COCKPIT_LOG_LEVEL))
  )

// ─────────────────────────────────────────────────────────
// Utility: render an unknown cause in an Effect.logError-friendly format
// ─────────────────────────────────────────────────────────

export const logCause = (
  msg: string,
  cause: unknown
): Effect.Effect<void> =>
  Effect.logError(msg).pipe(
    Effect.annotateLogs(
      "cause",
      cause instanceof Error
        ? { name: cause.name, message: cause.message, stack: cause.stack }
        : Cause.isCause(cause)
          ? Cause.pretty(cause)
          : String(cause)
    )
  )
