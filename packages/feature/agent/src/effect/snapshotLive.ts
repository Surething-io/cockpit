/**
 * SnapshotServiceLive — shadow-git implementation of SnapshotService.
 *
 * Repo layout (one per project cwd):
 *   <cockpitDir>/snapshots/<sanitized-basename>-<sha256(cwd)[0:12]>/
 *     ├── HEAD / objects / refs / info/exclude   ← a plain GIT_DIR
 *     └── meta.json                              ← { cwd, createdAt, lastSnapshotAt }
 *
 * Every git command runs with GIT_DIR=<repo> GIT_WORK_TREE=<cwd>, so the
 * project's own .git is never touched and the project's .gitignore is
 * honored by `git add -A`.
 *
 * History shape: one branch per local day (`snap/YYYY-MM-DD`). The first
 * commit of a day is a parentless root — either a full-tree baseline (first
 * ever) or a rollover root reusing the previous day tip's tree via
 * `git commit-tree` (no parent). Day chains are therefore independent, so
 * retention is "delete branch + `git gc --prune=now`" with immediate object
 * reclaim (reflogs are disabled at init).
 *
 * Concurrency: commits are serialized per repo with a Semaphore. The
 * semaphore map is pinned to globalThis (same rationale as sessionRunHub —
 * a second Next.js module realm must not create a parallel serializer);
 * git's own index.lock is the last-resort guard.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, readdir, rm, stat, rename } from "node:fs/promises"
import { basename, join, isAbsolute, relative, sep } from "node:path"
import { Effect, Layer, Schedule } from "effect"
import { AppError, ValidationError, NotFoundError, CockpitConfig } from "@cockpit/effect-core"
import {
  SnapshotService,
  type SnapshotTrigger,
  type SnapshotCommit,
  type SnapshotDiff,
  type SnapshotFileDiff,
  type SnapshotRecordResult,
} from "@cockpit/effect-services"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

/** Belt-and-braces excludes for projects without a .gitignore. */
const BUILTIN_EXCLUDES = [
  ".git/",
  "node_modules/",
  ".next/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  ".turbo/",
  ".cache/",
  "__pycache__/",
  ".venv/",
  "venv/",
  "target/",
  "*.log",
  ".DS_Store",
  // Common secrets — must never be copied into the shadow repo, even for
  // projects without a .gitignore (snapshots live outside the project dir
  // and are retained for up to 30 days).
  ".env",
  ".env.*",
  "*.pem",
  "*.p12",
  "id_rsa*",
  "id_ed25519*",
]

/**
 * Runaway guards. `status -uall` lists every changed FILE (untracked dirs are
 * expanded, so the per-file size cap sees files inside new directories too).
 * More files than MAX_CHANGED_FILES, or more non-oversize bytes than
 * MAX_TOTAL_BYTES, → the snapshot is skipped with a warning. Source repos
 * rarely exceed 50k files; the byte guard covers the "thousands of mid-size
 * files" case (photos/datasets) that the per-file cap can't catch.
 */
const MAX_CHANGED_FILES = 50_000
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GB

/**
 * After a runaway guard trips, snapshotting for that repo is suspended for
 * this long (recorded in meta.json). Without it, every tool_result re-pays
 * the full-tree `status -uall` scan just to hit the same guard again.
 */
const GUARD_BACKOFF_MS = 6 * 3600 * 1000

/** Per-side content cap returned by diff (bytes). */
const MAX_DIFF_CONTENT_BYTES = 500 * 1024

/** Max files materialized in one diff response. */
const MAX_DIFF_FILES = 200

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

// ─────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────

const sanitizeName = (name: string): string =>
  (name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "project")

export const snapshotRepoDirName = (cwd: string, full = false): string => {
  const hex = createHash("sha256").update(cwd, "utf8").digest("hex")
  return `${sanitizeName(basename(cwd))}-${full ? hex : hex.slice(0, 12)}`
}

const localDay = (d: Date): string => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/**
 * Absolute path → repo-relative, with POSIX separators.
 *
 * The result is compared against git's own diff paths (always "/"-separated),
 * so on Windows `relative()`'s backslashes must be normalized or every
 * declared file looks foreign to the diff viewer's attribution check.
 */
const toRelative = (cwd: string, p: string): string => {
  if (!isAbsolute(p)) return p
  const rel = relative(cwd, p)
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : p
}

interface Meta {
  cwd: string
  createdAt: number
  lastSnapshotAt: number
  /** Set when a runaway guard trips; snapshotting is suspended until it ages out. */
  guardTrippedAt?: number
}

