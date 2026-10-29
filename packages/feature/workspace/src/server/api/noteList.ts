/**
 * /api/note/list — every non-empty note, for the notes board's left column:
 * the global note plus each project note found under ~/.cockpit/projects.
 *
 * Each entry carries its full text (lowercased) so the board can search
 * client-side — notes are small and local, see CLAUDE.md. Reading and saving a
 * note still goes through /api/note; this route only lists.
 *
 * Route modules may only export route fields, so the path matching lives in
 * ./noteDirs.
 */
import { readdir, readFile, stat } from "fs/promises"
import nodePath from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  COCKPIT_PROJECTS_DIR,
  GLOBAL_STATE_FILE,
  NOTE_FILE,
} from "@cockpit/shared-utils"
import { matchNoteDir, type ListDir } from "./noteDirs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PROJECTS_FILE = nodePath.join(nodePath.dirname(NOTE_FILE), "projects.json")
const FIRST_LINE_MAX = 120

export interface NoteListEntry {
  /** null = the global note. */
  cwd: string | null
  /** False when `cwd` is a best-effort decode (see noteDirs). */
  exact: boolean
  mtime: number
  /** First non-blank line, markdown markers stripped, for the row. */
  firstLine: string
  /** Whole note, lowercased, for client-side search. */
  searchText: string
}

const readText = (file: string) =>
  Effect.tryPromise(() => readFile(file, "utf-8")).pipe(Effect.orElseSucceed(() => ""))

const readJson = <T>(file: string, fallback: T) =>
  readText(file).pipe(
    Effect.flatMap((text) => Effect.try(() => JSON.parse(text) as T)),
    Effect.orElseSucceed(() => fallback),
  )

const mtimeOf = (file: string) =>
  Effect.tryPromise(() => stat(file)).pipe(
    Effect.map((s) => s.mtimeMs),
    Effect.orElseSucceed(() => 0),
  )

const firstLineOf = (content: string) => {
  const line = content.split("\n").map((l) => l.trim()).find(Boolean) ?? ""
  return line.replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX-]\]\s+)?|\d+\.\s+|>\s+)/, "").slice(0, FIRST_LINE_MAX)
}

const listChildDirs: ListDir = (dir) =>
  readdir(dir, { withFileTypes: true }).then(
    (entries) => entries.filter((d) => d.isDirectory()).map((d) => d.name),
    () => [],
  )

/** The note's entry, or null when it is missing or blank. */
const readEntry = (file: string, locate: () => Promise<{ cwd: string | null; exact: boolean } | undefined>) =>
  Effect.gen(function* () {
    const content = yield* readText(file)
    if (!content.trim()) return null
    // Located only once the note is known to have content: most project
    // directories hold no note, and the filesystem walk is the costly part.
    const where = yield* Effect.tryPromise(locate).pipe(Effect.orElseSucceed(() => undefined))
    if (!where) return null
    const entry: NoteListEntry = {
      ...where,
      mtime: yield* mtimeOf(file),
      firstLine: firstLineOf(content),
      searchText: content.toLowerCase(),
    }
    return entry
  })

export const GET = handler(() =>
  Effect.gen(function* () {
    // Paths we already know, so most directories map exactly (noteDirs step 1).
    const projects = yield* readJson<{ projects?: { cwd: string }[] }>(PROJECTS_FILE, {})
    const state = yield* readJson<{ sessions?: { cwd: string }[] }>(GLOBAL_STATE_FILE, {})
    const knownCwds = [
      ...(projects.projects ?? []).map((p) => p.cwd),
      ...(state.sessions ?? []).map((s) => s.cwd),
    ]

    const dirNames = yield* Effect.tryPromise(() => readdir(COCKPIT_PROJECTS_DIR)).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    )

    const projectEntries = yield* Effect.forEach(
      dirNames,
      (dirName) =>
        readEntry(nodePath.join(COCKPIT_PROJECTS_DIR, dirName, "note.md"), () =>
          matchNoteDir(dirName, knownCwds, listChildDirs),
        ),
      { concurrency: 8 },
    )
    const globalEntry = yield* readEntry(NOTE_FILE, async () => ({ cwd: null, exact: true }))

    const notes = [globalEntry, ...projectEntries].filter((e): e is NoteListEntry => e !== null)
    return ok({ notes })
  }),
)
