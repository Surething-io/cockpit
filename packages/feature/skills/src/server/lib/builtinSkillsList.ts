/**
 * Read-only view of the builtin skills (`/skills/<cmd>/SKILL.md` in the package)
 * for the skills board. The registry itself — dispatch and the `/` menu — lives
 * in feature-agent (server/lib/builtinSkills.ts); this only reads the same
 * directory, so the skills package does not depend on the agent package.
 *
 * Hidden builtins (`hidden: true`, bot machinery) are left out, as in the `/`
 * menu. Ids are `builtin:<cmd>` so they can never collide with a registered
 * skill's generated id.
 */
import { readdirSync } from "fs"
import { join } from "path"
import { BUILTIN_SKILLS_SRC_DIR } from "@cockpit/shared-utils"
import { parseSkillMd, type ParsedSkill } from "./parseSkillMd"

export const BUILTIN_ID_PREFIX = "builtin:"

export const builtinSkillFile = (cmd: string) => join(BUILTIN_SKILLS_SRC_DIR, cmd, "SKILL.md")

/** Directory names under /skills; [] when the directory is unreadable. */
function builtinCommands(): string[] {
  try {
    return readdirSync(BUILTIN_SKILLS_SRC_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** `hidden: true` inside the frontmatter block. */
const isHidden = (content: string) => {
  const fm = /^---\n([\s\S]*?)\n---/.exec(content)
  return !!fm && /^hidden:\s*true\s*$/m.test(fm[1])
}

export interface BuiltinSkillEntry extends ParsedSkill {
  id: string
  path: string
}

export async function listBuiltinSkills(): Promise<BuiltinSkillEntry[]> {
  const out: BuiltinSkillEntry[] = []
  for (const cmd of builtinCommands()) {
    const path = builtinSkillFile(cmd)
    const parsed = await parseSkillMd(path)
    if (!parsed.valid || isHidden(parsed.content)) continue
    // The directory name is the command (`/<cmd>` dispatches it), whatever the
    // frontmatter `name:` says.
    out.push({ ...parsed, id: BUILTIN_ID_PREFIX + cmd, name: cmd, path })
  }
  return out
}
