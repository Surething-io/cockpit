/**
 * Detect whether the bundled agent CLIs actually landed for the current platform.
 *
 * Both chat engines run a native binary that ships as an OPTIONAL dependency, one sub-package
 * per platform:
 *
 *   Claude  @anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude
 *   Codex   @openai/codex-<platform>-<arch>/vendor/<target-triple>/bin/codex
 *
 * npm can silently skip an optional sub-package during an in-place `npm i -g` upgrade when the
 * parent's version bumps. The install still exits 0, so nothing notices until a message is sent:
 *
 *   Claude  hard failure — the SDK throws "Native CLI binary for <platform> not found".
 *           It performs no PATH lookup, so there is no second chance.
 *   Codex   worse, because it looks like success — the engine falls back to whatever `codex`
 *           is on PATH, which is an unpinned version the SDK was never paired with.
 *
 * `cockpit update`, postinstall, and CLI startup all call this so the problem is surfaced (and
 * repaired) BEFORE the user hits it mid-chat.
 */
import { createRequire } from 'module';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);

/** Resolve a platform sub-package's directory, or null when it is not installed. */
function packageDir(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/** Whether the Claude SDK's native binary resolves. */
function hasClaudeBinary() {
  const base = `${process.platform}-${process.arch}`;
  // linux ships glibc and musl variants under distinct package names.
  const variants = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  for (const variant of variants) {
    const dir = packageDir(`@anthropic-ai/claude-agent-sdk-${variant}`);
    if (!dir) continue;
    const bin = join(dir, 'claude');
    if (existsSync(bin) || existsSync(`${bin}.exe`)) return true;
  }
  return false;
}

/**
 * Whether the Codex CLI's native binary resolves.
 *
 * The binary sits under a Rust target triple (`vendor/aarch64-apple-darwin/bin/codex`). That
 * triple is codex-sdk's own internal layout, so this scans `vendor/` rather than reproducing the
 * platform->triple table — one less private convention to stay in sync with.
 *
 * Codex has no musl split; the six platform packages map straight off platform-arch.
 */
function hasCodexBinary() {
  const dir = packageDir(`@openai/codex-${process.platform}-${process.arch}`);
  if (!dir) return false;
  const vendor = join(dir, 'vendor');
  try {
    return readdirSync(vendor).some((target) => {
      const bin = join(vendor, target, 'bin', 'codex');
      return existsSync(bin) || existsSync(`${bin}.exe`);
    });
  } catch {
    return false;
  }
}

/**
 * Names of the agent CLIs whose native binary is missing.
 *
 * Returns [] when everything resolved. Callers report the names verbatim, which is why this
 * returns labels rather than booleans: every call site has to tell the user WHICH engine is
 * broken, and deriving that from two booleans at four call sites is the same sentence written
 * four times.
 */
export function missingAgentBinaries() {
  const missing = [];
  if (!hasClaudeBinary()) missing.push('Claude');
  if (!hasCodexBinary()) missing.push('Codex');
  return missing;
}
