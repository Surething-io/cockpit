import { statSync } from 'fs';
import { join, delimiter } from 'path';

/**
 * Locating the Codex CLI binary, without `@openai/codex-sdk`.
 *
 * The SDK owned this job for us, but its API speaks only `exec
 * --experimental-json` (the argv is hard-coded), which has no incremental text
 * events at all — the reason this whole app-server path exists. Its resolver is
 * not exported (`export { Codex, Thread }`), so dropping the SDK means owning
 * the resolution.
 *
 * The npm launcher at `@openai/codex/bin/codex.js` does a THIRD of this job and
 * is tempting to shell out to instead. Measured, that costs ~170ms per turn for
 * an extra resident node process — paid every turn under the per-turn process
 * model — and it still leaves `pathEnvKey` (below) to us, which is the only
 * genuinely subtle part. So: resolve here, spawn the native binary directly.
 */

const CODEX_NPM_NAME = '@openai/codex';

/**
 * Mirrors `@openai/codex`'s own table. Kept as data rather than derived from
 * `process.platform` + `process.arch` so an unsupported pair fails loudly here
 * rather than as a confusing ENOENT on a path we assembled from nothing.
 */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

export function codexTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  switch (platform) {
    // Android ships the musl build, matching the upstream launcher.
    case 'linux':
    case 'android':
      if (arch === 'x64') return 'x86_64-unknown-linux-musl';
      if (arch === 'arm64') return 'aarch64-unknown-linux-musl';
      return null;
    case 'darwin':
      if (arch === 'x64') return 'x86_64-apple-darwin';
      if (arch === 'arm64') return 'aarch64-apple-darwin';
      return null;
    case 'win32':
      if (arch === 'x64') return 'x86_64-pc-windows-msvc';
      if (arch === 'arm64') return 'aarch64-pc-windows-msvc';
      return null;
    default:
      return null;
  }
}

export interface CodexBinary {
  executablePath: string;
  /**
   * Sidecar directories to prepend to the child's PATH. Today this is the
   * bundled `rg` that Codex's search tool shells out to — a 4MB ripgrep that
   * ships inside the platform package. The SDK prepended it; the npm launcher
   * does not, so whether the binary can also find it unaided is unproven.
   * Prepending costs nothing and removes the question.
   */
  pathDirs: string[];
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Candidate roots for the platform package, in resolution order: hoisted
 * (npm's default), then nested under the CLI package (pnpm, or a partial
 * hoist). Both are plain path joins.
 *
 * NOT `createRequire(...).resolve(...)`, which is what this originally used and
 * what shipped broken: Turbopack rewrites `createRequire` in the server bundle,
 * and the second call came out as `(void 0).resolve(...)`. Everything still
 * passed — types, unit tests, `next build` — because the fault only exists in
 * the emitted chunk. `packageField` in /api/version already avoids
 * `require.resolve` for its own reason; path reads are simply the thing that
 * survives bundling.
 */
function platformPackageRoots(cockpitRoot: string, platformPackage: string): string[] {
  const parts = platformPackage.split('/');
  return [
    join(cockpitRoot, 'node_modules', ...parts),
    join(cockpitRoot, 'node_modules', CODEX_NPM_NAME, 'node_modules', ...parts),
  ];
}

export function resolveCodexBinary(): CodexBinary {
  const triple = codexTargetTriple();
  if (!triple) {
    throw new Error(`Codex: unsupported platform ${process.platform} (${process.arch})`);
  }
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  // server.mjs stamps COCKPIT_ROOT with the install directory; cwd is the dev
  // fallback, matching paths.ts.
  const cockpitRoot = process.env.COCKPIT_ROOT || process.cwd();
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';

  for (const packageRootBase of platformPackageRoots(cockpitRoot, platformPackage)) {
    const packageRoot = join(packageRootBase, 'vendor', triple);

    // Current layout, gated on `codex-package.json` exactly as upstream does —
    // its presence is what distinguishes this from the legacy tree below.
    const current = join(packageRoot, 'bin', binaryName);
    if (isFile(current) && isFile(join(packageRoot, 'codex-package.json'))) {
      return { executablePath: current, pathDirs: existingDirs(join(packageRoot, 'codex-path')) };
    }

    // Legacy layout, still handled by the SDK this replaced. Cheap to keep; a
    // missing branch here would present as a bare "binary missing".
    const legacy = join(packageRoot, 'codex', binaryName);
    if (isFile(legacy)) {
      return { executablePath: legacy, pathDirs: existingDirs(join(packageRoot, 'path')) };
    }
  }

  throw new Error(
    `Codex: cannot locate ${platformPackage} under ${cockpitRoot}. Reinstall so npm fetches optional dependencies, or run: cockpit update`,
  );
}

function existingDirs(...dirs: string[]): string[] {
  return dirs.filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * The PATH key on Windows is a trap worth stating plainly: Windows treats
 * environment variable NAMES case-insensitively, but a JS object's keys are
 * case-sensitive. `process.env` may hand us `Path`, and writing `PATH` next to
 * it produces a child with TWO path variables whose winner is undefined.
 *
 * So: find whichever casing is actually present, prefer `Path` (what Windows
 * itself uses), and delete every other casing before writing.
 */
export function codexPathEnvKey(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return 'PATH';
  const matching = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  if (matching.includes('Path')) return 'Path';
  return matching[matching.length - 1] ?? 'PATH';
}

/** Prepend `pathDirs`, in place, onto whichever PATH key this platform uses. */
export function applyCodexPathDirs(
  env: Record<string, string>,
  pathDirs: string[],
  platform: NodeJS.Platform = process.platform,
): void {
  if (pathDirs.length === 0) return;
  const key = codexPathEnvKey(env, platform);
  if (platform === 'win32') {
    for (const k of Object.keys(env)) {
      if (k.toLowerCase() === 'path' && k !== key) delete env[k];
    }
  }
  const existing = (env[key] ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0 && !pathDirs.includes(entry));
  env[key] = [...pathDirs, ...existing].join(delimiter);
}
