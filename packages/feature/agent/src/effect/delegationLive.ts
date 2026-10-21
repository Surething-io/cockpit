/**
 * DelegationServiceLive — start sessions in any cwd on any engine; derive any session's status.
 *
 * Delegation: one dispatch = one engine process that exits when done (the orchestrator's
 * normal lifecycle). Nothing is persisted here; the receipt is the record. The only state
 * is an in-memory slot count that caps concurrent delegated runs — owned by this layer,
 * with the same lifetime as the runs it counts (a restart kills both).
 *
 * Status: a session's state is read from its transcript's OWN terminal markers, never
 * guessed from the rendered message list (which merges pre-tool text into the tool-call
 * row and renders engine errors as ordinary assistant text):
 *   claude    last conversation entry is an assistant with stop_reason "end_turn";
 *             isApiErrorMessage marks a failure.
 *   built-in  the final assistant row carries `usage` only on normal completion; the
 *             error path writes a "⚠️ …" row without it (builtinAgent/index.ts).
 *   codex     last lifecycle event_msg: task_complete (error → failed), turn_aborted.
 */
import { open, stat } from "node:fs/promises"
import { basename, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { Duration, Effect, Either, Layer, Ref } from "effect"
import {
  AgentError,
  AppError,
  CockpitConfig,
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"
import {
  DelegationService,
  type DelegateRequest,
  type DelegationEngine,
  type DelegationParent,
  type DelegationReceipt,
  type SessionRunStatus,
  type SessionStatusReport,
} from "@cockpit/effect-services"
import { buildSessionLink } from "@cockpit/shared-utils/sessionLink"
import { dispatchChat } from "../server/engines/orchestrator"
import type { DispatchParams } from "../server/engines/types"
import { getEngineSpec } from "../server/engines/registry"
import {
  addRunListener,
  getRunInfo,
  getRunSessionId,
  isRunActive,
  requestStop,
} from "../server/sessionRunHub"
import { resolveSessionPath } from "../server/api/session/sessionStore"
import {
  parseCodexTranscriptFile,
  parseTranscriptFile,
} from "../server/api/session/transcriptParsers"

export const DELEGATION_ENGINES: ReadonlyArray<DelegationEngine> = [
  "claude", "codex", "deepseek", "kimi", "glm", "ollama",
]
const TITLE_MAX = 80
export const LAST_REPLY_MAX = 4000
/** Codex assigns its own thread id; how long to wait for it (creation only, not completion). */
export const SESSION_ID_TIMEOUT = Duration.seconds(60)
/** Terminal markers always sit at the end of a transcript. */
const TAIL_BYTES = 1024 * 1024

// ─────────────────────────────────────────────────────────
// Request (pure + filesystem checks)
// ─────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined

const invalid = (field: string, reason: string): ValidationError => new ValidationError({ field, reason })

const isDirectory = (p: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => stat(p)).pipe(
    Effect.map((s) => s.isDirectory()),
    Effect.orElseSucceed(() => false)
  )

const fileExists = (p: string): Effect.Effect<boolean, never> =>
  Effect.tryPromise(() => stat(p)).pipe(
    Effect.map((s) => s.isFile()),
    Effect.orElseSucceed(() => false)
  )

/**
 * The engine a request with no explicit `engine` runs on: the one the calling
 * session is itself running, falling back to claude.
 *
 * Inheriting is the point — a user talking to codex or glm who writes `@bot`
 * (or `/dl`) means "another one of these", not "and now a claude". The engine
 * cannot be read off the request: which engine a chat turn uses is decided by
 * its ROUTE (`/api/chat` vs `/api/chat/<engine>`), so the only record of it is
 * the run registry entry the caller's own turn opened.
 *
 * Three ways to have no parent engine — no `x-cockpit-run-id` header (a caller
 * outside a turn), a run already evicted, or an engine outside
 * DELEGATION_ENGINES (a built-in agent engine) — and all three land on claude,
 * which is what every delegation did before this existed.
 *
 * Note this is the fallback ONLY. An `engine` spelled out in the body that is
 * not a real engine still fails the request: that is a caller's typo, and
 * quietly running something else is worse than a 400.
 */
const inheritedEngine = (parentRunId: string | null | undefined): DelegationEngine => {
  const parent = parentRunId ? getRunInfo(parentRunId)?.engine : null
  return parent && DELEGATION_ENGINES.includes(parent as DelegationEngine)
    ? (parent as DelegationEngine)
    : "claude"
}

export const validateRequest = (
  body: Readonly<Record<string, unknown>>,
  parentRunId?: string | null
): Effect.Effect<DelegateRequest, ValidationError> =>
  Effect.gen(function* () {
    const cwd = str(body.cwd)
    if (!cwd || !isAbsolute(cwd)) return yield* Effect.fail(invalid("cwd", "must be an absolute path"))
    if (!(yield* isDirectory(cwd))) return yield* Effect.fail(invalid("cwd", "directory does not exist"))

    const engine = (str(body.engine) ?? inheritedEngine(parentRunId)) as DelegationEngine
    if (!DELEGATION_ENGINES.includes(engine)) {
      return yield* Effect.fail(invalid("engine", `expected one of ${DELEGATION_ENGINES.join(", ")}`))
    }

    const prompt = str(body.prompt)
    const briefPath = str(body.briefPath)
    if (!prompt && !briefPath) return yield* Effect.fail(invalid("prompt", "prompt or briefPath is required"))
    if (briefPath) {
      if (!isAbsolute(briefPath)) return yield* Effect.fail(invalid("briefPath", "must be an absolute path"))
      if (!(yield* fileExists(briefPath))) return yield* Effect.fail(invalid("briefPath", "file does not exist"))
    }

    const fallbackTitle = prompt ? prompt.split("\n")[0] : basename(briefPath!)
    const title = (str(body.title) ?? fallbackTitle).replace(/\s+/g, " ").slice(0, TITLE_MAX)
    const model = str(body.model)
    return { cwd, engine, title, ...(model && { model }), ...(prompt && { prompt }), ...(briefPath && { briefPath }) }
  })

/** The child's first message: title first (session lists title a session by it), then origin, then the task. */
export const buildChildPrompt = (request: DelegateRequest, parent: DelegationParent | null): string => {
  const lines: string[] = [`Task: ${request.title}`]
  if (parent) lines.push(`[Delegated from Cockpit session ${parent.link} (${basename(parent.cwd)})]`)
  lines.push("")
  if (request.prompt) lines.push(request.prompt)
  if (request.briefPath) lines.push(`Read this task brief first, then carry it out: ${request.briefPath}`)
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────
// Concurrency slots
// ─────────────────────────────────────────────────────────

export interface SlotState {
  /** Run keys of delegated runs that were still active when last seen. */
  readonly runs: ReadonlyArray<string>
  /** Delegations inside dispatch that have not registered a run yet. */
  readonly reserved: number
}

/** Pure check-and-claim; run inside Ref.modify so no request can slip between check and claim. */
export const claimSlot = (
  state: SlotState,
  max: number,
  isActive: (runKey: string) => boolean
): readonly [boolean, SlotState] => {
  const runs = state.runs.filter(isActive)
  if (runs.length + state.reserved >= max) return [false, { runs, reserved: state.reserved }]
  return [true, { runs, reserved: state.reserved + 1 }]
}

// ─────────────────────────────────────────────────────────
// Run registry bridges
// ─────────────────────────────────────────────────────────

export const resolveParent = (runId: string | null): Effect.Effect<DelegationParent | null, never> =>
  Effect.sync(() => {
    if (!runId) return null
    const info = getRunInfo(runId)
    if (!info?.cwd || !info.sessionId) return null
    return { cwd: info.cwd, sessionId: info.sessionId, link: buildSessionLink(info.cwd, info.sessionId) }
  })

/**
 * The engine's real session id for a run: at once when known, else on `system/init` or
 * the rekey; fails when the run has ended (or ends) without one, or the timeout passes
 * (the timeout interrupts the wait, whose canceller detaches the listener).
 */
export const waitForSessionId = (
  runKey: string,
  timeout: Duration.DurationInput
): Effect.Effect<string, AgentError> =>
  Effect.async<string, AgentError>((resume) => {
    let settled = false
    let off: () => void = () => {}
    const settle = (result: Effect.Effect<string, AgentError>) => {
      if (settled) return
      settled = true
      off() // Effect.async's canceller only runs on interruption — detach here on completion.
      resume(result)
    }
    const known = getRunSessionId(runKey)
    if (known) {
      settle(Effect.succeed(known))
      return
    }
    off = addRunListener(runKey, ({ message }) => {
      const m = message as { type?: string; subtype?: string; session_id?: unknown; status?: string }
      if (m.type === "system" && m.subtype === "init" && typeof m.session_id === "string" && m.session_id) {
        settle(Effect.succeed(m.session_id))
      } else if (m.type === "run-ended") {
        const sid = getRunSessionId(runKey)
        settle(
          sid
            ? Effect.succeed(sid)
            : Effect.fail(
                new AgentError({
                  provider: "codex",
                  kind: "protocol",
                  cause: new Error(`run ended (${m.status}) before a session id was assigned`),
                })
              )
        )
      }
    })
    // Close the race with anything that landed between the first check and subscribing:
    // a rekey (id now known), or the run already over (fail now, not after the timeout).
    const again = getRunSessionId(runKey)
    if (again) {
      settle(Effect.succeed(again))
    } else if (!isRunActive(runKey)) {
      settle(
        Effect.fail(
          new AgentError({
            provider: "codex",
            kind: "protocol",
            cause: new Error("run ended before a session id was assigned"),
          })
        )
      )
    }
    return Effect.sync(() => off())
  }).pipe(
    Effect.timeoutFail({
      duration: timeout,
      onTimeout: () =>
        new AgentError({ provider: "codex", kind: "timeout", cause: new Error("timed out waiting for the session id") }),
    })
  )

// ─────────────────────────────────────────────────────────
// Status (terminal markers)
// ─────────────────────────────────────────────────────────

type Terminal = Exclude<SessionRunStatus, "running">

export interface TranscriptEntry {
  readonly type?: string
  readonly isMeta?: boolean
  readonly isApiErrorMessage?: boolean
  readonly payload?: { readonly type?: string; readonly error?: unknown }
  readonly message?: {
    readonly stop_reason?: string | null
    readonly usage?: unknown
    readonly content?: unknown
  }
}

/** Parse the complete JSON lines of a transcript tail (the first line may be cut). */
export const parseTailEntries = (tail: string, cut: boolean): TranscriptEntry[] => {
  const lines = tail.split("\n")
  return (cut ? lines.slice(1) : lines).flatMap((line) => {
    if (!line.trim()) return []
    const parsed = Either.try(() => JSON.parse(line) as TranscriptEntry)
    return Either.isRight(parsed) ? [parsed.right] : []
  })
}

const firstText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
    .map((b) => b.text ?? "")
    .join("")
}

/**
 * Terminal state of a claude-shaped transcript (claude CLI or a built-in engine), or null
 * when the entries hold no conversation entry at all — no evidence either way.
 */
export const claudeShapedTerminal = (entries: ReadonlyArray<TranscriptEntry>, engine: string): Terminal | null => {
  const last = [...entries].reverse().find((e) => (e.type === "user" || e.type === "assistant") && !e.isMeta)
  if (!last) return null
  if (last.type !== "assistant") return "incomplete"
  if (engine === "claude") {
    if (last.isApiErrorMessage) return "failed"
    return last.message?.stop_reason === "end_turn" ? "done" : "incomplete"
  }
  if (last.message?.usage !== undefined) return "done"
  return firstText(last.message?.content).trimStart().startsWith("⚠️") ? "failed" : "incomplete"
}

/** Terminal state of a codex rollout from its last lifecycle event, or null when none is present. */
export const codexTerminal = (entries: ReadonlyArray<TranscriptEntry>): Terminal | null => {
  const lifecycle = [...entries]
    .reverse()
    .find(
      (e) =>
        e.type === "event_msg" &&
        ["task_complete", "task_started", "turn_aborted"].includes(e.payload?.type ?? "")
    )
  if (!lifecycle) return null
  if (lifecycle.payload?.type !== "task_complete") return "incomplete"
  return lifecycle.payload.error ? "failed" : "done"
}

const readTail = (file: string, bytes: number): Effect.Effect<{ text: string; cut: boolean }, AppError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(file, "r"),
      catch: (cause) => new AppError({ message: `failed to open transcript ${file}`, cause }),
    }),
    (fh) =>
      Effect.tryPromise({
        try: async () => {
          const { size } = await fh.stat()
          const length = Math.min(size, bytes)
          const buf = Buffer.alloc(length)
          await fh.read(buf, 0, length, size - length)
          return { text: buf.toString("utf-8"), cut: size > length }
        },
        catch: (cause) => new AppError({ message: `failed to read transcript ${file}`, cause }),
      }),
    (fh) => Effect.tryPromise(() => fh.close()).pipe(Effect.ignore)
  )

