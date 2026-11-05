import { beforeAll, afterAll, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let home: string;
let globalApi: typeof import('./api/global-state');
let tasksApi: typeof import('./api/scheduled-tasks');
let runs: typeof import('./sessionRunHub');
const uuid = '0198abcd-1234-5678-9abc-0123456789ab';
const rollout = `/tmp/rollout-${uuid}.jsonl`;
function seed(time: number, status = 'unread', sessionId = 'a', engine = 'claude') {
  writeFileSync(join(home, 'state.json'), JSON.stringify({ sessions: [
    { cwd: home, sessionId, engine, status, lastActive: time, title: 'Keep title' },
  ] }));
  writeFileSync(join(home, 'scheduled-tasks.json'), JSON.stringify([
    { id: 'task-a', cwd: home, sessionId, engine, unread: true, lastFiredAt: time, createdAt: 1,
      message: 'test', type: 'once', paused: true, nextFireTime: Date.now() + 86400000 },
    { id: 'foreign', cwd: `${home}/other`, sessionId, engine, unread: true, lastFiredAt: time, createdAt: 1,
      message: 'test', type: 'once', paused: true, nextFireTime: Date.now() + 86400000 },
  ]));
}
async function readAt(readBefore: number, sessionId = 'a', engine = 'claude') {
  const request = (body: unknown) => new Request('http://localhost/api/test', { method: 'POST', body: JSON.stringify(body) });
  const a = await globalApi.POST(request({ cwd: home, sessionId, engine, action: 'status', status: 'normal', readBefore }));
  const b = await tasksApi.PATCH(request({ action: 'markReadBySessionId', fields: { cwd: home, sessionId, engine, readBefore } }));
  expect(a.status).toBe(200); expect(b.status).toBe(200);
  return {
    session: JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).sessions[0],
    tasks: JSON.parse(readFileSync(join(home, 'scheduled-tasks.json'), 'utf8')) as Array<{id: string; unread: boolean}>,
  };
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'cockpit-read-boundary-'));
  process.env.COCKPIT_HOME = home;
  seed(100);
  globalApi = await import('./api/global-state');
  tasksApi = await import('./api/scheduled-tasks');
  runs = await import('./sessionRunHub');
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); delete process.env.COCKPIT_HOME; });

it('keeps results produced after the visit and clears them on a later visit', async () => {
  seed(300);
  let disk = await readAt(200);
  expect(disk.session.status).toBe('unread');
  expect(disk.tasks.find((t) => t.id === 'task-a')?.unread).toBe(true);
  disk = await readAt(400);
  expect(disk.session).toMatchObject({ status: 'normal', lastActive: 300, title: 'Keep title' });
  expect(disk.tasks.find((t) => t.id === 'task-a')?.unread).toBe(false);
  expect(disk.tasks.find((t) => t.id === 'foreign')?.unread).toBe(true);
});
it('preserves running status but can acknowledge an old result left as loading', async () => {
  seed(100, 'loading');
  runs.startRun('a', home, 'test', 'test-run', 'claude');
  try { expect((await readAt(200)).session.status).toBe('loading'); }
  finally { runs.markRunIdle('a'); runs.releaseRun('a'); }
  expect((await readAt(200)).session.status).toBe('normal');
});
it('matches Codex read aliases within the selected project and engine', async () => {
  seed(100, 'unread', rollout, 'codex');
  expect((await readAt(200, uuid, 'claude')).session.status).toBe('unread');
  const disk = await readAt(200, uuid, 'codex');
  expect(disk.session.status).toBe('normal');
  expect(disk.tasks.find((t) => t.id === 'task-a')?.unread).toBe(false);
  expect(disk.tasks.find((t) => t.id === 'foreign')?.unread).toBe(true);
});
it('rejects malformed read cutoffs on both existing endpoints', async () => {
  const a = await globalApi.POST(new Request('http://localhost/api/global-state', { method: 'POST',
    body: JSON.stringify({ cwd: home, sessionId: 'a', action: 'status', readBefore: 'later' }) }));
  const b = await tasksApi.PATCH(new Request('http://localhost/api/scheduled-tasks', { method: 'PATCH',
    body: JSON.stringify({ action: 'markReadBySessionId', fields: { sessionId: 'a', readBefore: 'later' } }) }));
  expect(a.status).toBe(400); expect(b.status).toBe(400);
});

it('resolves the engine of a legacy Codex record before matching its UUID', async () => {
  seed(100, 'unread', rollout, 'codex');
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  delete state.sessions[0].engine;
  writeFileSync(join(home, 'state.json'), JSON.stringify(state));
  const { getSessionFilePath } = await import('@cockpit/shared-utils');
  const { dirname } = await import('node:path');
  const projectState = getSessionFilePath(home);
  mkdirSync(dirname(projectState), { recursive: true });
  writeFileSync(projectState, JSON.stringify({ engines: { [rollout]: 'codex' } }));
  const disk = await readAt(200, uuid, 'codex');
  expect(disk.session.status).toBe('normal');
  expect(disk.session.engine).toBeUndefined();
  expect(disk.tasks.find((t) => t.id === 'task-a')?.unread).toBe(false);
});
it('provides uncached server read boundaries on both existing endpoints', async () => {
  const before = Date.now();
  for (const api of [globalApi, tasksApi]) {
    const response = await api.GET(new Request('http://localhost/api/test?readBoundary=1'));
    const result = await response.json();
    expect(result.readBefore).toBeGreaterThanOrEqual(before);
    expect(result.readBefore).toBeLessThanOrEqual(Date.now());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});
