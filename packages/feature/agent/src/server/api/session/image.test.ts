import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores = new Map<string, { engine: string; sessionPath: string }>();
vi.mock('./sessionStore', () => ({ resolveSessionPath: async (_cwd: string, id: string) => stores.get(id) ?? null }));

let GET: typeof import('./image').GET;
let dir: string;
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
const uploadPath = '/tmp/already-deleted-upload.png';
const entry = (path: string, bytes = data) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
  { type: 'input_text', text: `<image name=[Image #1] path="${path}">` },
  { type: 'input_image', image_url: `data:image/png;base64,${bytes}` },
  { type: 'input_text', text: '</image>' },
] } });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cockpit-session-image-'));
  for (const [id, rows] of [
    ['main', [entry(uploadPath), ...Array.from({ length: 25 }, () => ({ type: 'event_msg', payload: { type: 'task_complete' } }))]],
    ['other', [entry('/tmp/other.png')]],
    ['ambiguous', [entry(uploadPath), entry(uploadPath, 'ZGVm')]],
  ] as const) {
    const sessionPath = join(dir, `${id}.jsonl`);
    await writeFile(sessionPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    stores.set(id, { sessionPath, engine: 'codex' });
  }
  ({ GET } = await import('./image'));
}, 30_000);
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const request = (sessionId: string, path = uploadPath) => GET(new Request(`http://test.local/api/session/image?${new URLSearchParams({ cwd: '/project', sessionId, path })}`));

describe('session upload image endpoint', () => {
  it('restores exact bytes from earlier user input without the temporary file', async () => {
    const response = await request('main');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(data, 'base64'));
  });

  it('does not resolve another session or a same-name path', async () => {
    expect((await request('other')).status).toBe(404);
    expect((await request('missing')).status).toBe(404);
    expect((await request('main', '/elsewhere/already-deleted-upload.png')).status).toBe(404);
  });

  it('rejects conflicting associations and invalid parameters', async () => {
    expect((await request('ambiguous')).status).toBe(404);
    expect((await request('main', '../relative.png')).status).toBe(400);
    expect((await GET(new Request('http://test.local/api/session/image'))).status).toBe(400);
  });
});