/**
 * Terminal state from the transcript tail, growing the window (×4) while it holds no
 * evidence. A final record can be larger than any fixed tail — a very long reply is one
 * JSONL line — and "no marker in the window" must never be read as "never finished".
 * Only a whole-file read without evidence is incomplete.
 */
export const readTerminal = (
  file: string,
  terminalOf: (entries: ReadonlyArray<TranscriptEntry>) => Terminal | null,
  initialBytes: number = TAIL_BYTES
): Effect.Effect<Terminal, AppError> =>
  Effect.gen(function* () {
    let bytes = initialBytes
    for (;;) {
      const tail = yield* readTail(file, bytes)
      const terminal = terminalOf(parseTailEntries(tail.text, tail.cut))
      if (terminal !== null) return terminal
      if (!tail.cut) return "incomplete"
      bytes *= 4
    }
  })

export const lastReplyOf = (
  messages: ReadonlyArray<{ role: string; content: string }>,
  max: number
): { lastReply: string | null; lastReplyTruncated: boolean } => {
  const reply = [...messages].reverse().find((m) => m.role === "assistant" && m.content.trim())?.content.trim() ?? null
  if (reply === null || reply.length <= max) return { lastReply: reply, lastReplyTruncated: false }
  return { lastReply: reply.slice(0, max), lastReplyTruncated: true }
}

