import { beforeAll, describe, expect, it, vi } from 'vitest';

const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../engines/orchestrator', () => ({ dispatchChat: dispatch }));

let routes: { name: string; post: (request: Request) => Promise<Response> }[];
beforeAll(async () => {
  routes = [
    { name: 'claude', post: (await import('./chat')).POST },
    { name: 'codex', post: (await import('./chat/codex')).POST },
    { name: 'grok', post: (await import('./chat/grok')).POST },
    { name: 'ollama', post: (await import('./chat/ollama')).POST },
    { name: 'deepseek', post: (await import('./chat/deepseek')).POST },
    { name: 'kimi', post: (await import('./chat/kimi')).POST },
    { name: 'glm', post: (await import('./chat/glm')).POST },
  ];
}, 30000);

describe('chat admission HTTP contract', () => {
  it.each(['claude', 'codex', 'grok', 'ollama', 'deepseek', 'kimi', 'glm'])('%s preserves the server run start', async (name) => {
    dispatch.mockResolvedValue({ ok: true, runKey: 'run', sessionId: 'session', startedAt: 1700000000000 });
    const response = await routes.find((route) => route.name === name)!.post(new Request('http://local/api/chat', {
      method: 'POST', body: JSON.stringify({ prompt: 'Hello' }), headers: { 'Content-Type': 'application/json' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runKey: 'run', sessionId: 'session', startedAt: 1700000000000 });
  });
});
