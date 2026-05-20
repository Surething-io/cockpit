/**
 * handleJupyter — Effect-based WebSocket handler.
 *
 * Protocol:
 *  - Start or reuse a kernel → send { type: "ready" } or kernel_error.
 *  - Subscribe to kernel output → status / kernel_error / kernel_died / output.
 *  - Handle execute / interrupt messages by delegating to kernelManager.
 *
 * Note: the kernel survives WS close (so reconnects can reuse it); the
 *      acquireRelease only tears down listeners and never closes the kernel.
 */
import { Effect, Queue, Schedule, Scope, Stream } from "effect"
import type { WebSocket } from "ws"
import {
  AppError,
  ValidationError,
  WSError,
} from "@cockpit/effect-core"
import type { WSConnection } from "@cockpit/effect-services"
import { fromWebSocket } from "@cockpit/effect-runtime/server"

const HEARTBEAT = Schedule.spaced("30 seconds")

interface KernelMsg {
  msg_type: string
  msg_id?: string
  content: Record<string, unknown>
}

export const handleJupyter = (
  conn: WSConnection,
  bubbleId: string,
  cwd: string
): Effect.Effect<void, WSError | ValidationError | AppError, Scope.Scope> =>
  Effect.gen(function* () {
    if (!bubbleId || !cwd) {
      return yield* Effect.fail(
        new ValidationError({
          field: !bubbleId ? "bubbleId" : "cwd",
          reason: "missing",
        })
      )
    }

    yield* Effect.logInfo("ws/jupyter start").pipe(
      Effect.annotateLogs("bubbleId", bubbleId),
      Effect.annotateLogs("cwd", cwd)
    )

    // Lazy import — avoids pulling the kernel manager into every WS connection
    const { kernelManager } = yield* Effect.tryPromise({
      try: () => import("@cockpit/feature-console/server"),
      catch: (cause) =>
        new AppError({
          message: "failed to import kernel manager",
          cause,
        }),
    })

    // Heartbeat
    yield* Effect.forkScoped(
      Effect.repeat(conn.send({ type: "ping" }), HEARTBEAT)
    )

    // Start or reuse the kernel
    yield* Effect.tryPromise({
      try: () => kernelManager.getOrCreate(bubbleId, cwd),
      catch: (cause) =>
        new AppError({ message: "kernel getOrCreate failed", cause }),
    }).pipe(
      Effect.flatMap((instance) =>
        instance.errorMessage
          ? conn.send({
              type: "kernel_error",
              message: instance.errorMessage,
            })
          : conn.send({ type: "ready" })
      ),
      Effect.catchAll((e) =>
        conn.send({
          type: "kernel_error",
          message: e instanceof AppError ? e.message : String(e),
        })
      )
    )

    // Subscribe to the output stream
    const kernelStream: Stream.Stream<KernelMsg, never, Scope.Scope> =
      Stream.unwrapScoped(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<KernelMsg>()
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              kernelManager.addOutputListener(bubbleId, (msg) => {
                Effect.runFork(Queue.offer(queue, msg as KernelMsg))
              })
            ),
            (unsub) => Effect.sync(unsub)
          )
          return Stream.fromQueue(queue)
        })
      )

    yield* Effect.forkScoped(
      kernelStream.pipe(
        Stream.mapEffect((msg) => {
          if (msg.msg_type === "kernel_error") {
            return conn.send({
              type: "kernel_error",
              message: msg.content.message as string,
            })
          }
          if (msg.msg_type === "kernel_died") {
            return conn.send({
              type: "kernel_died",
              exit_code: msg.content.exit_code,
            })
          }
          if (msg.msg_type === "status") {
            return conn.send({
              type: "status",
              execution_state: msg.content.execution_state,
            })
          }
          return conn.send({
            type: "output",
            msg_id: msg.msg_id,
            msg_type: msg.msg_type,
            content: msg.content,
          })
        }),
        Stream.runDrain
      )
    )

    // Main message loop: execute / interrupt
    yield* conn.messages.pipe(
      Stream.mapEffect((raw) => {
        const msg = raw as Record<string, unknown>
        const type = msg.type as string | undefined
        if (type === "execute") {
          const msgId = msg.msg_id as string
          const code = msg.code as string
          return Effect.tryPromise({
            try: () => kernelManager.execute(bubbleId, code, msgId, cwd),
            catch: (cause) =>
              new AppError({ message: "kernel execute failed", cause }),
          }).pipe(
            Effect.catchAll((e) =>
              conn.send({
                type: "kernel_error",
                message: e instanceof AppError ? e.message : String(e),
              })
            )
          )
        }
        if (type === "interrupt") {
          return Effect.tryPromise({
            try: () => kernelManager.interrupt(bubbleId),
            catch: (cause) =>
              new AppError({ message: "kernel interrupt failed", cause }),
          }).pipe(Effect.catchAll(() => Effect.void))
        }
        return Effect.void
      }),
      Stream.runDrain
    )
  }).pipe(
    Effect.withSpan("ws.handleJupyter", { attributes: { bubbleId, cwd } })
  )

// Bridge
export const runJupyterHandler = (
  ws: WebSocket,
  bubbleId: string,
  cwd: string
): void => {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const conn = yield* fromWebSocket(ws, "jupyter")
      yield* handleJupyter(conn, bubbleId, cwd)
    })
  ).pipe(
    Effect.catchTag("ValidationError", (e) =>
      Effect.sync(() => ws.close(4400, e.reason))
    ),
    Effect.catchAll((e) =>
      Effect.logError("[ws/jupyter]").pipe(
        Effect.annotateLogs("error", JSON.stringify(e))
      )
    )
  )
  const fiber = Effect.runFork(program)
  ws.on("close", () => {
    Effect.runFork(fiber.interruptAsFork(fiber.id()))
  })
}
