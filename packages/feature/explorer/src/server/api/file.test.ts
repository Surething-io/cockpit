import { afterAll, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { mkdtempSync, rmSync, truncateSync, writeFileSync, symlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Run the actual route program without booting the server's DB/WS layers.
vi.mock('@cockpit/effect-runtime/server', () => ({
  handler: (program: (request: Request) => Effect.Effect<Response, unknown>) =>
    (request: Request) => Effect.runPromise(program(request)),
  ok: (data: unknown) => Response.json(data),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { GET } from './file';
import { GET as getText } from './files/text';
import { GET as getStat } from './files/stat';
import { GET as getRaw } from './files/read';

const directory = mkdtempSync(join(tmpdir(), 'cockpit-file-route-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const read = (file: string) => GET(new Request(`http://localhost/api/file?path=${encodeURIComponent(file)}`));
const projectRead = (file: string) => getText(new Request(`http://localhost/api/files/text?cwd=${encodeURIComponent(directory)}&path=${encodeURIComponent(file)}`));
const projectStat = (file: string) => getStat(new Request(`http://localhost/api/files/stat?cwd=${encodeURIComponent(directory)}&path=${encodeURIComponent(file)}`));

describe('generic file preview reads', () => {
  it.each(['review.APElEH', 'README', 'source.ts', 'source.html', 'plain.a', 'plain.class', 'plain.db'])('returns %s literally without an extension allowlist', async (name) => {
    const file = join(directory, name);
    const content = '# literal\n<script>source only</script>\n';
    writeFileSync(file, content);
    const response = await read(file);
    expect(response.status).toBe(200);
    expect((await response.json()).content).toBe(content);
    const projectResponse = await projectRead(file);
    expect(projectResponse.status).toBe(200);
    expect((await projectResponse.json()).content).toBe(content);
  });

  it('returns an empty string for an empty document', async () => {
    const file = join(directory, 'empty');
    writeFileSync(file, '');
    expect((await (await read(file)).json()).content).toBe('');
  });

  it('rejects binary content even with a random suffix', async () => {
    const file = join(directory, 'binary.APElEH');
    writeFileSync(file, Buffer.from([0, 1, 2, 3]));
    const response = await read(file);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('binary');
  });

  it('checks NUL beyond the sampled prefix in both text readers', async () => {
    const file = join(directory, 'tail-nul.review');
    writeFileSync(file, 'A'.repeat(1000) + '\0\u0001\u0002');
    expect((await read(file)).status).toBe(409);
    expect((await projectRead(file)).status).toBe(409);
  });

  it.each(['absolute', 'project'])('bounds %s reads when the file grows after stat and closes its descriptor', async (reader) => {
    const file = join(directory, 'growing-' + reader);
    writeFileSync(file, 'old');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const close = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const descriptor = await actual.open(...args);
      const originalStat = descriptor.stat.bind(descriptor);
      const originalClose = descriptor.close.bind(descriptor);
      vi.spyOn(descriptor, 'stat').mockImplementationOnce(async () => {
        const before = await originalStat();
        truncateSync(file, 10 * 1024 * 1024 + 1);
        return before;
      });
      vi.spyOn(descriptor, 'close').mockImplementation(async () => {
        close();
        await originalClose();
      });
      return descriptor;
    });
    const response = await (reader === 'absolute' ? read(file) : projectRead(file));
    expect(response.status).toBe(413);
    expect(close).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')('rejects FIFOs and symlinks to FIFOs without waiting for a writer', async () => {
    const fifo = join(directory, 'pipe.png');
    const alias = join(directory, 'pipe-link');
    execFileSync('mkfifo', [fifo]);
    symlinkSync(fifo, alias);
    for (const file of [fifo, alias]) {
      const stat = await projectStat(file);
      expect(stat.status).toBe(409);
      expect((await stat.json()).isFile).toBe(false);
      expect((await projectRead(file)).status).toBe(409);
      expect((await read(file)).status).toBe(400);
      const raw = await getRaw(new Request(`http://localhost/api/files/read?cwd=${encodeURIComponent(directory)}&path=${encodeURIComponent(file)}`));
      expect(raw.status).toBe(409);
    }
  });

  it('keeps dedicated image and PDF byte streams', async () => {
    for (const name of ['image.png', 'document.pdf']) {
      const file = join(directory, name);
      const bytes = Buffer.from([0, 1, 2, 3]);
      writeFileSync(file, bytes);
      const response = await getRaw(new Request(`http://localhost/api/files/read?cwd=${encodeURIComponent(directory)}&path=${encodeURIComponent(file)}`));
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
  });

  it('rejects directories and oversized documents', async () => {
    expect((await read(directory)).status).toBe(409);
    const file = join(directory, 'large');
    writeFileSync(file, '');
    truncateSync(file, 10 * 1024 * 1024 + 1);
    expect((await read(file)).status).toBe(413);
  });
});
