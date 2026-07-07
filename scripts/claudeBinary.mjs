/**
 * Detect whether the Claude Agent SDK's platform-specific native `claude`
 * binary is actually installed for the current platform.
 *
 * The binary ships as an OPTIONAL dependency of `@anthropic-ai/claude-agent-sdk`
 * (one sub-package per platform, e.g. `-darwin-arm64`). npm can silently skip it
 * during an in-place `npm i -g` upgrade when the SDK version bumps via its caret
 * range, leaving the SDK unable to spawn `claude` at runtime with:
 *   "Native CLI binary for <platform>-<arch> not found. Reinstall
 *    @anthropic-ai/claude-agent-sdk without --omit=optional, ..."
 *
 * `cockpit update`, postinstall, and CLI startup all call this so the problem is
 * surfaced (and repaired) BEFORE the user hits the runtime error mid-chat.
 */
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);

/** @returns {boolean} true if the current platform's `claude` binary resolves. */
export function hasClaudeBinary() {
  const base = `${process.platform}-${process.arch}`;
  // linux ships glibc and musl variants under distinct package names.
  const variants = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  for (const variant of variants) {
    try {
      const pkgJson = require.resolve(
        `@anthropic-ai/claude-agent-sdk-${variant}/package.json`,
      );
      const bin = join(dirname(pkgJson), 'claude');
      if (existsSync(bin) || existsSync(`${bin}.exe`)) return true;
    } catch {
      // Not resolvable → this variant's sub-package isn't installed.
    }
  }
  return false;
}
