/**
 * Detect whether the bundled agent CLIs actually landed for the current platform.
 *
 * The bundled chat engines run a native binary that ships as an OPTIONAL dependency, one sub-package
 * per platform:
 *
 *   Claude  @anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude
 *   Codex   @openai/codex-<platform>-<arch>/vendor/<target-triple>/bin/codex
 *   Grok    @xai-official/grok/bin/grok-native[.exe] (extracted at install time)
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
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { brotliDecompressSync } from 'zlib';

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

/** Resolve only the pinned package; never use the CLI's mutable ~/.grok/bin copy. */
export function bundledGrokBinary() {
  const cliDir = packageDir('@xai-official/grok');
  if (!cliDir) return null;
  const binary = join(cliDir, 'bin', process.platform === 'win32' ? 'grok-native.exe' : 'grok-native');
  return existsSync(binary) ? binary : null;
}

/** Upstream extracts beside its launcher only on Unix/npm; Windows needs this too. */
export function prepareGrokBinary() {
  if (bundledGrokBinary()) return;
  const cliDir = packageDir('@xai-official/grok');
  if (!cliDir) return;
  const cliRequire = createRequire(join(cliDir, 'package.json'));
  const platformPackage = `@xai-official/grok-${process.platform}-${process.arch}`;
  const platformDir = dirname(cliRequire.resolve(`${platformPackage}/package.json`));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const source = join(platformDir, 'bin', `grok${suffix}`);
  const target = join(cliDir, 'bin', `grok-native${suffix}`);
  const temp = `${target}.tmp.${process.pid}`;
  const bytes = existsSync(`${source}.br`) ? brotliDecompressSync(readFileSync(`${source}.br`)) : readFileSync(source);
  writeFileSync(temp, bytes, { mode: 0o755 });
  if (process.platform !== 'win32') chmodSync(temp, 0o755);
  renameSync(temp, target);
}

/**
 * Names of the agent CLIs whose native binary is missing.
 *
 * Returns [] when everything resolved. Callers report the names verbatim, which is why this
 * returns labels rather than booleans: every call site has to tell the user WHICH engine is
 * broken, and deriving that from separate booleans at multiple call sites is the same sentence written
 * four times.
 */
export function missingAgentBinaries() {
  const missing = [];
  if (!hasClaudeBinary()) missing.push('Claude');
  if (!hasCodexBinary()) missing.push('Codex');
  if (!bundledGrokBinary()) missing.push('Grok');
  return missing;
}