/** Parse `Cockpit-*` trailers out of a raw commit body. */
const parseTrailers = (body: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of body.split("\n")) {
    const m = /^Cockpit-([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const commitFromLogRecord = (record: string): SnapshotCommit | null => {
  // record: <hash>\x1f<parents>\x1f<committer-ts>\x1f<raw body>
  const [hash, parents, ts, ...bodyParts] = record.split("\x1f")
  if (!hash) return null
  const body = bodyParts.join("\x1f")
  const trailers = parseTrailers(body)
  // Tool-Files is a JSON array on a single trailer line; malformed → empty list.
  let toolFiles: string[] = []
  if (trailers["Tool-Files"]) {
    try {
      const parsed: unknown = JSON.parse(trailers["Tool-Files"])
      if (Array.isArray(parsed)) toolFiles = parsed.filter((x): x is string => typeof x === "string")
    } catch {
      toolFiles = []
    }
  }
  return {
    hash,
    parent: parents ? parents.split(" ")[0] : null,
    timestamp: Number(ts) || 0,
    subject: body.split("\n")[0] ?? "",
    sessionKey: trailers["Session"] ?? null,
    toolId: trailers["Tool-Id"] ?? null,
    toolName: trailers["Tool"] ?? null,
    toolFiles,
    provider: trailers["Provider"] ?? null,
    baseline: trailers["Kind"] === "baseline",
  }
}

// ─────────────────────────────────────────────────────────
// git runner (Effect-wrapped execFile)
// ─────────────────────────────────────────────────────────

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

const runGit = (
  repoDir: string,
  workTree: string | null,
  args: ReadonlyArray<string>,
  /** Written to the child's stdin then closed (e.g. --pathspec-from-file=-). */
  input?: string
): Effect.Effect<GitResult, AppError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<GitResult>((resolve) => {
        const child = execFile(
          "git",
          args as string[],
          {
            env: {
              ...process.env,
              GIT_DIR: repoDir,
              ...(workTree ? { GIT_WORK_TREE: workTree } : {}),
              GIT_TERMINAL_PROMPT: "0",
              // Error-message matching ("nothing to commit") relies on English output.
              LC_ALL: "C",
              // The shadow repo must not inherit the user's global index tweaks.
              GIT_INDEX_FILE: join(repoDir, "index"),
            },
            cwd: workTree ?? repoDir,
            maxBuffer: 64 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            // error.code: number exit code on non-zero exit, string (e.g. ENOENT) on spawn failure.
            const raw = (error as { code?: number | string } | null)?.code
            const code = error ? (typeof raw === "number" ? raw : 1) : 0
            resolve({ code, stdout: String(stdout), stderr: String(stderr) })
          }
        )
        if (input !== undefined) child.stdin?.end(input)
      }),
    catch: (cause) => new AppError({ message: `git ${args[0]} spawn failed`, cause }),
  })

/** runGit that fails the Effect on a non-zero exit. */
const runGitOk = (
  repoDir: string,
  workTree: string | null,
  args: ReadonlyArray<string>,
  input?: string
): Effect.Effect<GitResult, AppError> =>
  runGit(repoDir, workTree, args, input).pipe(
    Effect.filterOrFail(
      (r) => r.code === 0,
      (r) =>
        new AppError({
          message: `git ${args.join(" ")} exited ${r.code}: ${r.stderr.slice(0, 400)}`,
        })
    )
  )

/**
 * git's refusal to touch a literal pathspec whose leading component resolves
 * through a symbolic link. `status` classifies a symlink-shadowed tracked file
 * as a worktree-side delete, so it is routed to `rm --cached` upstream; this
 * matcher only backstops XY combinations that routing did not catch.
 *
 * Relies on `runGit` forcing LC_ALL=C (git i18n off → stable English stderr) —
 * the same contract the "nothing to commit" match depends on. If it ever fails
 * to match, the `add` simply fails and the snapshot degrades to a warning
 * rather than mis-recording, so this stays a best-effort backstop, not a
 * correctness dependency.
 */
const SYMLINK_PATHSPEC_RE = /beyond a symbolic link/

/**
 * `git add` a set of literal pathspecs in one batch. If git aborts the batch
 * with "beyond a symbolic link" — a path whose leading component became a
 * symlink after `status` classified it as add-able — the batch stages nothing,
 * so fall back to per-file: add each path, and convert any offender to an
 * index-only `rm --cached` deletion (the same reconciliation the D-routing
 * performs). Any other git failure propagates so the outer retry can react.
 */
const stageAdds = (
  repoDir: string,
  cwd: string,
  paths: ReadonlyArray<string>
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    // `--force`: the add set is exactly what `git status` already selected, so
    // git must not second-guess it with ignore rules. status(-uall) excludes
    // UNTRACKED ignored files, so the only ignored paths that can reach here are
    // TRACKED files living under a gitignored dir (e.g. a tracked file under an
    // ignored `data/`). Without -f, `git add` fatals the WHOLE batch on such a
    // path ("paths are ignored, use -f") and the snapshot is lost forever. -f
    // touches only these explicitly-enumerated, size-capped pathspecs — it can
    // never sweep in untracked ignored junk, which was never in the list.
    const addArgs = ["add", "-A", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"]
    const batch = yield* runGit(repoDir, cwd, addArgs, paths.map((p) => `:(literal)${p}`).join("\0"))
    if (batch.code === 0) return
    if (!SYMLINK_PATHSPEC_RE.test(batch.stderr)) {
      return yield* Effect.fail(
        new AppError({ message: `git add exited ${batch.code}: ${batch.stderr.slice(0, 400)}` })
      )
    }
    for (const p of paths) {
      const one = yield* runGit(repoDir, cwd, addArgs, `:(literal)${p}`)
      if (one.code === 0) continue
      if (!SYMLINK_PATHSPEC_RE.test(one.stderr)) {
        return yield* Effect.fail(
          new AppError({ message: `git add ${p} exited ${one.code}: ${one.stderr.slice(0, 400)}` })
        )
      }
      // Symlink-shadowed tracked file → record its removal; --ignore-unmatch
      // no-ops if it is not in the index.
      yield* runGitOk(repoDir, cwd, ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", `:(literal)${p}`])
    }
  })

// ─────────────────────────────────────────────────────────
// Per-repo serialization — semaphore map pinned to globalThis
// ─────────────────────────────────────────────────────────

const gSem = globalThis as unknown as {
  __cockpitSnapshotSemaphores?: Map<string, Effect.Semaphore>
}
const semaphores: Map<string, Effect.Semaphore> =
  gSem.__cockpitSnapshotSemaphores ?? (gSem.__cockpitSnapshotSemaphores = new Map())

const withRepoLock = <A, E>(
  repoDir: string,
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E> => {
  let sem = semaphores.get(repoDir)
  if (!sem) {
    sem = Effect.unsafeMakeSemaphore(1)
    semaphores.set(repoDir, sem)
  }
  return sem.withPermits(1)(effect)
}

// ─────────────────────────────────────────────────────────
// Repo bootstrap
// ─────────────────────────────────────────────────────────

const fsTry = <A>(op: string, fn: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) => new AppError({ message: `snapshot fs ${op} failed`, cause }),
  })

/**
 * "missing" (no meta.json — legacy or mid-init) and "corrupt" (file exists
 * but unparsable — e.g. a torn write) are DIFFERENT inputs: cleanup must
 * never treat a corrupt meta as a license to delete the whole history.
 */
interface MetaState {
  state: "ok" | "missing" | "corrupt"
  meta: Meta | null
}

const readMetaState = (repoDir: string): Effect.Effect<MetaState, never> =>
  Effect.tryPromise({
    try: async (): Promise<MetaState> => {
      let raw: string
      try {
        raw = await readFile(join(repoDir, "meta.json"), "utf8")
      } catch {
        return { state: "missing", meta: null }
      }
      try {
        return { state: "ok", meta: JSON.parse(raw) as Meta }
      } catch {
        return { state: "corrupt", meta: null }
      }
    },
    catch: () => new AppError({ message: "unreachable" }),
  }).pipe(Effect.orElseSucceed((): MetaState => ({ state: "missing", meta: null })))

const readMeta = (repoDir: string): Effect.Effect<Meta | null, never> =>
  readMetaState(repoDir).pipe(Effect.map((s) => s.meta))

/** Atomic write (tmp + rename) — a torn meta.json must never appear on disk. */
const writeMeta = (repoDir: string, meta: Meta): Effect.Effect<void, AppError> =>
  fsTry("write meta", async () => {
    const tmp = join(repoDir, "meta.json.tmp")
    await writeFile(tmp, JSON.stringify(meta, null, 2), "utf8")
    await rename(tmp, join(repoDir, "meta.json"))
  })

// ─────────────────────────────────────────────────────────
// Pending tool-record counter (baseline yields to queued records)
//
// A run-start baseline racing a tool record for the SAME cwd could grab the
// repo lock first and sweep the tool's on-disk changes into a baseline commit
// (no Tool-Id → that tool's diff is lost forever). The hook increments this
// counter SYNCHRONOUSLY at tool_result time (before forking the record), and
// a baseline that sees a pending record simply skips itself — the record's
// commit will absorb any external changes instead. Pinned to globalThis for
// the same dual-realm reason as the semaphore map.
// ─────────────────────────────────────────────────────────

const gPending = globalThis as unknown as {
  __cockpitSnapshotPendingRecords?: Map<string, number>
}
const pendingRecords: Map<string, number> =
  gPending.__cockpitSnapshotPendingRecords ?? (gPending.__cockpitSnapshotPendingRecords = new Map())

/** Called by the event hook, synchronously, before forking a tool record. */
export const notePendingRecord = (cwd: string): void => {
  pendingRecords.set(cwd, (pendingRecords.get(cwd) ?? 0) + 1)
}

/** Called when the forked record settles (success, failure, or interrupt). */
export const settlePendingRecord = (cwd: string): void => {
  const n = (pendingRecords.get(cwd) ?? 1) - 1
  if (n <= 0) pendingRecords.delete(cwd)
  else pendingRecords.set(cwd, n)
}

const pendingRecordCount = (cwd: string): number => pendingRecords.get(cwd) ?? 0

/**
 * Resolve the repo dir for a cwd, detecting 12-hex-prefix hash collisions via
 * meta.json: if the short-name repo belongs to a DIFFERENT cwd, fall back to
 * the full-hash name (collision odds are ~2^-48 per pair — this is a
 * correctness guard against ever mixing two projects' histories, not a path
 * we expect to take).
 */
const resolveRepoDir = (
  snapshotsRoot: string,
  cwd: string
): Effect.Effect<string, never> =>
  Effect.gen(function* () {
    const short = join(snapshotsRoot, snapshotRepoDirName(cwd))
    const meta = yield* readMeta(short)
    if (meta && meta.cwd !== cwd) {
      yield* Effect.logWarning(
        `snapshot repo hash collision: ${short} belongs to ${meta.cwd}; using full-hash dir for ${cwd}`
      )
      return join(snapshotsRoot, snapshotRepoDirName(cwd, true))
    }
    return short
  })

/**
 * Idempotent init: bare-layout GIT_DIR + non-bare flag + excludes + meta.
 * MUST be called while holding the repo lock — two concurrent first-time
 * inits would collide on config.lock and lose a snapshot.
 */
const ensureRepo = (
  repoDir: string,
  cwd: string
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const headExists = yield* fsTry("stat HEAD", () =>
      stat(join(repoDir, "HEAD")).then(() => true)
    ).pipe(Effect.orElseSucceed(() => false))
    if (headExists) return

    yield* fsTry("mkdir", () => mkdir(repoDir, { recursive: true }))
    yield* runGitOk(repoDir, null, ["init", "--quiet", "--bare", repoDir])
    // Shadow-repo config: work-tree mode, no reflogs (delete branch → objects
    // immediately unreachable), no auto-gc (cleanup owns gc), fixed identity.
    const configs: ReadonlyArray<[string, string]> = [
      ["core.bare", "false"],
      ["core.logAllRefUpdates", "false"],
      ["gc.auto", "0"],
      ["user.name", "cockpit-snapshot"],
      ["user.email", "snapshot@cockpit.local"],
      ["commit.gpgsign", "false"],
    ]
    for (const [k, v] of configs) {
      yield* runGitOk(repoDir, null, ["config", k, v])
    }
    yield* fsTry("write exclude", () =>
      writeFile(join(repoDir, "info", "exclude"), BUILTIN_EXCLUDES.join("\n") + "\n", "utf8")
    )
    const now = Date.now()
    yield* writeMeta(repoDir, { cwd, createdAt: now, lastSnapshotAt: now })
  })

