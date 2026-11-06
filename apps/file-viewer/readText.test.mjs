import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'cockpit-text-preview-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const { code } = transformSync(readFileSync(new URL('./app.jsx', import.meta.url), 'utf8'), { loader: 'jsx' });
const context = vm.createContext({
  React: { createElement: () => null },
  ReactDOM: { createRoot: () => ({ render() {} }) },
  document: { getElementById: () => null },
  cockpit: {
    cwd: directory,
    bash: async (command) => {
      const result = spawnSync('bash', ['-c', command], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (result.error) throw result.error;
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  },
});
vm.runInContext(code + '\nglobalThis.readTextProbe = readText; globalThis.resolveViewerPathProbe = resolveViewerPath;', context);
const readText = context.readTextProbe;

describe('file-viewer public SDK text reads', () => {
  it('reads a random-suffix file and safely quotes its path', async () => {
    const file = join(directory, "review ' notes.APElEH");
    const text = '请审查\n  <script>literal</script>\n';
    writeFileSync(file, text);
    expect(await readText(file)).toBe(text);
  });

  it('reads an empty file without an extension', async () => {
    const file = join(directory, 'EMPTY');
    writeFileSync(file, '');
    expect(await readText(file)).toBe('');
  });

  it('reads a home-relative document using the public SDK resolved cwd', async () => {
    const file = join(directory, 'home-notes');
    writeFileSync(file, 'resolved home document');
    const resolved = context.resolveViewerPathProbe('~/notes/home-notes');
    expect(resolved).toBe(file);
    expect(await readText(resolved)).toBe('resolved home document');
  });

  it('rejects a NUL beyond the sampled prefix', async () => {
    const file = join(directory, 'tail-nul');
    writeFileSync(file, 'A'.repeat(1000) + '\0');
    await expect(readText(file)).rejects.toThrow('binary');
  });

  it('rejects binary bytes instead of displaying them as source', async () => {
    const file = join(directory, 'random.data');
    writeFileSync(file, Buffer.from([1, 0, 2, 3]));
    await expect(readText(file)).rejects.toThrow('binary');
  });

  it('rejects oversized files before returning their content', async () => {
    const file = join(directory, 'large');
    writeFileSync(file, '');
    truncateSync(file, 10 * 1024 * 1024 + 1);
    await expect(readText(file)).rejects.toThrow('File too large');
  });

  it('rejects directories and reports missing files', async () => {
    await expect(readText(directory)).rejects.toThrow('Not a regular file');
    await expect(readText(join(directory, 'missing'))).rejects.toThrow('ENOENT');
  });
});
