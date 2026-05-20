# EFFECT.md — Cockpit Effect Conventions

> Engineering standard for the Effect paradigm used across Cockpit.
> Also serves as the system prompt for AI agents.
> Any exception → update this document first, **never silently break the contract in code**.

---

## 0. Core thesis

**All IO / side-effects / dependencies / errors must be expressed as `Effect<A, E, R>`.**

Hard exclusions:
- React render layer / pure UI state (hover/expanded/menuOpen)
- Pure utility functions (`packages/shared/utils`)
- Third-party "stateful" components (xterm / tiptap / xyflow / shiki / tree-sitter)
- Subprocess IPC adapters (LSP `pyrightAdapter` / `tsserverAdapter` / `LSPServerRegistry`,
  Jupyter `JupyterKernelManager`) — child_process + readline + stdio JSON protocol
  are inherently imperative; keep `try/catch` + `console.error` as the subprocess gateway
- Tracer defect path (`effect-runtime/src/next.ts` uncaught defect handler) —
  the Effect runtime has already failed, no fiber context available, so synchronous
  `console.error` is permitted
- Short UI `setTimeout` / debounce / reconnect (< 5s visual/network fallback) —
  ESLint emits a warning but does not force a rewrite to `Effect.delay`
  (**retries / backoff must use `Schedule`**; UI visual feedback is free to remain)

---

## 1. Package layout

```
packages/shared/
  effect-core/        Error types + combinators + Logger/Tracer/Config/Schedule
  effect-services/    Service Tag interfaces (definitions only, NO implementations)
  effect-runtime/     Runtime + Next.js handler + Browser Layer
    src/server/       Server-only (wsAdapter / AppRuntime)
    src/browser/      Browser-only (iframeBusLive)
  effect-react/       useEffectQuery / Mutation / Stream

packages/feature/<X>/
  effect/             Feature-private Service Live implementations
  server/effect/      Server-side business Service Live
  client/effect/      Client-side HTTP call wrappers
```

**Conventions**:
- Cross-feature shared adapters live under `effect-runtime/src/{server,browser}/`
- Cross-feature client wrapper reuse: import the existing `<X>Client.ts` first,
  **do not redefine wrappers for the same endpoint in a new feature**

---

## 2. Error types (Tagged Error)

Every IO error must fall into one of:

```
IO errors (retryable):    DBError / WSError / FSError / AgentError
Business errors (no retry): ValidationError / NotFoundError / PermissionError
Generic fallback:           AppError
```

Rules:
- Define with `Data.TaggedError("XxxError")<{...}>`
- `cause: unknown` preserves the underlying exception — **never swallow errors**
- HTTP status codes: `errorToStatus(e)` handles 400 / 403 / 404 / 503 / 500 mapping

---

## 3. API Route template

```ts
// src/app/api/<name>/route.ts
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { XxxService } from "@cockpit/effect-services"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler(() =>
  Effect.gen(function* () {
    const service = yield* XxxService
    const data = yield* service.read
    return ok(data)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as XxxData
    yield* (yield* XxxService).write(body)
    return ok({ success: true })
  })
)
```

Service Live instances are provided centrally by `AppRuntime`
(`effect-runtime/src/server/runtime.ts`); business routes **do not** call
`Effect.provide` themselves.

**Forbidden**: `export async function GET()` bare functions; `try/catch + return new Response`; swallowing errors via `console.error(e)`.

---

## 4. Service definition template

```ts
// packages/shared/effect-services/src/xxx.ts  (Tag — interface only)
export interface XxxService {
  readonly read: Effect.Effect<XxxData, FSError>
  readonly write: (data: XxxData) => Effect.Effect<void, FSError>
}
export const XxxService = Context.GenericTag<XxxService>("@cockpit/XxxService")

// packages/feature/<X>/effect/xxxLive.ts  (Live implementation)
export const XxxServiceLive = Layer.succeed(
  XxxService,
  XxxService.of({
    read: Effect.tryPromise({
      try: () => /* SDK call */,
      catch: (cause) => new FSError({ path, op: "read", cause }),
    }),
    write: (data) => Effect.tryPromise({ try: ..., catch: (cause) => new FSError({...}) }),
  })
)
```

**Rules**:
- Tag id must follow `@cockpit/<ServiceName>` format
- Third-party SDK calls must use `Effect.tryPromise({try, catch})`; `catch` must return a Tagged Error — **never** `() => new Error(...)`
- Connection pools / subprocesses / `Map<id, conn>` resources → use `Layer.scoped` + `Effect.addFinalizer`, **never globalThis singletons**

---

## 5. WebSocket Handler template