// ─────────────────────────────────────────────────────────
// Snapshot core (runs under the repo lock)
// ─────────────────────────────────────────────────────────

/**
 * Point HEAD at today's branch, creating it if missing. A missing branch is
 * created as a parentless root reusing the latest previous day tip's tree
 * (rollover) — or left unborn when the repo has no history yet (the next
 * commit then becomes the full-tree root).
 */
const ensureDayBranch = (
  repoDir: string,
  cwd: string,
  day: string
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const branch = `refs/heads/snap/${day}`
    const exists = yield* runGit(repoDir, cwd, ["rev-parse", "--quiet", "--verify", branch])
    if (exists.code !== 0) {
      const branches = yield* runGitOk(repoDir, cwd, [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname:short)",
        "refs/heads/snap/",
      ])
      const latest = branches.stdout.trim().split("\n").filter(Boolean).pop()
      if (latest) {
        // Day rollover: new parentless root sharing the previous tip's tree,
        // so per-day chains stay GC-independent while diffs stay incremental.
        const root = yield* runGitOk(repoDir, cwd, [
          "commit-tree",
          `${latest}^{tree}`,
          "-m",
          `baseline (rollover from ${latest})\n\nCockpit-Kind: baseline`,
        ])
        yield* runGitOk(repoDir, cwd, ["branch", `snap/${day}`, root.stdout.trim()])
      }
    }
    yield* runGitOk(repoDir, cwd, ["symbolic-ref", "HEAD", branch])
  })

