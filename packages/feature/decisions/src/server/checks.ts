/**
 * Check detection inputs (docs/DECISION_MODE.md §5): the project's scripts and
 * markers, and the per-project user correction ("this is / is not a check")
 * stored in <COCKPIT_DIR>/decisions/<projectId>/checks.json.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { mutateJsonFile, readJsonFile } from '@cockpit/shared-utils';
import { normalizeCommand, type CheckOverrides, type ProjectScripts } from '../shared/checks';
import { projectDir } from './paths';
import { readGitInfo } from './projectIdentity';

const checksFile = (projectId: string): string => join(projectDir(projectId), 'checks.json');
const EMPTY: CheckOverrides = { include: [], exclude: [] };

const exists = (p: string) => stat(p).then(() => true, () => false);

export interface ProjectCheckSetup {
  scripts: ProjectScripts;
  markers: { pytest: boolean; goMod: boolean; cargo: boolean };
}

/** package.json scripts of the cwd, falling back to the git toplevel; plus language markers. */
export const readProjectSetup = (cwd: string): Effect.Effect<ProjectCheckSetup> =>
  Effect.gen(function* () {
    const top = (yield* readGitInfo(cwd))?.toplevel;
    const dirs = top && top !== cwd ? [cwd, top] : [cwd];
    let scripts: ProjectScripts = {};
    for (const d of dirs) {
      const pkg = yield* Effect.promise(() => readJsonFile<{ scripts?: unknown }>(join(d, 'package.json'), {}));
      if (pkg.scripts && typeof pkg.scripts === 'object') {
        scripts = Object.fromEntries(Object.entries(pkg.scripts as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as ProjectScripts;
        break;
      }
    }
    const any = (names: string[]) => Effect.promise(async () => {
      for (const d of dirs) for (const n of names) if (await exists(join(d, n))) return true;
      return false;
    });
    return {
      scripts,
      markers: {
        pytest: yield* any(['pytest.ini', 'conftest.py', 'pyproject.toml', 'tox.ini']),
        goMod: yield* any(['go.mod']),
        cargo: yield* any(['Cargo.toml']),
      },
    };
  });

export const readCheckOverrides = (projectId: string): Effect.Effect<CheckOverrides> =>
  Effect.promise(() => readJsonFile<CheckOverrides>(checksFile(projectId), EMPTY)).pipe(
    Effect.map((o) => ({
      include: Array.isArray(o.include) ? o.include.filter((x): x is string => typeof x === 'string') : [],
      exclude: Array.isArray(o.exclude) ? o.exclude.filter((x): x is string => typeof x === 'string') : [],
    })),
  );

/** Record the user's correction for one command (normalized); the opposite list loses it. */
export const setCheckOverride = (
  projectId: string,
  command: string,
  isCheck: boolean,
): Effect.Effect<CheckOverrides, FSError> => {
  const file = checksFile(projectId);
  const key = normalizeCommand(command);
  return Effect.tryPromise({
    try: () =>
      mutateJsonFile<CheckOverrides>(file, EMPTY, (cur) => {
        const include = (cur.include ?? []).filter((c) => c !== key);
        const exclude = (cur.exclude ?? []).filter((c) => c !== key);
        (isCheck ? include : exclude).push(key);
        return { include, exclude };
      }),
    catch: (cause) => new FSError({ path: file, op: 'write', cause }),
  });
};
