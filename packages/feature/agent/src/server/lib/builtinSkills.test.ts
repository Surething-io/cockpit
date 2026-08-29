/**
 * Guards the invariants the `skills/` directory now carries alone. They used to
 * be enforced by TypeScript (a command missing from COMMAND_CONTENT didn't
 * compile); with the registry moved to disk, only a test can catch them.
 *
 * COCKPIT_ROOT is pinned to the repo root and the module imported afterwards:
 * paths.ts resolves the directory once at module load, and a Cockpit-spawned
 * agent inherits the *installed* package's COCKPIT_ROOT — so an ambient value
 * would otherwise point this test at a different checkout entirely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();
process.env.COCKPIT_ROOT = REPO_ROOT;

type Mod = typeof import('./builtinSkills');
let mod: Mod;
let names: string[];

beforeAll(async () => {
  mod = await import('./builtinSkills');
  names = mod.listBuiltinSkillNames();
});

describe('builtin skills directory', () => {
  it('resolves to the repo skills/ dir and is non-empty', () => {
    expect(names.length).toBeGreaterThan(0);
    expect(mod.builtinSkillPath(names[0])).toBe(
      join(REPO_ROOT, 'skills', names[0], 'SKILL.md'),
    );
  });

  it('every skill: frontmatter name matches its directory name', () => {
    // The directory name is what `/<cmd>` dispatches and where the resolved copy
    // is written; `name:` is what the agent reads inside the file. If they
    // disagree the command still runs, but the agent is told it is a different
    // skill than the one the user typed.
    const mismatched = names.filter(
      (n) =>
        mod.readFrontmatterField(readFileSync(mod.builtinSkillPath(n), 'utf-8'), 'name') !== n,
    );
    expect(mismatched).toEqual([]);
  });

  it('every skill: has a description for the autocomplete dropdown', () => {
    const missing = mod.listBuiltinSkillsMeta().filter((m) => !m.description);
    expect(missing.map((m) => m.name)).toEqual([]);
  });
});