/** One display-safe subject line: control chars stripped, whitespace
 *  collapsed, capped — also blocks newline-based trailer injection via
 *  tool input (file names / descriptions are external input). */
const sanitizeSubject = (s: string): string =>
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)

const buildCommitMessage = (trigger: SnapshotTrigger, relFiles: string[], kind: "tool" | "baseline"): string => {
  // Subject detail: declared files when present; otherwise the tool's
  // human-readable detail (Bash/Task description, or the raw command).
  const detail =
    relFiles.length > 0
      ? relFiles.length === 1
        ? relFiles[0]
        : `${relFiles[0]} +${relFiles.length - 1}`
      : (trigger.toolDetail ?? "")
  const subject =
    kind === "baseline"
      ? "baseline"
      : sanitizeSubject(`[${trigger.toolName ?? "tool"}] ${detail}`)
  const trailers = [
    `Cockpit-Kind: ${kind}`,
    `Cockpit-Session: ${trigger.sessionKey}`,
    `Cockpit-Provider: ${trigger.provider}`,
    ...(trigger.toolId ? [`Cockpit-Tool-Id: ${trigger.toolId}`] : []),
    ...(trigger.toolName ? [`Cockpit-Tool: ${trigger.toolName}`] : []),
    ...(relFiles.length ? [`Cockpit-Tool-Files: ${JSON.stringify(relFiles)}`] : []),
  ]
  return `${subject}\n\n${trailers.join("\n")}`
}

