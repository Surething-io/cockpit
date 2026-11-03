import { statSync } from 'node:fs';
import { join } from 'node:path';

const isFile = (path: string): boolean => {
  try { return statSync(path).isFile(); }
  catch { return false; }
};

/** Plain paths survive both Next bundlers, matching the Codex resolver. */
export function resolveGrokBinary(
  root = process.env.COCKPIT_ROOT || process.cwd(),
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw new Error(`Grok: unsupported platform ${platform} (${arch})`);
  }
  const packageName = `@xai-official/grok-${platform}-${arch}`;
  const cliRoot = join(root, 'node_modules', '@xai-official', 'grok');
  const suffix = platform === 'win32' ? '.exe' : '';
  const candidates = [
    join(cliRoot, 'bin', `grok-native${suffix}`),
    join(root, 'node_modules', packageName, 'bin', `grok${suffix}`),
    join(cliRoot, 'node_modules', packageName, 'bin', `grok${suffix}`),
  ];
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  throw new Error(`Grok: cannot locate bundled ${packageName} under ${root}. Reinstall Cockpit with optional dependencies, or run: cockpit update`);
}
