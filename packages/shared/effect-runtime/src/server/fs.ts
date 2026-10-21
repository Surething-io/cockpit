/**
 * Server-only filesystem primitives shared by Live implementations and handlers.
 *
 * Kept free of AppRuntime / feature imports (its own `./server/fs` subpath) so a
 * feature Live can use it without importing the runtime that composes it.
 */
import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect } from "effect"
import { FSError } from "@cockpit/effect-core"

/**
 * Parse a JSON file, or return `fallback` when it is missing, unreadable, not JSON,
 * or rejected by `guard`. The parse runs inside `Effect.try`: a bare JSON.parse in an
 * `Effect.map` callback throws a defect, which `orElseSucceed` never sees, so one
 * half-written file turned a whole listing into a 500.
 */
export const readJsonOr = <T>(
  file: string,
  fallback: T,
  guard: (value: unknown) => value is T = (_value: unknown): _value is T => true
): Effect.Effect<T, never> =>
  Effect.tryPromise({
    try: () => readFile(file, "utf8"),
    catch: (cause) => new FSError({ path: file, op: "read", cause }),
  }).pipe(
    Effect.flatMap((raw) => Effect.try(() => JSON.parse(raw) as unknown)),
    Effect.map((value) => (guard(value) ? value : fallback)),
    Effect.orElseSucceed(() => fallback)
  )

/** Guard for "a JSON object" — the shape every cockpit state file has at its root. */
export const isJsonObject = <T extends object>(value: unknown): value is T =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface AtomicWriteOps {
  readonly mkdir: (dir: string, opts: { recursive: true }) => Promise<unknown>
  readonly writeFile: (file: string, text: string) => Promise<void>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rm: (file: string, opts: { force: true }) => Promise<void>
}

// Owner-only by default: what goes through here (transcript index shards, the search
// corpus, codex heads) is derived from private transcripts. umask can only remove bits,
// so 0600 / 0700 survive any umask.
const nodeAtomicWriteOps: AtomicWriteOps = {
  mkdir: (dir, opts) => mkdir(dir, { ...opts, mode: 0o700 }),
  writeFile: (file, text) => writeFile(file, text, { mode: 0o600 }),
  rename,
  rm,
}

/**
 * Write via a sibling temp file + rename: a reader outside the lock sees the old or the
 * new file, never a truncated one. Files are created 0600 and directories 0700. The temp name ends in `.tmp`, outside rg's `*.txt` glob.
 *
 * Whatever fails between creating the temp file and the rename — a partial writeFile
 * (disk full, quota, EIO) or the rename itself — removes the temp file and rethrows the
 * ORIGINAL error; a failing cleanup never masks it. Otherwise every retrying sync would
 * leave another orphan that no manifest entry ever points at.
 */
export const writeAtomically = async (
  file: string,
  text: string,
  ops: AtomicWriteOps = nodeAtomicWriteOps
): Promise<void> => {
  await ops.mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await ops
    .writeFile(tmp, text)
    .then(() => ops.rename(tmp, file))
    .catch(async (err: unknown) => {
      await ops.rm(tmp, { force: true }).catch(() => undefined)
      throw err
    })
}
