/**
 * Built-in HTML apps, surfaced in the registry as virtual cards.
 *
 * Two deliberate choices here, both easy to "helpfully" undo later:
 *
 * 1. A whitelist, NOT a readdir of APPS_DIR. apps/file-viewer only does
 *    anything given a `?file=` query param, so enumerating the directory would
 *    put a card in the grid that opens to an empty/broken app. Adding a
 *    built-in to the panel is an explicit decision — make it here.
 *
 * 2. These are never written to html.json. That registry stores absolute paths,
 *    and a built-in's path moves with the install (npm global dir vs repo
 *    checkout, and again per COCKPIT_HOME), so persisting one would leave a
 *    dead grey "invalid" card after any upgrade or machine change — which the
 *    user then cannot delete, because deleting rewrites html.json.
 *
 * Note this is a *listing* concern only. It is unrelated to SDK injection,
 * which api/apps.ts deliberately does not gate on any marker (see its header).
 */
import { join } from "path"
import { APPS_DIR } from "@cockpit/shared-utils"
import { parseHtmlMeta } from "../../lib/parseHtmlMeta"

/** Directory names under /apps to list as cards. */
const BUILTIN_APP_NAMES = ["devkit"] as const

export const BUILTIN_ID_PREFIX = "builtin:"

export const isBuiltinId = (id: string): boolean =>
  id.startsWith(BUILTIN_ID_PREFIX)

export interface BuiltinAppInfo {
  id: string
  path: string
  addedAt: string
  name: string
  title: string
  description: string
  icon?: string
  valid: boolean
  builtin: true
}

/**
 * Resolve each whitelisted built-in against the current install. Entries whose
 * index.html is missing are omitted entirely rather than rendered as invalid
 * cards: an undeletable broken card is worse than no card.
 */
export async function listBuiltinApps(): Promise<BuiltinAppInfo[]> {
  const entries = await Promise.all(
    BUILTIN_APP_NAMES.map(async (dir): Promise<BuiltinAppInfo | null> => {
      const filePath = join(APPS_DIR, dir, "index.html")
      const meta = await parseHtmlMeta(filePath)
      if (!meta.valid) return null
      return {
        id: `${BUILTIN_ID_PREFIX}${dir}`,
        path: filePath,
        // Built-ins were never "added"; the panel does not display this.
        addedAt: "",
        name: meta.name,
        title: meta.title,
        description: meta.description,
        icon: meta.icon,
        valid: true,
        builtin: true as const,
      }
    })
  )
  return entries.filter((e): e is BuiltinAppInfo => e !== null)
}
