/**
 * A skill's directory, addressed by id (registered: the skills.json record;
 * builtin: `builtin:<cmd>`) — never by a client-supplied path. Listing and
 * confined reads live in @cockpit/shared-utils/dirFiles, shared with Bots.
 */
import { SKILLS_FILE, readJsonFile } from "@cockpit/shared-utils"
import { BUILTIN_ID_PREFIX, builtinSkillFile } from "./builtinSkillsList"

/** SKILL.md path for an id, or null when the id names no skill. */
export async function skillMdPathById(id: string): Promise<string | null> {
  if (id.startsWith(BUILTIN_ID_PREFIX)) {
    const cmd = id.slice(BUILTIN_ID_PREFIX.length)
    return /^[A-Za-z0-9_-]+$/.test(cmd) ? builtinSkillFile(cmd) : null
  }
  const data = await readJsonFile<{ skills: { id: string; path: string }[] }>(SKILLS_FILE, { skills: [] })
  return data.skills.find((s) => s.id === id)?.path ?? null
}
