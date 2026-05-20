/**
 * WSRegistry — WebSocket protocol registration + Fiber management.
 *
 * Replaces the 7 hand-written heartbeat/cleanup handlers currently in
 * src/lib/wsServer.ts.
 */
import { Context, Effect, Stream, Scope } from "effect"
import type { WSError, WSProto } from "@cockpit/effect-core"

/** Bidirectional abstraction over a single WS connection. */
export interface WSConnection {
  readonly send: (msg: unknown) => Effect.Effect<void, WSError>
  readonly messages: Stream.Stream<unknown, WSError>
  /** Active close (for tests / graceful shutdown). */
  readonly close: Effect.Effect<void>
}

/** WS protocol handler signature. */
export type WSHandler = (
  conn: WSConnection,
  query: Record<string, string | undefined>
) => Effect.Effect<void, WSError, Scope.Scope>

export interface WSRegistry {
  /** Register a handler for a given protocol. */
  readonly register: (
    proto: WSProto,
    handler: WSHandler
  ) => Effect.Effect<void>

  /** Accept an upgrade and automatically fork a fiber + scope. */
  readonly accept: (
    proto: WSProto,
    conn: WSConnection,
    query: Record<string, string | undefined>
  ) => Effect.Effect<void, WSError, Scope.Scope>

  /** Broadcast to all connections on a protocol. */
  readonly broadcast: (
    proto: WSProto,
    msg: unknown
  ) => Effect.Effect<void>
}

export const WSRegistry = Context.GenericTag<WSRegistry>("@cockpit/WSRegistry")
