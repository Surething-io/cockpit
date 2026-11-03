import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const temporary = [];
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('Grok install-time binary preparation', () => {
  it.each([
    ['darwin', false, true], ['linux', false, false], ['win32', true, true],
  ])('extracts %s platform binaries inside the package', (platform, nested, compressed) => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit grok install '));
    temporary.push(root);
    const scripts = join(root, 'scripts');
    mkdirSync(scripts);
    copyFileSync(new URL('./agentBinaries.mjs', import.meta.url), join(scripts, 'agentBinaries.mjs'));
    const cli = join(root, 'node_modules', '@xai-official', 'grok');
    const platformDir = join(nested ? join(cli, 'node_modules') : join(root, 'node_modules'), '@xai-official', `grok-${platform}-arm64`);
    mkdirSync(join(cli, 'bin'), { recursive: true });
    mkdirSync(join(platformDir, 'bin'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), '{"name":"@xai-official/grok","version":"1.0.70"}');
    writeFileSync(join(platformDir, 'package.json'), '{}');
    const name = platform === 'win32' ? 'grok.exe' : 'grok';
    const source = join(platformDir, 'bin', name + (compressed ? '.br' : ''));
    writeFileSync(source, compressed ? brotliCompressSync(Buffer.from('native binary bytes')) : 'native binary bytes');
    const code = `
      import { prepareGrokBinary, bundledGrokBinary, missingAgentBinaries } from ${JSON.stringify(pathToFileURL(join(scripts, 'agentBinaries.mjs')).href)};
      Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
      Object.defineProperty(process, 'arch', { value: 'arm64' });
      if (!missingAgentBinaries().includes('Grok')) throw new Error('Missing native binary was not detected');
      prepareGrokBinary();
      prepareGrokBinary();
      console.log(JSON.stringify({ path: bundledGrokBinary(), missing: missingAgentBinaries() }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
    expect(result.path).toBe(join(realpathSync(cli), 'bin', platform === 'win32' ? 'grok-native.exe' : 'grok-native'));
    expect(readFileSync(result.path, 'utf8')).toBe('native binary bytes');
    expect(result.missing).not.toContain('Grok');
  });
});
