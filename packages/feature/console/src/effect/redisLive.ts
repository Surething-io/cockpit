/**
 * RedisServiceLive — Layer.scoped lifecycle.
 *
 * - command: the Layer owns a client Map<id, Redis> and quits every client on Scope close.
 * - subscribe: uses a separate short-lived client (ioredis requires a
 *   dedicated subscription connection); the Stream owns it via acquireRelease.
 */
import { Effect, Layer, Queue, Ref, Scope, Stream } from "effect"
import Redis from "ioredis"
import { DBError } from "@cockpit/effect-core"
import { RedisService } from "@cockpit/effect-services"

interface ManagedRedis {
  client: Redis
  connectionString: string
  createdAt: number
}

const handleAsync = <A>(
  op: string,
  f: () => Promise<A>
): Effect.Effect<A, DBError> =>
  Effect.tryPromise({
    try: f,
    catch: (cause) => new DBError({ db: "redis", op, cause }),
  })

const acquireClient = (
  clientsRef: Ref.Ref<Map<string, ManagedRedis>>,
  id: string,
  connectionString: string
): Effect.Effect<Redis, DBError> =>
  Effect.gen(function* () {
    const clients = yield* Ref.get(clientsRef)
    const existing = clients.get(id)
    if (existing && existing.connectionString === connectionString) {
      // Already connected -> reuse; otherwise close and reconnect
      if (existing.client.status === "ready") return existing.client
      yield* handleAsync("quit", () => existing.client.quit()).pipe(
        Effect.orElse(() => Effect.void)
      )
    } else if (existing) {
      yield* handleAsync("quit", () => existing.client.quit()).pipe(
        Effect.orElse(() => Effect.void)
      )
    }
    const client = yield* handleAsync("connect", async () => {
      const c = new Redis(connectionString, {
        lazyConnect: true,
        connectTimeout: 10000,
        maxRetriesPerRequest: 1,
      })
      await c.connect()
      return c
    })
    yield* Ref.update(clientsRef, (m) => {
      const next = new Map(m)
      next.set(id, { client, connectionString, createdAt: Date.now() })
      return next
    })
    return client
  })

const disconnectClient = (
  clientsRef: Ref.Ref<Map<string, ManagedRedis>>,
  id: string
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const clients = yield* Ref.get(clientsRef)
    const managed = clients.get(id)
    if (!managed) return
    yield* handleAsync("disconnect", () => managed.client.quit()).pipe(
      Effect.orElse(() => Effect.void)
    )
    yield* Ref.update(clientsRef, (m) => {
      const next = new Map(m)
      next.delete(id)
      return next
    })
  })

interface RedisMsg {
  readonly channel: string
  readonly message: string
}

const subscribeStream = (
  connStr: string,
  pattern: string
): Stream.Stream<RedisMsg, DBError, Scope.Scope> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<RedisMsg>()

      // Dedicated subscribe client (keeps the main command client unaffected)
      const sub = yield* Effect.acquireRelease(
        handleAsync("subscribeConnect", async () => {
          const c = new Redis(connStr, {
            lazyConnect: true,
            connectTimeout: 10000,
            maxRetriesPerRequest: 1,
          })
          await c.connect()
          return c
        }),
        (c) =>
          Effect.tryPromise({
            try: () => c.quit(),
            catch: () => new DBError({ db: "redis", op: "subscribeQuit", cause: null }),
          }).pipe(Effect.orElse(() => Effect.void))
      )

      const isPattern = pattern.includes("*") || pattern.includes("?")
      yield* handleAsync("psubscribe", () =>
        isPattern ? sub.psubscribe(pattern) : sub.subscribe(pattern)
      )

      sub.on(isPattern ? "pmessage" : "message", (...args: string[]) => {
        const channel = isPattern ? args[1] : args[0]
        const message = isPattern ? args[2] : args[1]
        Effect.runFork(Queue.offer(queue, { channel, message }))
      })

      return Stream.fromQueue(queue)
    })
  )

export const RedisServiceLive = Layer.scoped(
  RedisService,
  Effect.gen(function* () {
    const clientsRef = yield* Ref.make(new Map<string, ManagedRedis>())

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const clients = yield* Ref.get(clientsRef)
        for (const { client } of clients.values()) {
          yield* Effect.tryPromise({
            try: () => client.quit(),
            catch: (cause) => new DBError({ db: "redis", op: "shutdown quit", cause }),
          }).pipe(Effect.orElse(() => Effect.void))
        }
        yield* Ref.set(clientsRef, new Map())
        yield* Effect.logInfo(
          `[RedisServiceLive] disposed ${clients.size} client(s)`
        )
      })
    )

    return RedisService.of({
      command: (id, connStr, cmd, args) =>
        Effect.gen(function* () {
          const client = yield* acquireClient(clientsRef, id, connStr)
          const result = yield* handleAsync("call", () =>
            client.call(cmd, ...((args ?? []) as (string | number | Buffer)[]))
          )
          return result
        }).pipe(Effect.withSpan("redis.command", { attributes: { id, cmd } })),

      subscribe: (_id, connStr, pattern) => subscribeStream(connStr, pattern),

      disconnect: (id) => disconnectClient(clientsRef, id),
    })
  })
)
