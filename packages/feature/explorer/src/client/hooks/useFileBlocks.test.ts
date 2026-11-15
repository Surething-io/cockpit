import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';

// Model an already-mounted pending view. The real hook's request sequencing,
// coalescing and socket callbacks run; DOM rendering is outside this test.
const model = vi.hoisted(() => ({
  state: { state: 'ready', data: { crossFilePending: true } } as unknown,
  writes: [] as { state: string; data?: { crossFileRevision?: number } }[],
  socket: undefined as { enabled: boolean; onOpen: () => void; onMessage: (msg: unknown) => void } | undefined,
}));
vi.mock('react', () => ({
  useState: () => [model.state, (state: (typeof model.writes)[number]) => { model.writes.push(state); }],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
}));
vi.mock('@cockpit/shared-ui', () => ({ useWebSocket: (options: typeof model.socket) => { model.socket = options; } }));
vi.mock('@cockpit/effect-runtime', () => ({ BrowserRuntime: { runPromiseExit: (effect: Effect.Effect<unknown>) => Effect.runPromiseExit(effect) } }));
import { invalidateBlocksCache, useFileFunctions } from './useFileBlocks';

beforeEach(() => { model.writes = []; model.socket = undefined; });
afterEach(() => { invalidateBlocksCache(); vi.unstubAllGlobals(); });
const completion = { type: 'graphProgress', data: { cwd: '/repo', phase: 'done' } };
const response = (revision: number, pending = false) => Response.json({ crossFileRevision: revision, crossFilePending: pending });

describe('pending file projection handoff', () => {
  it('keeps symbol previews separate from graph requests and reads completion without starting another build', async () => {
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(2));
    vi.stubGlobal('fetch', fetch);
    const local = useFileFunctions('/repo', 'leaf.ts');
    const graph = useFileFunctions('/repo', 'leaf.ts', true);
    local.reload();
    graph.reload();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).not.toContain('relations=1');
    expect(String(fetch.mock.calls[1][0])).toContain('relations=1');
    model.socket!.onMessage(completion);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[2][0])).not.toContain('relations=1');
    expect(String(fetch.mock.calls[2][0])).not.toContain('refresh=1');
    finish(response(1));
    await vi.waitFor(() => expect(model.writes).toHaveLength(2));
  });

  it('checks the published revision when the socket opens after a missed completion', async () => {
    const fetch = vi.fn().mockResolvedValue(response(2));
    vi.stubGlobal('fetch', fetch);
    useFileFunctions('/repo', 'leaf.ts');
    expect(model.socket?.enabled).toBe(true);
    model.socket!.onOpen();
    await vi.waitFor(() => expect(model.writes).toEqual([{ state: 'ready', data: { crossFileRevision: 2, crossFilePending: false } }]));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).not.toContain('refresh=1');
  });

  it('does not coalesce a completion read with an older response or let that response overwrite it', async () => {
    let finishOld!: (response: Response) => void;
    const old = new Promise<Response>(resolve => { finishOld = resolve; });
    const fetch = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(response(2));
    vi.stubGlobal('fetch', fetch);
    useFileFunctions('/repo', 'leaf.ts');
    model.socket!.onOpen();
    model.socket!.onMessage({ type: 'graphProgress', data: { cwd: '/other', phase: 'done' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    model.socket!.onMessage(completion);
    await vi.waitFor(() => expect(model.writes.at(-1)?.data?.crossFileRevision).toBe(2));
    expect(fetch).toHaveBeenCalledTimes(2);
    finishOld(response(1, true));
    // Give the old fetch/effect/JSON callbacks time to settle too.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(model.writes).toHaveLength(1);
    expect(model.writes[0].data?.crossFileRevision).toBe(2);
  });
});