```ts
// packages/feature/<X>/server/effect/xxxHandler.ts
export const handleXxx = (
  conn: WSConnection,
  query: Record<string, string | undefined>
): Effect.Effect<void, WSError | FSError, Scope.Scope> =>
  Effect.gen(function* () {
    // Heartbeats / watchers / subscriptions: all forkScoped — Scope close auto-interrupts
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), Schedule.spaced("30 seconds"))
    )

    yield* conn.messages.pipe(
      Stream.tap((msg) => /* route handling */),
      Stream.runDrain
    )
  })
```

The bridge entry point (`runXxxHandler`) is produced by the `fromWebSocket` factory —
it wraps the program in `Effect.scoped` and calls `fiber.interruptAsFork(...)` on
`ws.on('close')`; business code does not need to repeat this.

**Rules**:
- Heartbeats, watchers, subscriptions: always `Effect.forkScoped`
- **Forbidden**: hand-written `setInterval` / `clearInterval` / `ws.on('close', cleanup)`
- **Forbidden**: hand-written mutex (`sending`/`pendingSend`) — use `Stream.debounce` or `Queue`

---

## 6. React bridging

Three hooks plus one explicit runtime entry point:

```ts
useEffectQuery(effect, deps)        // Data loading; returns {status, data, error}
useEffectMutation(makeEffect)       // User-triggered (POST/PUT/DELETE)
useEffectStream(effect, deps)       // Long connections / subscriptions

BrowserRuntime.runPromise(effect)     // Explicit run; rejects with FiberFailure on fail
BrowserRuntime.runPromiseExit(effect) // Explicit run; returns Exit (recommended — full cause readable)
BrowserRuntime.runFork(effect)        // Fire-and-forget
```

```ts
// Typical usage
const exit = await BrowserRuntime.runPromiseExit(loadProjects())
if (exit._tag === "Success") setData(exit.value)
else /* branch on Tagged Error in exit.cause */
```

**Forbidden**:
- Bare `fetch(...)` inside React components / hooks — go through `client/effect/<X>Client.ts`
- Bare `try/catch` around mutations — use Tagged Errors
- Rx / SubscriptionRef in render layer — **keep `useState`**

**Allowed**: pure UI state (hover/expanded/menuOpen) + `useMemo` / `useCallback` stay native.

---

## 7. Cross-iframe communication

```ts
import { IframeBus, Topics } from "@cockpit/effect-services"
import { BrowserRuntime } from "@cockpit/effect-runtime"

// Publish
BrowserRuntime.runFork(
  Effect.flatMap(IframeBus, bus =>
    bus.publish(Topics.SessionChange, { sessionId })
  )
)

// Subscribe
const session = useEffectStream(
  Effect.flatMap(IframeBus, bus => bus.subscribe(Topics.SessionChange)),
  []
)
```

**Forbidden**: bare `window.parent.postMessage({ type: 'XXX', ... }, '*')` / `window.addEventListener("message", ...)`.

**Adding a new protocol**: declare the Topic in `packages/shared/effect-services/src/topics.ts` — single source of truth, visible at compile time.

---

## 8. Retry / Scheduling

`@cockpit/effect-core` ships standard policies:

| Policy | Purpose |
|---|---|
| `wsReconnect` / `wsHeartbeat` | WS reconnect / heartbeat |
| `dbRetry` / `agentRetry` | Database / LLM retries |
| `shortPoll` / `longPoll` | Short / long polling |
| `wsReconnectDelayMs` | Pure-function variant (for React hooks) |

```ts
import { wsReconnect, wsHeartbeat, dbRetry } from "@cockpit/effect-core"

const conn = connectWS(url).pipe(Effect.retry(wsReconnect))
yield* sendPing.pipe(Effect.repeat(wsHeartbeat))
yield* dbQuery.pipe(Effect.retry(dbRetry))
```

Custom cron / periodic tasks use `SchedulerService`:

```ts
const sched = yield* Scheduler
yield* sched.schedule("daily-report", runReportTask, Schedule.cron("0 9 * * *"))
yield* sched.cancel("daily-report")
```

**Forbidden**:
- Hand-written `setTimeout(retry, delay)` → use `Effect.retry(<policy>)` or `wsReconnectDelayMs`
- `setInterval` for periodic tasks → use `Effect.repeat(Schedule.spaced(...))` or `Scheduler.schedule`
- Hand-rolled `Math.min(base * Math.pow(factor, n), cap)` → use the standardized policies

---

## 9. Resource management

```ts
// Single-shot resource
const result = yield* Effect.acquireRelease(
  Effect.tryPromise({ try: () => acquire(), catch: ... }),
  (res) => Effect.sync(() => res.release())
).pipe(Effect.scoped)

// Long-lived (Layer owns the resource pool)
export const XxxServiceLive = Layer.scoped(
  XxxService,
  Effect.gen(function* () {
    const ref = yield* Ref.make(new Map<string, Connection>())
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const conns = yield* Ref.get(ref)
        for (const c of conns.values()) yield* close(c)
      })
    )
    return XxxService.of({ /* ... */ })
  })
)
```