const statusImpl = (
  cwd: string,
  sessionId: string,
  full: boolean
): Effect.Effect<SessionStatusReport, NotFoundError | AppError> =>
  Effect.gen(function* () {
    const running = yield* Effect.sync(() => isRunActive(sessionId))
    const store = yield* Effect.promise(() => resolveSessionPath(cwd, sessionId))
    const link = buildSessionLink(cwd, sessionId)
    if (!store) {
      if (!running) return yield* Effect.fail(new NotFoundError({ resource: "session", id: sessionId }))
      return { cwd, sessionId, engine: null, title: "", status: "running", lastReply: null, lastReplyTruncated: false, link }
    }
    const parsed = yield* Effect.tryPromise({
      try: () =>
        store.engine === "codex" ? parseCodexTranscriptFile(store.sessionPath) : parseTranscriptFile(store.sessionPath),
      catch: (cause) => new AppError({ message: `failed to parse transcript ${store.sessionPath}`, cause }),
    })
    const engine = store.engine
    const status: SessionRunStatus = running
      ? "running"
      : yield* readTerminal(store.sessionPath, (entries) =>
          engine === "codex" ? codexTerminal(entries) : claudeShapedTerminal(entries, engine)
        )
    return {
      cwd,
      sessionId,
      engine: store.engine,
      title: parsed.title,
      status,
      ...lastReplyOf(parsed.messages, full ? Number.POSITIVE_INFINITY : LAST_REPLY_MAX),
      link,
    }
  })

