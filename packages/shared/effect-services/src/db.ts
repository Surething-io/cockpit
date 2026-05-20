/**
 * DB Services — unified interface for 5 databases
 *
 * Design notes:
 * - The `id` parameter aligns with Cockpit DB bubble isolation semantics: the
 *   same connStr in different bubbles uses an independent pool (disconnect
 *   only closes that bubble's own pool, leaving other bubbles untouched).
 * - Live implementations live in packages/feature/console/src/effect/
 */
import { Context, Effect, Stream, type Scope } from "effect"
import type { DBError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// Shared Row type
// ─────────────────────────────────────────────────────────

export type Row = Record<string, unknown>

// ─────────────────────────────────────────────────────────
// Postgres
// ─────────────────────────────────────────────────────────

export interface PgTx {
  readonly query: <A extends Row = Row>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, DBError>
}

/**
 * Full query result (rows + metadata) — used by the SQL browser UI to display
 * fields / rowCount / command / duration. For ordinary queries, use
 * PgService.query.
 */
export interface PgQueryResult<A extends Row = Row> {
  /** SELECT row set; empty array for DML/DDL. */
  readonly rows: ReadonlyArray<A>
  /** Provided only for SELECT; null for DML/DDL. */
  readonly fields: ReadonlyArray<{ name: string; dataTypeID: number }> | null
  /** Matched rows (SELECT) or affected rows (DML); null for DDL. */
  readonly rowCount: number | null
  /** DML/DDL command string (INSERT/UPDATE/DELETE/CREATE/...); null for SELECT. */
  readonly command: string | null
  /** Server round-trip duration in milliseconds (2 decimal places). */
  readonly duration: number
}

export interface PgService {
  readonly query: <A extends Row = Row>(
    id: string,
    connStr: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, DBError>

  /** Query with metadata (used by the SQL browser). */
  readonly queryWithMeta: <A extends Row = Row>(
    id: string,
    connStr: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<PgQueryResult<A>, DBError>

  readonly stream: <A extends Row = Row>(
    id: string,
    connStr: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Stream.Stream<A, DBError>

  readonly withTx: <A, E>(
    id: string,
    connStr: string,
    f: (tx: PgTx) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | DBError>

  readonly disconnect: (id: string) => Effect.Effect<void>
}

export const PgService = Context.GenericTag<PgService>("@cockpit/PgService")

// ─────────────────────────────────────────────────────────
// MySQL
// ─────────────────────────────────────────────────────────

export interface MySQLTx {
  readonly query: <A extends Row = Row>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, DBError>
}

/**
 * Full MySQL query result (rows + metadata). SELECT and DML/DDL share the
 * same union shape:
 *  - SELECT: fields/rows are populated; command is null.
 *  - DML/DDL: command/rowCount (affectedRows) are populated; fields/rows are
 *    null/empty.
 */
export interface MySQLQueryResult<A extends Row = Row> {
  readonly rows: ReadonlyArray<A>
  readonly fields: ReadonlyArray<{ name: string; dataTypeID: number }> | null
  readonly rowCount: number
  readonly command: string | null
  readonly duration: number
}

export interface MySQLService {
  readonly query: <A extends Row = Row>(
    id: string,
    connStr: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<ReadonlyArray<A>, DBError>

  /** Query with metadata (used by the SQL browser). */
  readonly queryWithMeta: <A extends Row = Row>(
    id: string,
    connStr: string,
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Effect.Effect<MySQLQueryResult<A>, DBError>

  readonly withTx: <A, E>(
    id: string,
    connStr: string,
    f: (tx: MySQLTx) => Effect.Effect<A, E>
  ) => Effect.Effect<A, E | DBError>

  readonly disconnect: (id: string) => Effect.Effect<void>
}

export const MySQLService = Context.GenericTag<MySQLService>("@cockpit/MySQLService")

// ─────────────────────────────────────────────────────────
// Redis
// ─────────────────────────────────────────────────────────

export interface RedisService {
  readonly command: (
    id: string,
    connStr: string,
    cmd: string,
    args?: ReadonlyArray<unknown>
  ) => Effect.Effect<unknown, DBError>

  readonly subscribe: (
    id: string,
    connStr: string,
    pattern: string
  ) => Stream.Stream<{ channel: string; message: string }, DBError, Scope.Scope>

  readonly disconnect: (id: string) => Effect.Effect<void>
}

export const RedisService = Context.GenericTag<RedisService>("@cockpit/RedisService")

// ─────────────────────────────────────────────────────────
// Neo4j
// ─────────────────────────────────────────────────────────

/**
 * Neo4j query result (records + keys + duration + counters) — full query
 * metadata for the UI.
 */
export interface Neo4jQueryResult<A extends Row = Row> {
  readonly records: ReadonlyArray<A>
  readonly keys: ReadonlyArray<string>
  readonly duration: number
  readonly counters: unknown
}

export interface Neo4jService {
  readonly run: <A extends Row = Row>(
    id: string,
    connStr: string,
    cypher: string,
    params?: Row
  ) => Effect.Effect<ReadonlyArray<A>, DBError>

  /** Query with metadata (used by the query console). */
  readonly runWithMeta: <A extends Row = Row>(
    id: string,
    connStr: string,
    cypher: string,
    params?: Row
  ) => Effect.Effect<Neo4jQueryResult<A>, DBError>

  readonly disconnect: (id: string) => Effect.Effect<void>
}

export const Neo4jService = Context.GenericTag<Neo4jService>("@cockpit/Neo4jService")

// ─────────────────────────────────────────────────────────
// MongoDB
// ─────────────────────────────────────────────────────────

export interface MongoService {
  readonly find: <A extends Row = Row>(
    id: string,
    connStr: string,
    db: string,
    collection: string,
    filter?: Row
  ) => Effect.Effect<ReadonlyArray<A>, DBError>

  readonly command: (
    id: string,
    connStr: string,
    db: string,
    cmd: Row
  ) => Effect.Effect<Row, DBError>

  readonly disconnect: (id: string) => Effect.Effect<void>
}

export const MongoService = Context.GenericTag<MongoService>("@cockpit/MongoService")
