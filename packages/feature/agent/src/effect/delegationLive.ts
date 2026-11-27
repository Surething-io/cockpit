import { readLogicalTranscript } from './logicalTranscript';
import type { TranscriptSource } from '../server/transcriptSource';
import { isPiSessionPath } from '@cockpit/shared-utils';
import { readPiSession } from './piSessionLive';
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
 *   Pi        unresolved input metadata takes precedence over assistant stopReason;
 *             a later unrelated success cannot resolve an outstanding input.
 *   codex     last lifecycle event_msg: task_complete (error → failed), turn_aborted.
 */
import { open, readFile, stat } from "node:fs/promises"
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
import { delegatedOriginLine, parseMessageOrigin, sentOriginLine } from "../shared/messageOrigin"
import type { DispatchParams } from "../server/engines/types"
import { getEngineSpec } from "../server/engines/registry"
import {
  addRunListener,
  getRunInfo,
  getRunSessionId,
  isRunActive,
  isSessionBusy,
  requestStop,
} from "../server/sessionRunHub"
import { resolveSessionPath } from "../server/api/session/sessionStore"
import {
  parseCodexTranscriptFile,
  parseTranscriptFile,
} from "../server/api/session/transcriptParsers"

export const DELEGATION_ENGINES: ReadonlyArray<DelegationEngine> = [
  "claude", "codex", "deepseek", "kimi", "glm", "ollama", "grok",
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

/**
 * The engine an existing session runs on, read from where its transcript lives. The body
 * may not choose one: the session already has an engine, and a mismatch would either
 * resume it on the wrong engine or fail somewhere far less legible than here.
 */
const existingSessionEngine = (
  cwd: string,
  sessionId: string,
  body: Readonly<Record<string, unknown>>
): Effect.Effect<DelegationEngine, ValidationError> =>
  Effect.gen(function* () {
    if (str(body.engine)) return yield* Effect.fail(invalid("engine", "an existing session keeps its own engine; omit engine with sessionId"))
    if (str(body.model)) return yield* Effect.fail(invalid("model", "an existing session keeps its own model; omit model with sessionId"))
    const store = yield* Effect.tryPromise(() => resolveSessionPath(cwd, sessionId)).pipe(Effect.orElseSucceed(() => null))
    if (!store) return yield* Effect.fail(invalid("sessionId", `no session ${sessionId} in ${cwd}`))
    if (!DELEGATION_ENGINES.includes(store.engine as DelegationEngine)) {
      return yield* Effect.fail(invalid("sessionId", `session runs on ${store.engine}, which cannot take delegated input`))
    }
    return store.engine as DelegationEngine
  })

export const validateRequest = (
  body: Readonly<Record<string, unknown>>,
  parentRunId?: string | null
): Effect.Effect<DelegateRequest, ValidationError> =>
  Effect.gen(function* () {
    const cwd = str(body.cwd)
    if (!cwd || !isAbsolute(cwd)) return yield* Effect.fail(invalid("cwd", "must be an absolute path"))
    if (!(yield* isDirectory(cwd))) return yield* Effect.fail(invalid("cwd", "directory does not exist"))

    const sessionId = str(body.sessionId)
    const engine = sessionId
      ? yield* existingSessionEngine(cwd, sessionId, body)
      : (str(body.engine) ?? inheritedEngine(parentRunId)) as DelegationEngine
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
    return {
      cwd, engine, title,
      ...(model && { model }), ...(prompt && { prompt }), ...(briefPath && { briefPath }), ...(sessionId && { sessionId }),
    }
  })

/** The child's first message: title first (session lists title a session by it), then origin, then the task. */
export const buildChildPrompt = (request: DelegateRequest, parent: DelegationParent | null): string => {
  const lines: string[] = [`Task: ${request.title}`]
  if (parent) lines.push(delegatedOriginLine(parent.link, basename(parent.cwd)))
  lines.push("")
  if (request.prompt) lines.push(request.prompt)
  if (request.briefPath) lines.push(`Read this task brief first, then carry it out: ${request.briefPath}`)
  return lines.join("\n")
}

/**
 * A message sent into an existing session: origin first, then the task. No `Task:` title
 * line — the session already has its own title, and this is one more turn in it.
 */
export const buildSessionMessage = (request: DelegateRequest, parent: DelegationParent | null, inputId?: string): string => {
  const lines: string[] = [sentOriginLine(parent?.link ?? null, parent ? basename(parent.cwd) : "", inputId), ""]
  if (request.prompt) lines.push(request.prompt)
  if (request.briefPath) lines.push(`Read this brief first, then carry it out: ${request.briefPath}`)
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
  file: TranscriptSource,
  terminalOf: (entries: ReadonlyArray<TranscriptEntry>) => Terminal | null,
  initialBytes: number = TAIL_BYTES
): Effect.Effect<Terminal, AppError> =>
  Effect.gen(function* () {
    if (typeof file !== "string") return terminalOf(parseTailEntries(file.text, false)) ?? "incomplete"
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

/** Unfinished accepted work remains unresolved across unrelated later successes. */
export const piUnfinishedInput = (
  entries: import('@earendil-works/pi-coding-agent').SessionEntry[],
): { status: Terminal; text: string } | undefined => {
  const notices = entries.filter((entry) => entry.type === 'custom' && entry.customType === 'cockpit.undelivered-input');
  if (!notices.length) return undefined;
  const data = notices.map((entry) => entry.type === 'custom' ? entry.data as { reason?: unknown; text?: unknown } | undefined : undefined);
  return {
    status: data.some((item) => item?.reason === 'failed') ? 'failed' : 'incomplete',
    text: data.map((item) => typeof item?.text === 'string' ? item.text : 'Accepted input did not complete.').join('\n'),
  };
}

type RawEntry = { readonly [key: string]: unknown }
type InputFormat = "claude" | "codex" | "pi"

const textOf = (content: unknown): string | null => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const blocks = content as Array<{ type?: string; text?: string }>
  if (blocks.some((b) => b?.type === "tool_result")) return null // a tool result, not a person
  const text = blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("")
  return text || null
}

/** The text of a HUMAN turn in a raw transcript entry, or null for anything else. */
export const humanTurnText = (entry: RawEntry, format: InputFormat): string | null => {
  if (format === "codex") {
    const payload = entry.payload as { type?: string; message?: unknown } | undefined
    return entry.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string" ? payload.message : null
  }
  if (format === "pi") {
    const message = entry.message as { role?: string; content?: unknown } | undefined
    return entry.type === "message" && message?.role === "user" ? textOf(message.content) : null
  }
  if (entry.type !== "user" || entry.isMeta) return null
  return textOf((entry.message as { content?: unknown } | undefined)?.content)
}

/**
 * Where ONE message sent into an existing session (its origin line carries `inputId`) stands
 * in the raw transcript: whether it arrived at all, whether it is still the latest human
 * turn, and — when a later human turn followed — the engine's own end-of-turn evidence for
 * ITS segment (the entries between it and the next human turn). Having produced some text is
 * not evidence: a turn stopped after "let me look" has text and never finished.
 */
export const inputSegment = (
  entries: ReadonlyArray<RawEntry>,
  format: InputFormat,
  engine: string,
  inputId: string
): { found: false } | { found: true; latest: true } | { found: true; latest: false; terminal: Terminal } => {
  const human = entries.flatMap((entry, i) => {
    const text = humanTurnText(entry, format)
    return text === null ? [] : [{ i, text }]
  })
  const at = human.findIndex((h) => parseMessageOrigin(h.text)?.inputId === inputId)
  if (at === -1) return { found: false }
  if (at === human.length - 1) return { found: true, latest: true }
  const segment = entries.slice(human[at].i + 1, human[at + 1].i)
  let terminal: Terminal
  if (format === "codex") terminal = codexTerminal(segment as TranscriptEntry[]) ?? "incomplete"
  else if (format === "pi") {
    const last = [...segment].reverse().find((e) => e.type === "message" && (e.message as { role?: string } | undefined)?.role === "assistant")
    const stop = (last?.message as { stopReason?: string } | undefined)?.stopReason
    terminal = stop === "stop" ? "done" : stop === "error" ? "failed" : "incomplete"
  } else terminal = claudeShapedTerminal(segment as TranscriptEntry[], engine) ?? "incomplete"
  return { found: true, latest: false, terminal }
}

const NOT_DELIVERED = "The message was not delivered: the session stopped before it took it in."

/**
 * The status report for ONE message (`inputId`), never the session's latest turn:
 *   not in the transcript  → running while the session runs (it may still be queued),
 *                            else "not delivered"
 *   the latest human turn  → the session's own state (running, or its terminal state)
 *   followed by later turns → its own segment's end-of-turn evidence; a later run going on
 *                            in the session does not make this one "running"
 * The reply is the last answer between it and the next human turn.
 */
export const inputOutcome = (
  messages: ReadonlyArray<{ role: string; content: string }>,
  segment: ReturnType<typeof inputSegment>,
  inputId: string,
  sessionStatus: SessionRunStatus,
  max: number
): { status: SessionRunStatus; lastReply: string | null; lastReplyTruncated: boolean } => {
  if (!segment.found) {
    return sessionStatus === "running"
      ? { status: "running", lastReply: null, lastReplyTruncated: false }
      : { status: "incomplete", lastReply: NOT_DELIVERED, lastReplyTruncated: false }
  }
  const at = messages.findIndex((m) => m.role === "user" && parseMessageOrigin(m.content)?.inputId === inputId)
  const after = at === -1 ? [] : messages.slice(at + 1)
  const next = after.findIndex((m) => m.role === "user")
  const reply = lastReplyOf(next === -1 ? after : after.slice(0, next), max)
  return { status: segment.latest ? sessionStatus : segment.terminal, ...reply }
}

const statusImpl = (
  cwd: string,
  sessionId: string,
  full: boolean,
  inputId?: string
): Effect.Effect<SessionStatusReport, NotFoundError | AppError> =>
  Effect.gen(function* () {
    const busyAtStart = yield* Effect.sync(() => isSessionBusy(sessionId))
    const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: "Cannot resolve session status", cause }) })
    const link = buildSessionLink(cwd, sessionId)
    if (!store) {
      if (!busyAtStart && !isSessionBusy(sessionId)) return yield* Effect.fail(new NotFoundError({ resource: "session", id: sessionId }))
      return { cwd, sessionId, engine: null, title: "", status: "running", lastReply: null, lastReplyTruncated: false, link }
    }
    return yield* readLogicalTranscript(store.sessionPath, store.engine, (reader) => Effect.gen(function* () {
      const source = yield* reader.source
      const parsed = yield* Effect.tryPromise({
        try: () =>
          store.engine === "codex" ? parseCodexTranscriptFile(source) : parseTranscriptFile(source),
        catch: (cause) => new AppError({ message: `failed to parse transcript ${store.sessionPath}`, cause }),
      })
      const engine = store.engine
      const piView = isPiSessionPath(store.sessionPath) ? yield* readPiSession(store.sessionPath) : undefined
      const unfinished = piView ? piUnfinishedInput(piView.entries) : undefined
      // Stop ends live streaming immediately, but the writer still owns cleanup
      // and persistence. Never derive completion from an older disk image then.
      const running = busyAtStart || (yield* Effect.sync(() => isSessionBusy(sessionId)))
      const status: SessionRunStatus = running
        ? "running"
        : piView
          ? unfinished?.status ?? (() => {
              const last = piView.entries.findLast((entry) => entry.type === 'message');
              if (last?.type !== 'message' || last.message.role !== 'assistant') return 'incomplete';
              return last.message.stopReason === 'error' ? 'failed' : last.message.stopReason === 'stop' ? 'done' : 'incomplete';
            })()
          : yield* readTerminal(store.sessionPath, (entries) =>
              engine === "codex" ? codexTerminal(entries) : claudeShapedTerminal(entries, engine)
            ).pipe(Effect.catchAll((error) => (error.cause as NodeJS.ErrnoException)?.code === 'ENOENT'
              ? readTerminal(source, (entries) => engine === "codex" ? codexTerminal(entries) : claudeShapedTerminal(entries, engine))
              : Effect.fail(error)))
      const max = full ? Number.POSITIVE_INFINITY : LAST_REPLY_MAX
      if (inputId) {
        const format: InputFormat = piView ? "pi" : engine === "codex" ? "codex" : "claude"
        const raw: ReadonlyArray<RawEntry> = piView
          ? (piView.entries as unknown as RawEntry[])
          : parseTailEntries(
              typeof source === "string"
                ? yield* Effect.tryPromise({ try: () => readFile(source, "utf-8"), catch: (cause) => new AppError({ message: `failed to read transcript ${source}`, cause }) })
                : source.text,
              false
            ) as unknown as RawEntry[]
        const segment = inputSegment(raw, format, engine, inputId)
        return { cwd, sessionId, engine: store.engine, title: parsed.title, ...inputOutcome(parsed.messages, segment, inputId, status, max), link }
      }
      return {
        cwd,
        sessionId,
        engine: store.engine,
        title: parsed.title,
        status,
        ...lastReplyOf(unfinished && !running ? [{ role: 'assistant', content: unfinished.text }] : parsed.messages, max),
        link,
      }
    })).pipe(Effect.mapError((cause) => cause instanceof AppError ? cause : new AppError({ message: "Cannot read session status", cause })))
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

        // Into an existing session: exactly what typing into it does. A live run takes the
        // message mid-run (`inject`), an idle session starts its next turn; the session's
        // recorded model is used. No slot is claimed — no new session is being created, and
        // a person typing the same message into that tab is not capped either.
        if (request.sessionId) {
          const target = request.sessionId
          if (parent && parent.sessionId === target) {
            return yield* Effect.fail(invalid("sessionId", "a session cannot send a task to itself"))
          }
          // The message's own identity: written into its origin line and returned in the
          // receipt, so `status` can follow THIS message rather than the session's last turn.
          const inputId = randomUUID()
          const outcome = yield* Effect.tryPromise({
            try: () => dispatchChat(spec, {
              prompt: buildSessionMessage(request, parent, inputId),
              cwd: request.cwd,
              engine: request.engine,
              sessionId: target,
              runId: inputId,
              inject: true,
            }),
            catch: (cause) => new AgentError({ provider: request.engine, kind: "unknown", cause }),
          })
          if (!outcome.ok) return yield* Effect.fail(invalid("sessionId", outcome.error))
          return {
            cwd: request.cwd,
            engine: request.engine,
            sessionId: target,
            link: buildSessionLink(request.cwd, target),
            title: request.title,
            createdAt: Date.now(),
            existing: true,
            inputId,
            ...(parent && { parent }),
          }
        }

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
        statusImpl(cwd, sessionId, options?.full === true, options?.inputId).pipe(Effect.withSpan("delegation.status")),
    })
  })
)
