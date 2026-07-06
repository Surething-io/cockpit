/**
 * Client-side files IO — Effect wrappers.
 *
 * Covers eight `useFileTree` endpoints: init / index / readdir / recent /
 * expanded / blame / stat / text. `recent` is read+write, `expanded` is
 * write-only.
 *
 * Conventions:
 *  - On 4xx, lift body.error into `cause.message` so callers can show the
 *    server-rendered message (preserves the existing setFileError / blameError
 *    user feedback).
 *  - The stat → text composition is orchestrated by hooks with Effect.gen;
 *    this module only exposes the atomic operations.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// HTTP primitives
// ─────────────────────────────────────────────────────────

interface HttpGetOptions {
  /** fetch RequestInit (cache: 'no-store', etc.) */
  init?: RequestInit
  /** Statuses to pass through (no throw) — caller receives `{status, data}`. */
  passThroughStatuses?: ReadonlyArray<number>
}

/**
 * Generic GET — on 4xx, attempt to read `body.error` as the Error message.
 */
const httpGet = <A>(
  url: string,
  options: HttpGetOptions = {}
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, options.init)
      if (
        options.passThroughStatuses &&
        options.passThroughStatuses.includes(res.status)
      ) {
        return (await res.json().catch(() => ({}))) as A
      }
      if (!res.ok) {
        let bodyError: string | undefined
        try {
          const data = (await res.json()) as { error?: string }
          bodyError = data.error
        } catch {
          /* not JSON */
        }
        throw new Error(bodyError || `HTTP ${res.status}`)
      }
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `GET ${url} failed`, cause }),
  })

/**
 * GET that surfaces the response status — used by stat / text where callers
 * need to inspect the 4xx body. Returns `{status, ok, data}` for the caller to
 * classify.
 */
const httpGetWithStatus = <A>(
  url: string,
  init?: RequestInit
): Effect.Effect<{ status: number; ok: boolean; data: A | null }, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      let data: A | null = null
      try {
        data = (await res.json()) as A
      } catch {
        /* not JSON */
      }
      return { status: res.status, ok: res.ok, data }
    },
    catch: (cause) =>
      new AppError({ message: `GET ${url} failed`, cause }),
  })

const httpPostJson = (
  url: string,
  body: unknown
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: `POST ${url} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/files/init
// ─────────────────────────────────────────────────────────

export interface InitResponse<TFileNode> {
  files?: ReadonlyArray<TFileNode>
  expandedPaths?: ReadonlyArray<string>
  error?: string
}

export const loadFilesInit = <TFileNode>(
  cwd: string
): Effect.Effect<InitResponse<TFileNode>, AppError> =>
  httpGet<InitResponse<TFileNode>>(
    `/api/files/init?cwd=${encodeURIComponent(cwd)}`
  )

// ─────────────────────────────────────────────────────────
// /api/files/index
// ─────────────────────────────────────────────────────────

export const loadFileIndex = (
  cwd: string
): Effect.Effect<{ paths?: ReadonlyArray<string> }, AppError> =>
  httpGet(`/api/files/index?cwd=${encodeURIComponent(cwd)}`)

// ─────────────────────────────────────────────────────────
// /api/files/readdir
// ─────────────────────────────────────────────────────────

export const readDirectory = <TFileNode>(
  cwd: string,
  path: string
): Effect.Effect<{ children?: ReadonlyArray<TFileNode> }, AppError> =>
  httpGet(
    `/api/files/readdir?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`
  )

// ─────────────────────────────────────────────────────────
// /api/files/recent (GET / POST)
// ─────────────────────────────────────────────────────────

export const loadRecentFiles = <TRecent>(
  cwd: string
): Effect.Effect<{ files?: ReadonlyArray<TRecent> }, AppError> =>
  httpGet(`/api/files/recent?cwd=${encodeURIComponent(cwd)}`)

export const persistRecentFile = (
  cwd: string,
  file: string,
  position?: { scrollLine: number; cursorLine: number; cursorCol: number }
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/files/recent", {
    cwd,
    file,
    ...(position ?? {}),
  })

// ─────────────────────────────────────────────────────────
// /api/files/expanded (POST)
// ─────────────────────────────────────────────────────────

export const saveExpandedPaths = (
  cwd: string,
  paths: ReadonlyArray<string>
): Effect.Effect<void, AppError> =>
  httpPostJson("/api/files/expanded", { cwd, paths })

// ─────────────────────────────────────────────────────────
// /api/files/blame
// ─────────────────────────────────────────────────────────

export interface BlameResponse<TBlameLine> {
  blame?: ReadonlyArray<TBlameLine>
  error?: string
}

/**
 * Blame is best-effort: some paths (e.g. `.env.local`, paths outside the
 * worktree, server-side path guards) legitimately have no blame info. We
 * soften the failure into a `{ error }` response so it never surfaces as an
 * unhandled error in the dev console. Callers already branch on `data.error`.
 */
export const loadBlame = <TBlameLine>(
  cwd: string,
  path: string
): Effect.Effect<BlameResponse<TBlameLine>, never> =>
  httpGet<BlameResponse<TBlameLine>>(
    `/api/files/blame?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`
  ).pipe(
    Effect.catchAll((err) =>
      Effect.succeed({ error: err.message } as BlameResponse<TBlameLine>)
    )
  )

// ─────────────────────────────────────────────────────────
// /api/files/stat
// ─────────────────────────────────────────────────────────

/**
 * Loose `stat` shape — the precise union is resolved hook-side.
 */
export interface StatLike {
  exists?: boolean
  kind?: "file" | "dir"
  category?: "image" | "pdf" | "binary" | "too-large" | "text"
  size?: number
  mtimeMs?: number
  isSymlink?: boolean
  symlinkTarget?: string
  error?: string
}

/**
 * `stat` must use `cache: 'no-store'`; on failure returns `ok=false` + `data.error`.
 */
export const fetchFileStat = (
  cwd: string,
  path: string
): Effect.Effect<
  { status: number; ok: boolean; data: StatLike | null },
  AppError
> =>
  httpGetWithStatus<StatLike>(
    `/api/files/stat?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    { cache: "no-store" }
  )

