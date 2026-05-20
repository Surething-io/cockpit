/**
 * Tagged Error hierarchy — root of all IO / business errors in Cockpit
 *
 * Design principles:
 * - Every IO boundary failure must land on some Tagged Error
 * - `cause: unknown` preserves the underlying exception; never swallow errors
 * - IO-class errors (DB/WS/FS/Agent) automatically flow into retry / timeout
 * - Business-class errors (Validation/NotFound/Permission) map directly to HTTP status codes
 */
import { Data } from "effect"

// ─────────────────────────────────────────────────────────
// Root type
// ─────────────────────────────────────────────────────────

export class AppError extends Data.TaggedError("AppError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

// ─────────────────────────────────────────────────────────
// IO category (retryable)
// ─────────────────────────────────────────────────────────

export type DBKind = "pg" | "mysql" | "redis" | "neo4j" | "mongo"

export class DBError extends Data.TaggedError("DBError")<{
  readonly db: DBKind
  readonly op: string
  readonly cause: unknown
}> {}

export type WSProto =
  | "terminal"
  | "browser"
  | "watch"
  | "global-state"
  | "jupyter"
  | "terminal-follow"

export type WSErrorKind = "send" | "recv" | "upgrade" | "closed"

export class WSError extends Data.TaggedError("WSError")<{
  readonly proto: WSProto
  readonly kind: WSErrorKind
  readonly cause?: unknown
}> {}

export type FSOp = "read" | "write" | "watch" | "stat" | "mkdir" | "rm"

export class FSError extends Data.TaggedError("FSError")<{
  readonly path: string
  readonly op: FSOp
  readonly cause: unknown
}> {}

export type AgentProvider = "claude" | "codex" | "ollama" | "kimi" | "deepseek"

export type AgentErrorKind =
  | "auth"
  | "rate-limit"
  | "timeout"
  | "protocol"
  | "unknown"

export class AgentError extends Data.TaggedError("AgentError")<{
  readonly provider: AgentProvider
  readonly kind: AgentErrorKind
  readonly cause?: unknown
}> {}

// ─────────────────────────────────────────────────────────
// Business category (not retried; needs user response)
// ─────────────────────────────────────────────────────────

export class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string
  readonly reason: string
}> {}

export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string
  readonly id: string
}> {}

export class PermissionError extends Data.TaggedError("PermissionError")<{
  readonly action: string
  readonly resource: string
}> {}

// ─────────────────────────────────────────────────────────
// Union — used by handler error-response mapping
// ─────────────────────────────────────────────────────────

export type CockpitError =
  | AppError
  | DBError
  | WSError
  | FSError
  | AgentError
  | ValidationError
  | NotFoundError
  | PermissionError

/** HTTP status code mapping (used by handlers). */
export const errorToStatus = (e: CockpitError): number => {
  switch (e._tag) {
    case "ValidationError":
      return 400
    case "PermissionError":
      return 403
    case "NotFoundError":
      return 404
    case "DBError":
    case "FSError":
    case "AgentError":
    case "WSError":
      return 503
    case "AppError":
    default:
      return 500
  }
}
