/**
 * Constraint: PrivateDataOwnerOnly (invariant, L4 — boundary at the directory).
 *
 * Everything Cockpit derives from a session — state.json, the transcript index, the
 * search corpus, codex heads — lives under COCKPIT_DIR, and transcripts themselves are
 * owner-only (0600). So:
 *   1. startup (tightenPrivateData) makes COCKPIT_DIR 0700, whatever an older version
 *      or the umask left it at — other local users cannot reach any file inside;
 *   2. writeAtomically, the write primitive for derived data, creates files 0600 and
 *      directories 0700, so a copy never ends up more readable than its source even
 *      if it were moved out of the boundary.
 *
 * Why: transcript index shards (full user prompts) were written with the default
 * umask, i.e. 0644, into a 0755 data directory — readable by any local user — and the
 * search corpus (prompts and replies) had been the same for longer. A per-file
 * registry like SECRET_FILES cannot keep up with every new derived file; the
 * directory can.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing (paths.ts resolves it once
 * at module load). POSIX-only: Windows has no group / other permission bits.
 */
import { mkdirSync, mkdtempSync, statSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'cockpit-private-'));
const home = join(root, 'cockpit');
mkdirSync(home);
chmodSync(home, 0o755); // what an older version / default umask produced
process.env.COCKPIT_HOME = home;

const posix = process.platform !== 'win32';
const groupOrOther = (p: string) => statSync(p).mode & 0o077;

let utils: typeof import('../packages/shared/utils/src/index');
let fsPrims: typeof import('../packages/shared/effect-runtime/src/server/fs');

beforeAll(async () => {
  utils = await import('../packages/shared/utils/src/index');
  fsPrims = await import('../packages/shared/effect-runtime/src/server/fs');
});

describe.runIf(posix)('PrivateDataOwnerOnly', () => {
  it('startup tightens a world-readable data directory to 0700', async () => {
    expect(groupOrOther(home)).not.toBe(0);
    await utils.tightenPrivateData();
    expect(statSync(home).mode & 0o777).toBe(utils.PRIVATE_DIR_MODE);
  });

  it('derived files and their directories are created owner-only under umask 022', async () => {
    const prev = process.umask(0o022);
    try {
      const file = join(home, 'transcript-index', 'nested', 'shard.json');
      await fsPrims.writeAtomically(file, '{"userTurns":["private prompt"]}');
      expect(groupOrOther(file)).toBe(0);
      expect(groupOrOther(join(home, 'transcript-index'))).toBe(0);
      expect(groupOrOther(join(home, 'transcript-index', 'nested'))).toBe(0);
    } finally {
      process.umask(prev);
    }
  });
});