// ─────────────────────────────────────────────────────────
// /api/files/text
// ─────────────────────────────────────────────────────────

export interface TextResponse {
  content?: string
  size?: number
  mtimeMs?: number
  isSymlink?: boolean
  symlinkTarget?: string
  error?: string
}

/**
 * `text` allows 409 (binary detected on second sniff) to pass through; the
 * caller decides how to handle it.
 */
export const fetchFileText = (
  cwd: string,
  path: string
): Effect.Effect<
  { status: number; ok: boolean; data: TextResponse | null },
  AppError
> =>
  httpGetWithStatus<TextResponse>(
    `/api/files/text?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    { cache: "no-store" }
  )

/**
 * Call `/api/files/text` with a pre-built query string — used by callers like
 * BlockViewer that assemble URLSearchParams up-front.
 */
export const fetchFileTextRaw = <A = TextResponse>(
  qs: URLSearchParams | string
): Effect.Effect<A, AppError> =>
  httpGet<A>(`/api/files/text?${qs.toString()}`)

// ─────────────────────────────────────────────────────────
// /api/files/save (POST)
// ─────────────────────────────────────────────────────────

export interface SaveFileBody {
  cwd: string
  path: string
  content: string
  /** Optimistic-concurrency token; the server compares mtimeMs. */
  mtimeMs?: number
  /** Skip the mtime check when creating a new file. */
  isNew?: boolean
  [key: string]: unknown
}

export interface SaveFileResponse {
  ok?: boolean
  conflict?: boolean
  serverMtimeMs?: number
  serverContent?: string
  error?: string
  [key: string]: unknown
}

/**
 * Save a file, with optimistic-concurrency conflict detection (response
 * carries `conflict + serverContent`). 4xx does not throw — `status + data`
 * are surfaced so the caller can render conflict UI.
 */
export const saveFile = (
  body: SaveFileBody
): Effect.Effect<
  { status: number; ok: boolean; data: SaveFileResponse | null },
  AppError
> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      let data: SaveFileResponse | null = null
      try {
        data = (await res.json()) as SaveFileResponse
      } catch {
        /* not JSON */
      }
      return { status: res.status, ok: res.ok, data }
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/files/save failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/files/clipboard (GET + POST)
// ─────────────────────────────────────────────────────────

export interface ClipboardResponse {
  cwd?: string
  paths?: ReadonlyArray<string>
  op?: "copy" | "cut"
  [key: string]: unknown
}

export const loadFileClipboard = (): Effect.Effect<
  ClipboardResponse,
  AppError
> => httpGet("/api/files/clipboard")

export const saveFileClipboard = (
  body: { cwd: string; paths: ReadonlyArray<string>; op: "copy" | "cut" }
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/files/clipboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/files/clipboard failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/files/paste & /api/files/delete (POST)
// ─────────────────────────────────────────────────────────

export const pasteFiles = <A = unknown>(
  body: Record<string, unknown>
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/files/paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok)
        throw new Error(
          (data as { error?: string })?.error || `HTTP ${res.status}`
        )
      return data as A
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/files/paste failed", cause }),
  })

export const deleteFiles = (
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch("/api/files/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok)
        throw new Error(
          (data as { error?: string })?.error || `HTTP ${res.status}`
        )
      return data
    },
    catch: (cause) =>
      new AppError({ message: "POST /api/files/delete failed", cause }),
  })

// ─────────────────────────────────────────────────────────
// /api/file?path= — read a file by absolute path (PreviewModal).
// ─────────────────────────────────────────────────────────

export const fetchFileByPath = (
  path: string
): Effect.Effect<{ content?: string; error?: string }, AppError> =>
  httpGet(`/api/file?path=${encodeURIComponent(path)}`)
