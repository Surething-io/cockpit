import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { delimiter } from 'path';
import {
  resolveCodexBinary,
  codexTargetTriple,
  codexPathEnvKey,
  applyCodexPathDirs,
} from './binary';

describe('codexTargetTriple', () => {
  it('maps the shipped platform matrix', () => {
    expect(codexTargetTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(codexTargetTriple('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(codexTargetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-musl');
    expect(codexTargetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(codexTargetTriple('win32', 'arm64')).toBe('aarch64-pc-windows-msvc');
  });

  it('returns null rather than guessing for an unsupported pair', () => {
    expect(codexTargetTriple('freebsd' as NodeJS.Platform, 'x64')).toBeNull();
    expect(codexTargetTriple('darwin', 'ia32')).toBeNull();
  });
});

describe('resolveCodexBinary', () => {
  it('finds a runnable CLI whose version matches the installed package', () => {
    const bin = resolveCodexBinary();
    const version = execFileSync(bin.executablePath, ['--version'], { encoding: 'utf8' }).trim();
    expect(version).toMatch(/^codex-cli \d+\.\d+\.\d+/);
  });

  /**
   * Production reads COCKPIT_ROOT (server.mjs stamps it with the install dir);
   * only dev falls through to cwd. Pinning it here means the branch the shipped
   * build actually takes is the one under test.
   */
  it('resolves from COCKPIT_ROOT when it is set', () => {
    const previous = process.env.COCKPIT_ROOT;
    process.env.COCKPIT_ROOT = process.cwd();
    try {
      expect(resolveCodexBinary().executablePath).toContain('node_modules');
    } finally {
      if (previous === undefined) delete process.env.COCKPIT_ROOT;
      else process.env.COCKPIT_ROOT = previous;
    }
  });

  it('names the package it could not find, and where it looked', () => {
    const previous = process.env.COCKPIT_ROOT;
    process.env.COCKPIT_ROOT = '/nonexistent-cockpit-root';
    try {
      expect(() => resolveCodexBinary()).toThrow(/cannot locate @openai\/codex-.*nonexistent-cockpit-root/);
    } finally {
      if (previous === undefined) delete process.env.COCKPIT_ROOT;
      else process.env.COCKPIT_ROOT = previous;
    }
  });
});

describe('applyCodexPathDirs', () => {
  it('prepends onto PATH off Windows', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    applyCodexPathDirs(env, ['/vendor/rg'], 'darwin');
    expect(env.PATH).toBe(`/vendor/rg${delimiter}/usr/bin`);
  });

  it('is a no-op when there are no sidecar dirs', () => {
    const env: Record<string, string> = { PATH: '/usr/bin' };
    applyCodexPathDirs(env, [], 'darwin');
    expect(env.PATH).toBe('/usr/bin');
  });

  /**
   * The bug this guards: Windows env var NAMES are case-insensitive but JS
   * object keys are not, so writing `PATH` beside an existing `Path` hands the
   * child two path variables and lets the OS pick.
   */
  it('collapses every PATH casing into the one Windows itself uses', () => {
    const env: Record<string, string> = { Path: 'C:\\a', PATH: 'C:\\stale', path: 'C:\\older', X: 'keep' };
    expect(codexPathEnvKey(env, 'win32')).toBe('Path');
    applyCodexPathDirs(env, ['C:\\rg'], 'win32');
    expect(Object.keys(env).filter((k) => k.toLowerCase() === 'path')).toEqual(['Path']);
    expect(env.Path.startsWith('C:\\rg')).toBe(true);
    expect(env.X).toBe('keep');
  });

  it('falls back to PATH when no casing is present at all', () => {
    expect(codexPathEnvKey({}, 'win32')).toBe('PATH');
  });

  it('does not duplicate a sidecar dir already on PATH', () => {
    const env: Record<string, string> = { PATH: `/vendor/rg${delimiter}/usr/bin` };
    applyCodexPathDirs(env, ['/vendor/rg'], 'darwin');
    expect(env.PATH).toBe(`/vendor/rg${delimiter}/usr/bin`);
  });
});