const snapshotOnce = (
  snapshotsRoot: string,
  maxFileBytes: number,
  trigger: SnapshotTrigger,
  kind: "tool" | "baseline"
): Effect.Effect<SnapshotRecordResult, AppError> =>
  Effect.gen(function* () {
    const cwd = trigger.cwd
    const repoDir = yield* resolveRepoDir(snapshotsRoot, cwd)
    const skip = { committed: false } satisfies SnapshotRecordResult

    // Cheap pre-lock check; the authoritative one is repeated under the lock.
    if (kind === "baseline" && pendingRecordCount(cwd) > 0) return skip

    // Trip a runaway guard: remember it in meta so subsequent tool_results
    // short-circuit instead of re-paying the full-tree scan every time.
    const tripGuard = (reason: string): Effect.Effect<SnapshotRecordResult, AppError> =>
      Effect.gen(function* () {
        yield* Effect.logWarning(`snapshot suspended for ${GUARD_BACKOFF_MS / 3600000}h: ${reason} — check .gitignore of ${cwd}`)
        const meta = yield* readMeta(repoDir)
        yield* writeMeta(repoDir, {
          cwd,
          createdAt: meta?.createdAt ?? Date.now(),
          lastSnapshotAt: meta?.lastSnapshotAt ?? Date.now(),
          guardTrippedAt: Date.now(),
        })
        return skip
      })

    // Stage exactly what `status` listed, as LITERAL pathspecs, split by the
    // worktree status column so beyond-symlink paths never reach `git add`:
    //   • worktree column 'D' (tracked file with no readable worktree copy —
    //     a plain delete, OR a file whose parent dir just became a symlink) →
    //     `git rm --cached`. Feeding such a path to `git add` fails with
    //     "beyond a symbolic link" and aborts the WHOLE batch, staging nothing.
    //   • everything else → `git add`, size-capped.
    // This is also the single point upholding "everything committed passed the
    // size guards": `add -A -- .` would rescan the tree and sweep in files that
    // appeared AFTER the status/stat pass (bypassing the caps), and `:(exclude)`
    // treats []*? as glob magic. Retried once as a whole: a file vanishing
    // between status and add (concurrent session / build) fails the add — the
    // retry recomputes status so the vanished path drops out of the list.
    const stageOnce: Effect.Effect<
      { staged: false } | { staged: true },
      AppError
    > = Effect.gen(function* () {
      // Reconcile the persistent index to HEAD before scanning. A prior run
      // that mutated the index (`rm --cached` / `add`) but failed before
      // committing leaves the index desynced from HEAD. That stale state makes
      // an already-removed path surface as a staged deletion ("D " — index
      // column D, worktree column blank), which the D-routing below would
      // otherwise mis-send to `git add`, aborting every future batch and never
      // self-healing. `read-tree` only rewrites the index, never the worktree.
      // Guarded on an existing HEAD so a repo with no commits (unborn branch)
      // is left untouched. Re-runs on retry, so each attempt stages from clean.
      const headOk = yield* runGit(repoDir, cwd, ["rev-parse", "--quiet", "--verify", "HEAD"])
      if (headOk.code === 0) {
        yield* runGitOk(repoDir, cwd, ["read-tree", "HEAD"])
      }
      const status = yield* runGitOk(repoDir, cwd, [
        "status", "--porcelain", "-z", "-uall", "--no-renames",
      ])
      const entries = status.stdout.split("\0").filter(Boolean)
      if (entries.length === 0) return { staged: false as const }
      if (entries.length > MAX_CHANGED_FILES) {
        yield* tripGuard(`${entries.length} changed files exceeds ${MAX_CHANGED_FILES}`)
        return { staged: false as const }
      }

      // XY = entry[0..1], path = entry[3..] (single space separator; renames
      // are off, so an entry never carries a second NUL-joined path).
      const addPaths: string[] = []
      const rmPaths: string[] = []
      for (const e of entries) {
        const path = e.slice(3)
        if (!path) continue
        // A deletion in EITHER porcelain column must go to `rm --cached`, never
        // `git add`: worktree column 'D' (` D`, a plain/symlink-shadowed delete)
        // AND index column 'D' (`D `, a staged-but-uncommitted removal, e.g. a
        // reconcile hole from an interrupted run). Both have no readable worktree
        // copy, so `git add` would fatal the whole batch with "pathspec did not
        // match any files".
        if (e[0] === "D" || e[1] === "D") rmPaths.push(path)
        else addPaths.push(path)
      }

      // Size caps apply only to the add set. Deletions cost 0 bytes and are
      // always kept; measuring them here would be wrong anyway, since `stat`
      // follows symlinks and would resolve a symlink-shadowed path to its live
      // target (the very mismatch that made `git add` blow up before).
      const sizes = yield* Effect.all(
        addPaths.map((p) =>
          fsTry("stat", () => stat(join(cwd, p)).then((s) => (s.isFile() ? s.size : 0))).pipe(
            // Path gone between status and stat (concurrent session/build) or
            // unreadable → -1, excluded below so a vanished path never reaches
            // `git add`, which would abort the whole batch with "pathspec did
            // not match any files".
            Effect.orElseSucceed(() => -1)
          )
        ),
        { concurrency: 16 }
      )
      const includedAdds: string[] = []
      let totalBytes = 0
      for (let i = 0; i < addPaths.length; i++) {
        if (sizes[i] < 0) continue // vanished / unreadable → not addable
        if (sizes[i] > maxFileBytes) continue // oversize → excluded
        includedAdds.push(addPaths[i])
        totalBytes += sizes[i]
      }
      if (totalBytes > MAX_TOTAL_BYTES) {
        yield* tripGuard(`${Math.round(totalBytes / 1048576)}MB of changes exceeds ${Math.round(MAX_TOTAL_BYTES / 1048576)}MB`)
        return { staged: false as const }
      }
      // Nothing left to record (e.g. every change was an oversize untracked
      // file that keeps reappearing) → skip the add/commit.
      if (includedAdds.length === 0 && rmPaths.length === 0) return { staged: false as const }

      // Deletions first: `rm --cached` only touches the index, so it is immune
      // to the beyond-symlink check and clears any stale entry a following `add`
      // of a symlink at the same path would otherwise D/F-conflict with.
      if (rmPaths.length > 0) {
        yield* runGitOk(
          repoDir,
          cwd,
          ["rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
          rmPaths.map((p) => `:(literal)${p}`).join("\0")
        )
      }
      if (includedAdds.length > 0) {
        yield* stageAdds(repoDir, cwd, includedAdds)
      }
      return { staged: true as const }
    })

    return yield* withRepoLock(
      repoDir,
      Effect.gen(function* () {
        // Authoritative baseline-yield check (under the lock): a tool record
        // is pending for this cwd → let IT capture the tree; a baseline
        // grabbing the changes first would orphan that tool's diff forever.
        if (kind === "baseline" && pendingRecordCount(cwd) > 0) {
          return skip
        }

        yield* ensureRepo(repoDir, cwd)

        // Guard backoff: suspended repo → skip without scanning.
        const metaBefore = yield* readMeta(repoDir)
        if (
          metaBefore?.guardTrippedAt &&
          Date.now() - metaBefore.guardTrippedAt < GUARD_BACKOFF_MS
        ) {
          return skip
        }

        yield* ensureDayBranch(repoDir, cwd, localDay(new Date()))

        const stage = yield* stageOnce.pipe(Effect.retry({ times: 1 }))
        if (!stage.staged) return skip

        const relFiles = (trigger.toolFiles ?? []).map((f) => toRelative(cwd, f))
        const msg = buildCommitMessage(trigger, relFiles, kind)
        const commit = yield* runGit(repoDir, cwd, ["commit", "--quiet", "--no-verify", "-m", msg])
        if (commit.code !== 0) {
          // "nothing to commit" (staged set collapsed to no-op) is a valid skip.
          const benign = /nothing to commit|nothing added to commit/.test(commit.stdout + commit.stderr)
          if (!benign) {
            return yield* Effect.fail(
              new AppError({ message: `git commit failed: ${(commit.stderr || commit.stdout).slice(0, 400)}` })
            )
          }
          return skip
        }
        const head = yield* runGitOk(repoDir, cwd, ["rev-parse", "HEAD"])

        // Success clears any guard flag (guardTrippedAt omitted).
        const meta = yield* readMeta(repoDir)
        yield* writeMeta(repoDir, {
          cwd,
          createdAt: meta?.createdAt ?? Date.now(),
          lastSnapshotAt: Date.now(),
        })
        return { committed: true, hash: head.stdout.trim() } satisfies SnapshotRecordResult
      })
    )
  }).pipe(
    Effect.withSpan("snapshot.record", {
      attributes: { cwd: trigger.cwd, tool: trigger.toolName ?? kind },
    })
  )

// ─────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────

const listByToolIdsImpl = (
  snapshotsRoot: string,
  cwd: string,
  toolIds: ReadonlyArray<string>,
  sessionKey?: string
): Effect.Effect<ReadonlyArray<SnapshotCommit>, AppError> =>
  Effect.gen(function* () {
    if (toolIds.length === 0) return []
    const repoDir = yield* resolveRepoDir(snapshotsRoot, cwd)
    const headExists = yield* fsTry("stat HEAD", () =>
      stat(join(repoDir, "HEAD")).then(() => true)
    ).pipe(Effect.orElseSucceed(() => false))
    if (!headExists) return []

    // Bounded by retention (~7 days of branches), so --all is cheap.
    const log = yield* runGit(repoDir, cwd, [
      "log",
      "--all",
      "--date-order",
      "--reverse",
      "--format=%x1e%H%x1f%P%x1f%ct%x1f%B",
    ])
    if (log.code !== 0) return []
    const wanted = new Set(toolIds)
    return log.stdout
      .split("\x1e")
      .filter(Boolean)
      .map(commitFromLogRecord)
      .filter(
        (c): c is SnapshotCommit =>
          !!c &&
          !!c.toolId &&
          wanted.has(c.toolId) &&
          (!sessionKey || c.sessionKey === sessionKey)
      )
  }).pipe(Effect.withSpan("snapshot.listByToolIds", { attributes: { cwd } }))

const showFile = (
  repoDir: string,
  cwd: string,
  rev: string,
  path: string
): Effect.Effect<string | null, never> =>
  runGit(repoDir, cwd, ["show", `${rev}:${path}`]).pipe(
    Effect.map((r) => (r.code === 0 ? r.stdout : null)),
    Effect.orElseSucceed(() => null)
  )

const diffImpl = (
  snapshotsRoot: string,
  cwd: string,
  commitHash: string
): Effect.Effect<SnapshotDiff, AppError | ValidationError | NotFoundError> =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{6,40}$/i.test(commitHash)) {
      return yield* Effect.fail(new ValidationError({ field: "commit", reason: "invalid commit hash" }))
    }
    const repoDir = yield* resolveRepoDir(snapshotsRoot, cwd)
    const repoExists = yield* fsTry("stat HEAD", () =>
      stat(join(repoDir, "HEAD")).then(() => true)
    ).pipe(Effect.orElseSucceed(() => false))
    if (!repoExists) {
      return yield* Effect.fail(new NotFoundError({ resource: "snapshot-repo", id: cwd }))
    }

    const log = yield* runGitOk(repoDir, cwd, [
      "log",
      "-1",
      "--format=%x1e%H%x1f%P%x1f%ct%x1f%B",
      commitHash,
    ])
    const commit = commitFromLogRecord(log.stdout.split("\x1e").filter(Boolean)[0] ?? "")
    if (!commit) {
      return yield* Effect.fail(new ValidationError({ field: "commit", reason: "commit not found" }))
    }
    const base = commit.parent ?? EMPTY_TREE

    // name-status + numstat in one pass each; numstat flags binaries ("-").
    const nameStatus = yield* runGitOk(repoDir, cwd, [
      "diff-tree", "-r", "-z", "--no-renames", "--name-status", base, commit.hash,
    ])
    const numstat = yield* runGitOk(repoDir, cwd, [
      "diff-tree", "-r", "-z", "--no-renames", "--numstat", base, commit.hash,
    ])
    const binarySet = new Set<string>()
    const lineStats = new Map<string, { additions: number; deletions: number }>()
    {
      const parts = numstat.stdout.split("\0").filter(Boolean)
      for (const row of parts) {
        const m = /^(\S+)\t(\S+)\t([^]*)$/.exec(row)
        if (!m) continue
        if (m[1] === "-" || m[2] === "-") binarySet.add(m[3])
        else lineStats.set(m[3], { additions: Number(m[1]) || 0, deletions: Number(m[2]) || 0 })
      }
    }

    const tokens = nameStatus.stdout.split("\0").filter(Boolean)
    const files: SnapshotFileDiff[] = []
    for (let i = 0; i + 1 < tokens.length && files.length < MAX_DIFF_FILES; i += 2) {
      const st = tokens[i]
      const path = tokens[i + 1]
      const status = st === "A" ? "added" : st === "D" ? "deleted" : "modified"
      const binary = binarySet.has(path)
      let oldContent: string | null = null
      let newContent: string | null = null
      if (!binary) {
        if (status !== "added") oldContent = yield* showFile(repoDir, cwd, base, path)
        if (status !== "deleted") newContent = yield* showFile(repoDir, cwd, commit.hash, path)
        // Over-cap contents are dropped (client renders a "not viewable" state).
        if (
          (oldContent?.length ?? 0) > MAX_DIFF_CONTENT_BYTES ||
          (newContent?.length ?? 0) > MAX_DIFF_CONTENT_BYTES
        ) {
          oldContent = null
          newContent = null
        }
      }
      const stats = lineStats.get(path)
      files.push({
        path,
        status,
        binary,
        additions: stats?.additions ?? 0,
        deletions: stats?.deletions ?? 0,
        oldContent,
        newContent,
      })
    }

    // More name-status tokens than files materialized → response is capped.
    const truncated = tokens.length / 2 > files.length
    return { commit, files, truncated } satisfies SnapshotDiff
  }).pipe(Effect.withSpan("snapshot.diff", { attributes: { cwd, commit: commitHash } }))

