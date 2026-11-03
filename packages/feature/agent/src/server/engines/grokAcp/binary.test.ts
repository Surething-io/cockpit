import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { resolveGrokBinary } from './binary';
import { GrokAcpClient } from './client';

const temporary: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'cockpit-grok-binary-'));
  temporary.push(path);
  return path;
}
afterEach(() => { vi.unstubAllEnvs(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('bundled Grok binary', () => {
  beforeEach(() => { vi.stubEnv('COCKPIT_ROOT', process.cwd()); });
  it('runs the pinned package binary without a global grok command', () => {
    const home = temp();
    const pkg = JSON.parse(readFileSync('node_modules/@xai-official/grok/package.json', 'utf8'));
    const env = { ...sanitizedSpawnEnv(), GROK_HOME: home };
    const version = execFileSync(resolveGrokBinary(), ['--no-auto-update', '--version'], { env, encoding: 'utf8' }).trim();
    expect(version).toMatch(new RegExp(`^grok ${pkg.version.replaceAll('.', '\\.')}\\b`));
    expect(JSON.parse(readFileSync('package.json', 'utf8')).dependencies['@xai-official/grok']).toBe(pkg.version);
  });

  it('negotiates ACP with the installed binary without login or model calls', async () => {
    const home = temp();
    const client = new GrokAcpClient({
      cwd: home, env: { ...sanitizedSpawnEnv(), GROK_HOME: home },
      onNotification: () => {}, onRequest: () => { throw new Error('No client capabilities advertised'); }, onClosed: () => {},
    });
    try {
      const initialized = await Effect.runPromise(Effect.promise(() => client.request('initialize', {
        protocolVersion: 2, info: { name: 'cockpit-test', version: '1' }, capabilities: {},
        clientInfo: { name: 'cockpit-test', version: '1' }, clientCapabilities: {}, _meta: { clientType: 'extension' },
      })).pipe(Effect.timeout('3 seconds')));
      expect([1, 2]).toContain(initialized.protocolVersion);
      expect(initialized.agentCapabilities ?? initialized.capabilities).toBeDefined();
    } finally {
      client.dispose(true);
      await client.exited;
    }
  });

  it.each(['darwin', 'linux', 'win32'] as const)('resolves prepared and nested %s binaries from the installation root', (platform) => {
    const root = temp();
    const suffix = platform === 'win32' ? '.exe' : '';
    const cli = join(root, 'node_modules', '@xai-official', 'grok');
    const nested = join(cli, 'node_modules', '@xai-official', `grok-${platform}-arm64`, 'bin', `grok${suffix}`);
    mkdirSync(join(nested, '..'), { recursive: true });
    writeFileSync(nested, 'native-placeholder');
    expect(resolveGrokBinary(root, platform, 'arm64')).toBe(nested);
    const prepared = join(cli, 'bin', `grok-native${suffix}`);
    mkdirSync(join(prepared, '..'), { recursive: true });
    writeFileSync(prepared, 'prepared-placeholder');
    expect(resolveGrokBinary(root, platform, 'arm64')).toBe(prepared);
    vi.stubEnv('COCKPIT_ROOT', root);
    expect(resolveGrokBinary(undefined, platform, 'arm64')).toBe(prepared);
  });

  it('fails clearly when bundled files are absent instead of falling back to PATH', () => {
    const root = temp();
    expect(() => resolveGrokBinary(root)).toThrow(/cannot locate bundled @xai-official\/grok-.*Reinstall Cockpit/);
    expect(() => resolveGrokBinary(root, 'freebsd', 'x64')).toThrow(/unsupported platform/);
  });
});