**Forbidden**:
- Hand-written `try { ... } finally { resource.release() }`
- Global manager singletons (`globalThis.__xxx`) — replace with `Layer.scoped` (subprocess IPC adapters excepted, see §0)

---

## 10. CI / Lint enforcement

`packages/feature/*/server/**` + `src/app/api/**` + `src/lib/**`:

| Forbidden | Replacement |
|---|---|
| `try/catch` | `Effect.try / Effect.tryPromise` |
| `Promise.all` | `Effect.all` |
| `setTimeout(retry, ...)` | `Effect.delay / Schedule` |
| `window.parent.postMessage` | `IframeBus.publish + Topics` |
| `import { globalManager }` | `yield* XxxServiceTag` |

`packages/feature/*/client/**`:
- Bare `fetch(...)` forbidden — go through `client/effect/<X>Client.ts`
- Bare `postMessage` forbidden — go through IframeBus
- Other rules same as above; `useState` is unconstrained (pure UI)

`packages/shared/ui/**` + `packages/feature/*/components/**` (presentation only): unconstrained.

Rules are enforced in `eslint.config.mjs` (`no-restricted-imports` / `no-restricted-syntax`).

---

## 11. Type signature requirement

Business functions must **explicitly annotate** their return type:

```ts
// ✅
export const getProjects: Effect.Effect<ProjectsData, FSError> = ...
export const list = (cwd: string): Effect.Effect<Session[], FSError | DBError> => ...

// ❌ Inferred — AI cannot see dependencies / errors
export const list = (cwd: string) => Effect.gen(function* () { ... })
```

Rationale: the `Effect<A, E, R>` three-parameter signature is the primary signal an AI agent uses to reason about a function. **Do not skip it.**

---

## 12. Server / Browser boundary

**Core constraint**: server-only dependencies (pg / mysql2 / ioredis / neo4j-driver / node-pty etc.) **must not** enter the browser bundle.

| File location | Allowed imports |
|---|---|
| `src/app/api/**/route.ts` / `packages/feature/*/server/**` / `src/lib/**` | `@cockpit/effect-runtime/server` (handler), `@cockpit/effect-services` |
| `packages/feature/*/client/**` / `components/**` | `@cockpit/effect-runtime` (BrowserRuntime), `@cockpit/effect-react`, `@cockpit/effect-services` |

**Forbidden**: client / components importing `@cockpit/effect-runtime/server` or `@cockpit/feature-*/effect` (Live implementations) — this drags server-only dependencies into the client bundle, producing errors like `Module not found: Can't resolve 'dns'`.

---

## 13. Infrastructure APIs (Logger / Tracer / Config)

```ts
// Logging
yield* Effect.logInfo("user logged in").pipe(
  Effect.annotateLogs("userId", uid),
  Effect.annotateLogs("ip", ip)
)
yield* logCause("git failed", caughtErr)  // Auto-serializes Error / Cause

// Tracing — dev mode writes spans into an in-memory ring (MAX_SPANS=500, FIFO)
const result = yield* myEffect.pipe(Effect.withSpan("module.action", { attributes: { id } }))
// Query ring: GET /api/dev/spans?namePrefix=pg.&minDurationMs=100

// Config
const cfg = yield* CockpitConfig
const port = cfg.port             // typed: number
const dir = cfg.cockpitDir        // typed: string
```

**Forbidden**:
- `console.log` / `console.error` / `console.warn` (subprocess adapter exemption, see §0)
- Bare `process.env.XXX` reads — go through `CockpitConfig` (new env vars added in `config.ts`)

Layer wiring is centralized in `effect-runtime/src/server/runtime.ts`; business code does not provide layers itself:
- Server dev: `LoggerLivePretty + TracerLivePretty(ring) + ConfigLive`
- Server prod: `LoggerLiveProd(cfg.logFile) + TracerLiveNoop + ConfigLive` (zero overhead)
- Browser: always pretty

---

## 14. Notes for AI agents

If you are an AI agent asked to add or modify an IO-class operation:

1. **Match the template first**: identify which of §3-§7 applies, then 1:1 mirror the template
2. **Error types**: pick the closest Tagged Error from §2 — **never invent your own**
3. **Type signatures**: follow §11; annotate every return type explicitly
4. **External contracts**: URL / response JSON shape / postMessage protocol — leave them alone
5. **Third-party SDK boundary**: `Effect.tryPromise` is only allowed inside Live implementations; bare Promises forbidden elsewhere
6. **Cross-feature reuse**: import existing `<X>Client.ts` / `<X>ServiceLive.ts` first — **do not redefine wrappers for the same endpoint**

If a new requirement **cannot** map to any existing template → tell the user, **update this document first**, then write code.
