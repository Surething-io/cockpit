/**
 * Builtin slash-command registry — backed by the `skills/` directory that ships
 * inside the package, NOT by TypeScript constants.
 *
 * `skills/<cmd>/SKILL.md` is the whole definition: the directory name is the
 * command (`/<cmd>`), the file is a complete SKILL.md (YAML frontmatter + body)
 * in the exact shape a user-defined skill uses, and its `description` is what
 * the autocomplete dropdown shows. English only.
 *
 * The directory set IS the registry. Both consumers — resolveCommandPrompt
 * (slashCommands.ts) and GET /api/commands — derive from these functions, so
 * adding a builtin is `mkdir` + one file, with no list to keep in sync. This
 * replaced a pair of hand-maintained tables (COMMAND_CONTENT with zh/en string
 * literals, plus BUILTIN_COMMANDS in the route) that could and did drift apart.
 *
 * Everything here is synchronous on purpose: resolveCommandPrompt is called
 * inline inside Effect.gen by all five engine chat handlers and must stay sync.
 * The payload is a handful of small local files (see "Project Characteristics"
 * in CLAUDE.md — local IO is sub-10ms and deliberately uncached, so an edit to
 * a SKILL.md takes effect on the next dispatch with no rebuild or restart).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { BUILTIN_SKILLS_SRC_DIR } from '@cockpit/shared-utils';

export interface BuiltinSkillMeta {
  /** Command verb = directory name. `/<name>` dispatches it. */
  name: string;
  /** `description:` from the frontmatter; '' when absent. */
  description: string;
}

/**
 * Command verbs available as builtins: every `skills/*` subdirectory that
 * actually holds a SKILL.md.
 *
 * A read failure here would silently un-register EVERY builtin (`/cr` would
 * degrade to plain prose in the prompt with no error anywhere), so it is logged
 * with the resolved path rather than swallowed. Empty result = misconfigured
 * COCKPIT_ROOT / broken install, not "no builtins".
 */
export function listBuiltinSkillNames(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(BUILTIN_SKILLS_SRC_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    console.error(
      `[skills] cannot read builtin skills dir ${BUILTIN_SKILLS_SRC_DIR} — all builtin slash commands are unavailable:`,
      err,
    );
    return [];
  }
  return entries.filter((name) => {
    try {
      return statSync(builtinSkillPath(name)).isFile();
    } catch {
      return false;
    }
  }).sort();
}

/** Absolute path of a builtin's source SKILL.md (may not exist). */
export function builtinSkillPath(name: string): string {
  return join(BUILTIN_SKILLS_SRC_DIR, name, 'SKILL.md');
}

/** Raw SKILL.md text ({{BASE_URL}} still unsubstituted), or null if unreadable. */
export function readBuiltinSkill(name: string): string | null {
  try {
    return readFileSync(builtinSkillPath(name), 'utf-8');
  } catch {
    return null;
  }
}

/** Name + description for every builtin — the autocomplete dropdown's source. */
export function listBuiltinSkillsMeta(): BuiltinSkillMeta[] {
  return listBuiltinSkillNames().map((name) => {
    const text = readBuiltinSkill(name);
    return {
      name,
      description: (text && readFrontmatterField(text, 'description')) || '',
    };
  });
}

/**
 * Pull one scalar field out of a SKILL.md YAML frontmatter block.
 *
 * Minimal by design — a real YAML parse would drag js-yaml into a sync hot path
 * for two flat string fields. Handles the quoted and unquoted forms both builtin
 * and user skills are written in; anything fancier (block scalars, folded text)
 * is not used by either and returns null rather than half-parsing.
 */
export function readFrontmatterField(text: string, field: string): string | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const block = fm ? fm[1] : text;
  const m = block.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : null;
}