// ─────────────────────────────────────────────────────────
// Cleanup (retention)
// ─────────────────────────────────────────────────────────

const cleanupImpl = (
  snapshotsRoot: string,
  keepDays: number,
  repoTtlDays: number
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const dirs = yield* fsTry("readdir", () => readdir(snapshotsRoot)).pipe(
      Effect.orElseSucceed(() => [] as string[])
    )
    const now = Date.now()
    const dayCutoff = localDay(new Date(now - (keepDays - 1) * 24 * 3600 * 1000))

    /** Evaluate staleness from a fresh meta read. Corrupt meta NEVER counts
     *  as stale — a torn meta.json must not delete a whole project history. */
    const isStale = (repoDir: string): Effect.Effect<"stale" | "keep" | "corrupt", never> =>
      Effect.gen(function* () {
        const { state, meta } = yield* readMetaState(repoDir)
        if (state === "corrupt") return "corrupt" as const
        if (state === "missing") {
          // Legacy/no meta: fall back to the directory mtime.
          const mtime = yield* fsTry("stat dir", () => stat(repoDir).then((s) => s.mtimeMs)).pipe(
            Effect.orElseSucceed(() => now)
          )
          return mtime < now - repoTtlDays * 24 * 3600 * 1000 ? ("stale" as const) : ("keep" as const)
        }
        const m = meta as Meta
        const cwdGone = !(yield* fsTry("stat cwd", () =>
          stat(m.cwd).then((s) => s.isDirectory())
        ).pipe(Effect.orElseSucceed(() => false)))
        return m.lastSnapshotAt < now - repoTtlDays * 24 * 3600 * 1000 || cwdGone
          ? ("stale" as const)
          : ("keep" as const)
      })

    const headExists = (repoDir: string): Effect.Effect<boolean, never> =>
      fsTry("stat HEAD", () => stat(join(repoDir, "HEAD")).then(() => true)).pipe(
        Effect.orElseSucceed(() => false)
      )

    for (const name of dirs) {
      const repoDir = join(snapshotsRoot, name)
      const isDir = yield* fsTry("stat dir", () => stat(repoDir).then((s) => s.isDirectory())).pipe(
        Effect.orElseSucceed(() => false)
      )
      if (!isDir) continue

      if (!(yield* headExists(repoDir))) {
        // Debris (interrupted init / half-deleted repo). Remove under the
        // repo lock and re-check inside — an init may be in flight.
        yield* withRepoLock(
          repoDir,
          Effect.gen(function* () {
            if (yield* headExists(repoDir)) return // init won the race — keep
            yield* Effect.logInfo(`snapshot cleanup: removing debris dir ${name}`)
            yield* fsTry("rm debris", () => rm(repoDir, { recursive: true, force: true })).pipe(
              Effect.orElseSucceed(() => undefined)
            )
          })
        )
        continue
      }

      const verdict = yield* isStale(repoDir)
      if (verdict === "corrupt") {
        yield* Effect.logWarning(
          `snapshot cleanup: ${name} has an unreadable meta.json — keeping repo (refusing to delete on corrupt metadata)`
        )
        continue
      }
      if (verdict === "stale") {
        // The whole removal runs under the repo lock so an in-flight commit
        // (e.g. user returns to a dormant project and immediately chats) is
        // never ripped out from underneath. Staleness is RE-CHECKED inside
        // the lock: that same in-flight commit refreshes lastSnapshotAt.
        // The semaphore entry is intentionally KEPT — deleting it would
        // split the serialization domain between old and new lock holders.
        yield* withRepoLock(
          repoDir,
          Effect.gen(function* () {
            if ((yield* isStale(repoDir)) !== "stale") return
            yield* Effect.logInfo(`snapshot cleanup: removing repo ${name} (stale or cwd gone)`)
            yield* fsTry("rm repo", () => rm(repoDir, { recursive: true, force: true })).pipe(
              Effect.orElseSucceed(() => undefined)
            )
          })
        )
        continue
      }

      // Delete day branches older than the retention window, then gc.
      const branches = yield* runGit(repoDir, null, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads/snap/",
      ]).pipe(Effect.map((r) => (r.code === 0 ? r.stdout.trim().split("\n").filter(Boolean) : [])))
      const expired = branches.filter((b) => {
        const day = b.slice("snap/".length)
        return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < dayCutoff
      })
      if (expired.length > 0) {
        const dropped = yield* withRepoLock(
          repoDir,
          Effect.gen(function* () {
            // `branch -D` refuses to delete the branch HEAD points at (this
            // is a non-bare repo) — repoint HEAD to today's branch first
            // (unborn is fine). Otherwise a dormant project's newest expired
            // branch survives every day, silently.
            yield* runGitOk(repoDir, null, [
              "symbolic-ref", "HEAD", `refs/heads/snap/${localDay(new Date())}`,
            ])
            let ok = 0
            for (const b of expired) {
              const r = yield* runGit(repoDir, null, ["branch", "-D", b])
              if (r.code === 0) ok++
              else {
                yield* Effect.logWarning(
                  `snapshot cleanup: failed to delete ${b} in ${name}: ${r.stderr.slice(0, 200)}`
                )
              }
            }
            if (ok > 0) {
              // Reflogs are disabled at init, but expire defensively before prune.
              yield* runGit(repoDir, null, ["reflog", "expire", "--expire=now", "--all"])
              yield* runGit(repoDir, null, ["gc", "--prune=now", "--quiet"])
            }
            return ok
          })
        )
        yield* Effect.logInfo(
          `snapshot cleanup: ${name} dropped ${dropped}/${expired.length} day branch(es) older than ${dayCutoff}`
        )
      }
    }
  }).pipe(Effect.withSpan("snapshot.cleanup"))