// ─────────────────────────────────────────────────────────
// Layer
// ─────────────────────────────────────────────────────────

export const DelegationServiceLive = Layer.effect(
  DelegationService,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const max = cfg.delegateMaxConcurrent
    const slots = yield* Ref.make<SlotState>({ runs: [], reserved: 0 })

    const reserve: Effect.Effect<void, ValidationError> = Ref.modify(slots, (s) =>
      claimSlot(s, max, isRunActive)
    ).pipe(
      Effect.filterOrFail(
        (claimed) => claimed,
        () => invalid("engine", `too many delegated sessions running (max ${max}); try again when one finishes`)
      ),
      Effect.asVoid
    )
    const release: Effect.Effect<void> = Ref.update(slots, (s) => ({ ...s, reserved: s.reserved - 1 }))

    const delegate = (
      request: DelegateRequest,
      parentRunId: string | null
    ): Effect.Effect<DelegationReceipt, ValidationError | AgentError> =>
      Effect.gen(function* () {
        const spec = getEngineSpec(request.engine)
        if (!spec) return yield* Effect.fail(invalid("engine", `no engine spec for ${request.engine}`))
        const parent = yield* resolveParent(parentRunId)
        const presetId = randomUUID()

        // dispatchChat's preflight settles `model` in place — an engine may complete a bare
        // ollama name to its installed tag, or pick one when the request named none. Keep the
        // object so the receipt reports the model the session ACTUALLY runs on: the receipt is
        // the only record of this delegation, and one naming a model that never ran is how the
        // caller ends up resending to the wrong one.
        const dispatchParams: DispatchParams = {
          prompt: buildChildPrompt(request, parent),
          cwd: request.cwd,
          engine: request.engine,
          runId: presetId,
          ...(request.engine === "claude" && { newSessionId: presetId }),
          ...(request.model && { model: request.model }),
        }

        // The slot is held until the run is registered (or dispatch fails), so two
        // concurrent requests can never both pass the cap while one is still dispatching.
        const runKey = yield* Effect.acquireUseRelease(
          reserve,
          () =>
            Effect.gen(function* () {
              const outcome = yield* Effect.tryPromise({
                try: () => dispatchChat(spec, dispatchParams),
                catch: (cause) => new AgentError({ provider: request.engine, kind: "unknown", cause }),
              })
              if (!outcome.ok) return yield* Effect.fail(invalid("engine", outcome.error))
              yield* Ref.update(slots, (s) => ({ ...s, runs: [...s.runs, outcome.runKey] }))
              return outcome.runKey
            }),
          () => release
        )

        // claude honours the preset id; built-in engines use runId as the session id.
        const sessionId =
          request.engine === "codex"
            ? yield* waitForSessionId(runKey, SESSION_ID_TIMEOUT).pipe(
                Effect.tapError(() => Effect.sync(() => requestStop(runKey)))
              )
            : presetId

        const model = dispatchParams.model ?? request.model
        return {
          cwd: request.cwd,
          engine: request.engine,
          ...(model && { model }),
          sessionId,
          link: buildSessionLink(request.cwd, sessionId),
          title: request.title,
          createdAt: Date.now(),
          ...(parent && { parent }),
        }
      }).pipe(Effect.withSpan("delegation.delegate", { attributes: { engine: request.engine } }))

    return DelegationService.of({
      validate: validateRequest,
      delegate,
      status: (cwd, sessionId, options) =>
        statusImpl(cwd, sessionId, options?.full === true).pipe(Effect.withSpan("delegation.status")),
    })
  })
)
