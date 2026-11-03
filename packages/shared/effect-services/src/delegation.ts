/**
 * DelegationService — fire-and-forget sub-task sessions, plus status of any session.
 *
 * `delegate` starts a brand-new session in any directory on any engine and returns a
 * receipt at once; nothing is stored server-side (the receipt, returned to the caller's
 * transcript, IS the record). `status` derives a session's state on read from the run
 * registry and the transcript's own terminal markers.
 *
 * Live implementation: packages/feature/agent/src/effect/delegationLive.ts
 */
import { Context, Effect } from "effect"
import type { AgentError, AppError, NotFoundError, ValidationError } from "@cockpit/effect-core"

export type DelegationEngine = "claude" | "codex" | "deepseek" | "kimi" | "glm" | "ollama" | "grok"

export interface DelegateRequest {
  readonly cwd: string
  readonly engine: DelegationEngine
  readonly model?: string
  readonly title: string
  readonly prompt?: string
  readonly briefPath?: string
}

export interface DelegationParent {
  readonly cwd: string
  readonly sessionId: string
  readonly link: string
}

export interface DelegationReceipt {
  readonly cwd: string
  readonly engine: DelegationEngine
  readonly model?: string
  readonly sessionId: string
  readonly link: string
  readonly title: string
  readonly createdAt: number
  readonly parent?: DelegationParent
}

/**
 * running    — a live run
 * done       — the last turn reached its engine's normal end marker
 * failed     — the last turn ended on an error the engine recorded
 * incomplete — anything else: stopped, interrupted, mid-tool, or never finished
 */
export type SessionRunStatus = "running" | "done" | "failed" | "incomplete"

export interface SessionStatusReport {
  readonly cwd: string
  readonly sessionId: string
  readonly engine: string | null
  readonly title: string
  readonly status: SessionRunStatus
  readonly lastReply: string | null
  /** True when lastReply was cut; ask again with `full` for all of it. */
  readonly lastReplyTruncated: boolean
  readonly link: string
}

export interface DelegationService {
  /** Validate a raw request body (checks cwd / briefPath on disk).
   *  `parentRunId` is the caller's own run (the `x-cockpit-run-id` header): it
   *  settles `engine` when the body leaves it out, so a delegation runs on the
   *  same engine as the session that asked for it. */
  readonly validate: (
    body: Readonly<Record<string, unknown>>,
    parentRunId?: string | null
  ) => Effect.Effect<DelegateRequest, ValidationError>
  /** Start the session and return its receipt without waiting for the task. */
  readonly delegate: (
    request: DelegateRequest,
    parentRunId: string | null
  ) => Effect.Effect<DelegationReceipt, ValidationError | AgentError>
  readonly status: (
    cwd: string,
    sessionId: string,
    options?: { readonly full?: boolean }
  ) => Effect.Effect<SessionStatusReport, NotFoundError | AppError>
}

export const DelegationService = Context.GenericTag<DelegationService>(
  "@cockpit/DelegationService"
)
