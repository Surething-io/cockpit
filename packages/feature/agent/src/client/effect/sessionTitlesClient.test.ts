import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Fiber } from 'effect';
import { loadSessionTitles } from './sessionTitlesClient';
import { acceptSessionTitle } from '../sessionTitleState';

afterEach(() => vi.unstubAllGlobals());

describe('initial session title batch', () => {
  it('uses one request and returns the current title when the response is stale', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const result = Effect.runPromise(loadSessionTitles('/project', ['batch-one', 'batch-two']));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const latest = { cwd: '/project', sessionId: 'batch-one', title: 'New native title', defaultTitle: 'New native title', customTitle: null, titleRevision: 0 };
    acceptSessionTitle(latest);
    release(Response.json({ titles: [{ ...latest, title: 'Old native title', defaultTitle: 'Old native title' }] }));
    expect(await result).toEqual([latest]);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ cwd: '/project', sessionIds: ['batch-one', 'batch-two'] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts the HTTP request when bootstrap is interrupted', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return new Promise<Response>(() => {});
    }));
    const fiber = Effect.runFork(loadSessionTitles('/project', ['interrupted']));
    await vi.waitFor(() => expect(signal).toBeDefined());
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
  });
});
