/**
 * Shared reader for `/api/files/text` — Effect wrapper.
 *
 * Lives in shared/ rather than feature-explorer because two features need it:
 * feature-explorer (CodeViewer / useFileTree / FileEditorModal / …) and
 * feature-comments (CommentsListModal reads the code behind a comment). Homing
 * it in feature-explorer is what used to make feature-comments depend on
 * feature-explorer, which cycled — feature-explorer imports feature-comments
 * for useComments.
 *
 * The `{status, ok, data}` shape is the contract, not an accident: `text` lets
 * 409 (binary detected on the second sniff) pass through so the caller decides
 * how to handle it. That subtlety is exactly why both callers share one
 * definition instead of each hand-rolling a fetch.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

export interface TextResponse {
  content?: string
  size?: number
  mtimeMs?: number
  isSymlink?: boolean
  symlinkTarget?: string
  error?: string
}

/**
 * GET that surfaces the response status, so callers can inspect a 4xx body
 * instead of only seeing a thrown error.
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
    catch: (cause) => new AppError({ message: `GET ${url} failed`, cause }),
  })

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
