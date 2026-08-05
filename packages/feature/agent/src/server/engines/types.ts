// Shared contracts for the engine dispatch subsystem. Pure types — no runtime code,
// so importing them never creates an engines↔engines or api→engines coupling.

export interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

/** Parsed dispatch input — the union of fields the HTTP route and the scheduled-task
 *  manager both supply. The scheduler omits request-only fields and passes no `request`. */
export interface DispatchParams {
  prompt?: unknown;
  sessionId?: string;
  runId?: string;
  images?: ImageData[];
  cwd?: string;
  language?: string;
  engine?: string;
  model?: string;
  // Execution mode. 'pty' → Claude Code CLI (claude/claude2 only); 'builtin' → the Built-in
  // Agent loop (deepseek only); absent/anything else → the vendor SDK loop. Runners that
  // support only one mode ignore this.
  mode?: string;
  // claude-only (other runners ignore)
  permissionMode?: string;
  ptyCols?: number;
  ptyRows?: number;
  // Send ONLY this turn to the model, no prior messages — each user message becomes an
  // independent task. The transcript is still read/written either way, so the UI history
  // stays continuous; this only affects what the model is given.
  //
  // Honored by two different mechanisms:
  //  - Built-in Agent (ollama, deepseek in mode:'builtin') simply omits the prior messages
  //    when assembling the request (builtinAgent/index.ts).
  //  - claude/claude2 in SDK mode stash the transcript for the turn, because their history
  //    IS the provider session and the only lever is whether that file is there
  //    (shared/noHistoryTranscript.ts). Not available in mode:'pty' — the interactive CLI
  //    holds the context itself.
  // Ignored by codex, kimi and deepseek-SDK, whose context lives with the vendor.
  noHistory?: boolean;
}

/** Dispatch result. The run is detached (fire-and-forget); on success the caller gets the
 *  registry runKey immediately and observes progress via the run registry — the HTTP route
 *  streams it through /ws/session-stream; the scheduler polls isRunActive/getRunSnapshot. */
export type DispatchOutcome =
  | { ok: true; runKey: string; sessionId: string | null }
  | { ok: false; status: number; error: string };

/** One event fanned out to the run registry. Must carry a discriminating `type`. */
export type RunEvent = { type: string; [key: string]: unknown };

/** The "world" the orchestrator hands a runner. A runner produces side-effects ONLY through
 *  this — it never touches sessionRunHub / globalState / markRunIdle / the close flag. */
export interface RunCtx {
  readonly prompt: string | undefined;       // slash-expanded, validated non-empty (unless images)
  readonly images: ImageData[] | undefined;
  readonly cwd: string;                       // normalized, may be ''
  readonly sessionId: string | undefined;     // resume target (undefined → new session)
  readonly params: DispatchParams;            // pass-through (model / mode / permissionMode / engine)
  readonly signal: AbortSignal;               // wire this to the engine's own cancellation
  /** Feed one event to the run registry (orchestrator: appendRun(currentKey, event)). */
  emit(event: RunEvent): void;
  /** Engine revealed its real sessionId (system.init / thread.started / fs detect). Idempotent.
   *  Updates the run alias AND the sessionId the orchestrator returns. */
  rekey(realSessionId: string): void;
  /** Current registry key (changes after rekey). Diagnostics only. */
  currentKey(): string;
}

/** A runner implements ONLY the engine-specific middle: the run loop + (optional) title. */
export interface EngineRunner {
  /** The run loop. Throw = failure (orchestrator marks 'error' + emits error). Return = success
   *  (orchestrator does the shared teardown). Never call markRunIdle / startRun itself. */
  run(ctx: RunCtx): Promise<void>;
  /** Teardown title source: SDK engines return getSessionTitle(cwd,sid); spawn engines omit. */
  resolveTitle?(cwd: string, sessionId: string): Promise<string | undefined>;
}

/** Static per-engine wiring consumed by the orchestrator + registry. */
export interface EngineSpec {
  name: string;
  /** Sync pre-check BEFORE startRun (e.g. deepseek apiKey). ok:false short-circuits with no
   *  registry side-effects. May mutate params (e.g. resolve model). */
  preflight?(params: DispatchParams): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  runner: EngineRunner;
}
