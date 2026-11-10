import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { PiThinkingOptions } from '../../../shared/piThinking';

// Keep configuration local while exercising the real resolver, route and native storage.
vi.mock('../../../effect/piThinkingLive', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../effect/piThinkingLive')>(),
  loadPiEngineConfig: (engine: string) => Effect.succeed({ engine, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'test' }),
}));

let home: string;
let GET: typeof import('./thinking').GET;
let offFile: string;
const previousHome = process.env.COCKPIT_HOME;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'cockpit-thinking-route-'));
  process.env.COCKPIT_HOME = home;
  await mkdir(join(home, 'pi'));
  const { getPiSessionsDir } = await import('@cockpit/shared-utils');
  for (const [id, engine, model, level] of [
    ['off-session', 'deepseek', 'deepseek-flash', 'off'],
    ['max-session', 'deepseek', 'deepseek-flash', 'max'],
    ['glm-off', 'glm', 'glm-4.7', 'off'],
  ] as const) {
    const manager = SessionManager.create(home, getPiSessionsDir(home), { id });
    manager.appendModelChange(engine, model);
    manager.appendThinkingLevelChange(level);
    manager.appendMessage({ role: 'user', content: 'Saved conversation', timestamp: Date.now() });
    if (id === 'off-session') offFile = manager.getSessionFile()!;
  }
  ({ GET } = await import('./thinking'));
}, 30000);

afterAll(async () => {
  const { AppRuntime } = await import('@cockpit/effect-runtime/server');
  await AppRuntime.dispose();
  if (home) await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COCKPIT_HOME;
  else process.env.COCKPIT_HOME = previousHome;
});

const query = async (engine: string, model: string, sessionId: string): Promise<PiThinkingOptions> => {
  const response = await GET(new Request(`http://local/api/pi/thinking?${new URLSearchParams({ engine, model, sessionId, cwd: home })}`));
  expect(response.status).toBe(200);
  return response.json();
};

it('keeps a valid saved choice when querying another model without rewriting the session', async () => {
  const before = await readFile(offFile);
  expect((await query('deepseek', 'deepseek-flash', 'off-session')).selectedLevel).toBe('off');
  expect((await query('deepseek', 'deepseek-v4-pro', 'off-session')).selectedLevel).toBe('off');
  expect((await query('deepseek', 'deepseek-v4-pro', 'max-session')).selectedLevel).toBe('max');
  expect(await readFile(offFile)).toEqual(before);
});

it('uses the new default for unsupported settings and keeps session/provider boundaries', async () => {
  expect((await query('glm', 'glm-5.3', 'glm-off')).selectedLevel).toBe('high');
  expect((await query('deepseek', 'deepseek-v4-pro', 'missing-session')).selectedLevel).toBe('high');
  expect((await query('glm', 'glm-5.2', 'max-session')).selectedLevel).toBe('high');
});
