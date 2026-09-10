/**
 * /api/instructions/config — quick instructions for the chat input.
 *
 * Two scopes, same shape, mirroring /api/services/config:
 *   global  → ~/.cockpit/instructions.json
 *   project → ~/.cockpit/projects/<encoded cwd>/instructions.json
 *
 * A quick instruction is just its text — unlike a Console quick command it is never
 * addressed by name (the chat input's `/` and `@` markers already belong to
 * slash commands and skills), so a `name` field would be display-only clutter
 * the user has to fill in for every entry.
 *
 * ## Shape: a ONE-level tree
 *
 * `instructions` is a mixed array of items and groups:
 *
 *   [ {id,text}, {id,name,items:[{id,text}]}, {id,text} ]
 *
 * Groups and loose instructions share the root level, so the pre-group format
 * (`instructions: string[]`) reads back as an all-loose root with nothing lost and
 * no migration step. Nesting stops at one level on purpose: the UI opens a
 * group as a flyout submenu beside the popover, and a second flyout would need
 * ~960px of horizontal room inside a panel that is `overflow-hidden` at
 * viewport width.
 *
 * Order is still array position, root and per group — add / edit / delete /
 * reorder all POST the whole tree, so there is no order field to drift.
 */
import { Effect } from "effect"
import {
  getInstructionsConfigPath,
  getGlobalInstructionsConfigPath,
  getLegacyPromptsConfigPath,
  getLegacyGlobalPromptsConfigPath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

// NOTE: `runtime` / `dynamic` live in the route shim
// (src/app/api/instructions/config/route.ts), not here — Next only picks them up by
// static analysis of the route file, so declaring them in this module would be
// a config that looks set but never applies.

export interface InstructionItem {
  id: string
  text: string
}

export interface InstructionGroup {
  id: string
  name: string
  items: InstructionItem[]
}

/** Root-level entry: either a loose instruction or a group of instructions. */
export type InstructionNode = InstructionItem | InstructionGroup

/** Groups are told apart by the presence of `items`, never by a `type` tag —
 *  one less field to keep in sync, and it survives hand-edited JSON. */
export const isInstructionGroup = (node: InstructionNode): node is InstructionGroup =>
  Array.isArray((node as InstructionGroup).items)

interface InstructionsConfig {
  instructions: InstructionNode[]
}

/** Longest single instruction kept. Well past "one-liner"; guards against a paste
 *  of a whole document turning the popover into an unusable wall of text. */
const MAX_INSTRUCTION_LENGTH = 2000

/** Group names render on one row next to a chevron and two icon buttons, so
 *  anything longer than this is truncated on screen anyway. */
const MAX_GROUP_NAME_LENGTH = 60

/**
 * Ids exist only to key React rows and to address a row for edit / drag /
 * move — they are never shown, never referenced across files, and never
 * persisted anywhere else. So: random, not derived from the text.
 *
 * Deliberately NOT `toShortId` (shared-utils): that is a deterministic CRC32 of
 * its input, which would hand identical ids to the very case groups exist to
 * allow — the same instruction text filed under two different groups.
 */
const newId = (): string => Math.random().toString(36).slice(2, 10)

/**
 * Coerce one entry into a InstructionItem, or null if it carries no usable text.
 * Accepts a bare string so the pre-group `string[]` file still loads.
 */
const normalizeItem = (raw: unknown): InstructionItem | null => {
  const text =
    typeof raw === "string"
      ? raw
      : typeof (raw as InstructionItem)?.text === "string"
        ? (raw as InstructionItem).text
        : null
  // Non-strings are dropped rather than String()-ed: a stray `null` rendered as
  // "null" would be a sendable instruction the user never wrote.
  if (text === null) return null
  const trimmed = text.trim().slice(0, MAX_INSTRUCTION_LENGTH)
  if (!trimmed) return null
  const id = typeof (raw as InstructionItem)?.id === "string" ? (raw as InstructionItem).id : ""
  return { id, text: trimmed }
}

/**
 * Coerce arbitrary on-disk data into a valid one-level tree. Never throws.
 *
 * Rules worth knowing before hand-editing instructions.json:
 * - Duplicate text collapses WITHIN a scope (the root's loose instructions are one
 *   scope, each group is another). Two identical rows in the same list are
 *   indistinguishable when clicked; across two groups they are a real filing
 *   choice, so those survive.
 * - Ids are made unique across the whole tree. A missing or colliding id is
 *   reissued, because the UI addresses drag targets and open editors by id —
 *   two rows sharing one would move or save each other's row.
 * - A group nested inside a group is flattened up into its parent rather than
 *   dropped: the UI is one level deep, but silently deleting instructions someone
 *   hand-nested is the worse failure.
 * - A group with a blank name loses its shell and its items move to the root,
 *   for the same reason — never drop the instructions, and never render a nameless
 *   group row the user cannot identify.
 */
export const normalizeInstructions = (raw: unknown): InstructionNode[] => {
  if (!Array.isArray(raw)) return []

  const usedIds = new Set<string>()
  const takeId = (preferred: string): string => {
    let id = preferred
    while (!id || usedIds.has(id)) id = newId()
    usedIds.add(id)
    return id
  }

  const rootSeen = new Set<string>()
  const out: InstructionNode[] = []

  /** Push an item into a group's list, honouring that group's dedupe set. */
  const pushItem = (item: InstructionItem, target: InstructionItem[], seen: Set<string>) => {
    if (seen.has(item.text)) return
    seen.add(item.text)
    target.push({ id: takeId(item.id), text: item.text })
  }

  /** Root is mixed (items beside groups), so loose items go straight onto
   *  `out` and dedupe against the root's own set. */
  const pushLoose = (item: InstructionItem) => {
    if (rootSeen.has(item.text)) return
    rootSeen.add(item.text)
    out.push({ id: takeId(item.id), text: item.text })
  }

  for (const entry of raw) {
    if (entry && typeof entry === "object" && Array.isArray((entry as InstructionGroup).items)) {
      const group = entry as InstructionGroup
      const name =
        typeof group.name === "string" ? group.name.trim().slice(0, MAX_GROUP_NAME_LENGTH) : ""

      const groupSeen = new Set<string>()
      const items: InstructionItem[] = []
      // One level of un-nesting: a group found inside a group contributes its
      // items to this group, then disappears.
      const collect = (list: unknown[], depth: number) => {
        for (const child of list) {
          if (
            depth < 4 &&
            child &&
            typeof child === "object" &&
            Array.isArray((child as InstructionGroup).items)
          ) {
            collect((child as InstructionGroup).items, depth + 1)
            continue
          }
          const item = normalizeItem(child)
          if (item) pushItem(item, items, groupSeen)
        }
      }
      collect(group.items, 0)

      if (!name) {
        // Blank name: keep the instructions, drop the shell. They rejoin the root,
        // where the root's own dedupe applies. Not via pushLoose — these
        // already hold ids issued above, and re-running takeId on an id it just
        // handed out would churn it for nothing.
        for (const item of items) {
          if (rootSeen.has(item.text)) continue
          rootSeen.add(item.text)
          out.push(item)
        }
        continue
      }
      // An empty group is kept: the user just created it and is about to fill
      // it, and deleting it under them would be its own bug.
      out.push({ id: takeId(typeof group.id === "string" ? group.id : ""), name, items })
      continue
    }

    const item = normalizeItem(entry)
    if (item) pushLoose(item)
  }

  return out
}

const resolveConfigPath = (
  cwd: string | null,
  scope: string | null
): string | null =>
  scope === "global"
    ? getGlobalInstructionsConfigPath()
    : cwd
      ? getInstructionsConfigPath(cwd)
      : null

/**
 * Where this file lived when the feature was called "quick prompts".
 * Reads fall back to it; writes never target it.
 */
const resolveLegacyPath = (
  cwd: string | null,
  scope: string | null
): string | null =>
  scope === "global"
    ? getLegacyGlobalPromptsConfigPath()
    : cwd
      ? getLegacyPromptsConfigPath(cwd)
      : null

/**
 * Choose between the current file's payload and the pre-rename file's.
 *
 * Split from the IO because this is the whole risk of the rename: pick wrong
 * and the user's instructions look deleted. `readJsonFile` returns the default
 * for both "absent" and "empty", so those are indistinguishable here — and both
 * mean "nothing here yet", which makes the legacy file the better answer
 * whenever it actually holds something.
 *
 * The legacy FIELD name is accepted too: that file's payload is
 * `{ prompts: [...] }`, since the file rename and the field rename shipped
 * together.
 */
export const pickTree = (
  current: Record<string, unknown> | null | undefined,
  legacy: Record<string, unknown> | null | undefined
): unknown => {
  const currentTree = current?.instructions
  if (Array.isArray(currentTree) && currentTree.length > 0) return currentTree
  const legacyTree = legacy?.prompts ?? legacy?.instructions
  if (Array.isArray(legacyTree) && legacyTree.length > 0) return legacyTree
  return currentTree
}

/**
 * Read the tree, falling back to the pre-rename file when the current one has
 * nothing in it.
 *
 * One-directional on purpose: the old file is READ but never written or
 * deleted, so downgrading to a build that predates the rename still finds its
 * data. The first save after an upgrade writes the new file, and from then on
 * the old one is simply ignored.
 */
const readTree = (
  configPath: string,
  legacyPath: string | null
): Effect.Effect<unknown, FSError> =>
  Effect.gen(function* () {
    const read = (path: string) =>
      Effect.tryPromise({
        try: () => readJsonFile<Record<string, unknown>>(path, {}),
        catch: (cause) => new FSError({ path, op: "read", cause }),
      })
    const current = yield* read(configPath)
    if (!legacyPath || legacyPath === configPath) return pickTree(current, null)
    return pickTree(current, yield* read(legacyPath))
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const configPath = resolveConfigPath(sp.get("cwd"), sp.get("scope"))
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd|scope", reason: "Missing cwd or scope" })
      )
    }
    const raw = yield* readTree(configPath, resolveLegacyPath(sp.get("cwd"), sp.get("scope")))
    // Normalized in memory only — deliberately NOT written back. A read with a
    // write side effect races a concurrent POST (neither takes the file lock)
    // and could resurrect an instruction the user just deleted.
    //
    // This is also where a pre-group `string[]` file becomes a tree, which is
    // why there is no migration script: the old shape simply reads as an
    // all-loose root, and the next POST writes the new shape back.
    return ok({ instructions: normalizeInstructions(raw) })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      scope?: string
      instructions?: unknown
    }
    const configPath = resolveConfigPath(body.cwd ?? null, body.scope ?? null)
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd|scope", reason: "Missing cwd or scope" })
      )
    }
    // Full-tree overwrite: add / edit / delete / reorder / regroup all post the
    // whole thing, so ordering is simply each array's — there is no order field
    // to drift out of sync with it.
    const config: InstructionsConfig = { instructions: normalizeInstructions(body.instructions) }
    // withFileLock, not a bare writeJsonFile: the latter truncates then writes,
    // so an unserialized concurrent reader can observe a half-written file.
    yield* Effect.tryPromise({
      try: () => withFileLock(configPath, () => writeJsonFile(configPath, config)),
      catch: (cause) => new FSError({ path: configPath, op: "write", cause }),
    })
    // Echo what was actually persisted. This POST is the authoritative
    // normalization point (trims, drops empties, collapses duplicates, issues
    // ids), so a caller keeping its optimistic tree would silently disagree
    // with disk — and would have placeholder ids for any row it just added.
    return ok({ success: true, instructions: config.instructions })
  })
)
