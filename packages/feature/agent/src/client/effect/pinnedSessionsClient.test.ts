import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect, Stream } from 'effect';
import { IframeBus } from '@cockpit/effect-services';
import { savePinnedSessions } from './pinnedSessionsClient';

afterEach(() => vi.unstubAllGlobals());
const sessions = [{ cwd: '/project', sessionId: 'b' }, { cwd: '/project', sessionId: 'a' }];

describe('favorite save notifications', () => {
  it('waits for persistence before asking any window to reload the order', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const notifications: string[] = [];
    const bus = IframeBus.of({ publish: (topic) => Effect.sync(() => { notifications.push(topic.id); }), subscribe: () => Stream.empty });
    const saving = Effect.runPromise(savePinnedSessions(sessions).pipe(Effect.provideService(IframeBus, bus)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(notifications).toEqual([]);
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ sessions });
    finish(new Response('{}', { status: 200 }));
    await saving;
    expect(notifications).toEqual(['pinned-sessions-changed']);
  });

  it('does not broadcast a failed write as a successful reorder', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    const publish = vi.fn(() => Effect.void);
    const result = await Effect.runPromiseExit(savePinnedSessions(sessions).pipe(Effect.provideService(IframeBus, IframeBus.of({ publish, subscribe: () => Stream.empty }))));
    expect(result._tag).toBe('Failure');
    expect(publish).not.toHaveBeenCalled();
  });
});