// ─────────────────────────────────────────────────────────
// Layer
// ─────────────────────────────────────────────────────────

export const SnapshotServiceLive = Layer.scoped(
  SnapshotService,
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const snapshotsRoot = join(cfg.cockpitDir, "snapshots")
    const maxFileBytes = cfg.snapshotMaxFileKb * 1024

    const cleanup = cleanupImpl(snapshotsRoot, cfg.snapshotKeepDays, cfg.snapshotRepoTtlDays)

    // Daily retention pass (first run immediately, then every 24h), tied to
    // the layer's Scope so runtime disposal interrupts it.
    yield* Effect.forkScoped(
      cleanup.pipe(
        Effect.catchAll((e) => Effect.logWarning(`snapshot cleanup failed: ${e.message}`)),
        Effect.repeat(Schedule.spaced("24 hours"))
      )
    )

    return SnapshotService.of({
      record: (trigger: SnapshotTrigger) =>
        snapshotOnce(snapshotsRoot, maxFileBytes, trigger, "tool"),
      baseline: (cwd: string, sessionKey: string, provider: string) =>
        snapshotOnce(snapshotsRoot, maxFileBytes, { cwd, sessionKey, provider }, "baseline"),
      listByToolIds: (cwd: string, toolIds: ReadonlyArray<string>, sessionKey?: string) =>
        listByToolIdsImpl(snapshotsRoot, cwd, toolIds, sessionKey),
      diff: (cwd: string, commitHash: string) => diffImpl(snapshotsRoot, cwd, commitHash),
      cleanup,
    })
  })
)
