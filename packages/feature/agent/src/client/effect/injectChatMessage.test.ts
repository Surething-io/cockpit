// Mid-run input must keep the selected engine when a run closes before dispatch.
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { injectChatMessage } from './agentClient';

afterEach(() => vi.unstubAllGlobals());

describe('chat input delivery', () => {
  it.each(['ollama', 'deepseek', 'kimi', 'glm'] as const)('routes %s follow-ups through their provider endpoint', async (engine) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ injected: false, runKey: 'new-run' }));
    vi.stubGlobal('fetch', fetch);
    const body = { prompt: 'continue', sessionId: 'same-session', inject: true, model: 'chosen-model' };
    await Effect.runPromise(injectChatMessage(engine, body));
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(`/api/chat/${engine}`);
    expect(JSON.parse(options.body)).toEqual(body);
  });

  it('keeps Claude input on its native endpoint without introducing model overrides', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ injected: true }));
    vi.stubGlobal('fetch', fetch);
    await Effect.runPromise(injectChatMessage('claude', { prompt: 'continue', inject: true }));
    expect(fetch.mock.calls[0][0]).toBe('/api/chat');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).not.toHaveProperty('model');
  });

  it('retains the actionable server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Pi model is unavailable' }, { status: 400 })));
    const result = await Effect.runPromise(Effect.either(injectChatMessage('kimi', {})));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left.message).toBe('Pi model is unavailable');
  });
});
