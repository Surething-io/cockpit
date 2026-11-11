import { afterEach, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { loadProjectState, markSessionRead } from './stateClient';
import * as agent from '@cockpit/feature-agent';
import { publishTopic } from '@cockpit/effect-react';

vi.mock('@cockpit/effect-react', () => ({ publishTopic: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });
const boundary = () => Response.json({ readBefore: 123 });

it('hydrates titles from the session-list response before returning the restored project', async () => {
  const titles = [{ cwd: '/bootstrap', sessionId: 'cached', title: 'Cached subject', defaultTitle: 'Cached subject', customTitle: null, titleRevision: 1 }];
  const state = { sessions: ['cached'], activeSessionId: 'cached', sessionTitles: titles };
  const accept = vi.spyOn(agent, 'acceptSessionTitles');
  const fetch = vi.fn(async () => Response.json(state));
  vi.stubGlobal('fetch', fetch);
  for (let i = 0; i < 3; i++) expect(await Effect.runPromise(loadProjectState('/bootstrap'))).toEqual(state);
  expect(accept).toHaveBeenCalledWith(titles);
  expect(accept).toHaveBeenCalledTimes(3);
  expect(fetch.mock.calls).toHaveLength(3);
});

it('attempts both stores and notifies the task list even if session clearing fails', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => init?.method
    ? new Response('{}', { status: url === '/api/global-state' ? 500 : 200 }) : boundary());
  vi.stubGlobal('fetch', fetch);
  expect(await Effect.runPromise(markSessionRead('/project', 'session', 'codex', () => true))).toBeNull();
  expect(fetch.mock.calls.filter(([, init]) => init?.method).map(([url]) => url))
    .toEqual(['/api/global-state', '/api/scheduled-tasks']);
  expect(publishTopic).toHaveBeenCalledTimes(1);
});
it('does not issue a queued read after the session becomes hidden', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await Effect.runPromise(markSessionRead('/project', 'session', undefined, () => false))).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(publishTopic).not.toHaveBeenCalled();
});
it('does not publish a successful task refresh for a failed task write', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => init?.method
    ? new Response('{}', { status: url === '/api/scheduled-tasks' ? 500 : 200 }) : boundary()));
  expect(await Effect.runPromise(markSessionRead('/project', 'session', undefined, () => true))).toBe(123);
  expect(publishTopic).not.toHaveBeenCalled();
});
it.each([-60_000, 60_000])('returns and sends server boundaries despite client clock offset %s', async (offset) => {
  vi.spyOn(Date, 'now').mockReturnValue(123 + offset);
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method ? new Response('{}') : boundary());
  vi.stubGlobal('fetch', fetch);
  expect(await Effect.runPromise(markSessionRead('/project', 'session', 'codex', () => true))).toBe(123);
  const writes = fetch.mock.calls.filter(([, init]) => init?.method).map(([, init]) => JSON.parse(init!.body as string));
  expect(writes[0].readBefore).toBe(123);
  expect(writes[1].fields.readBefore).toBe(123);
  expect(fetch.mock.calls.filter(([, init]) => !init?.method).every(([, init]) => init?.cache === 'no-store')).toBe(true);
});
it('does not send either write when leaving while its boundary is in flight', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let visible = true;
  const fetch = vi.fn(async () => { await held; return boundary(); });
  vi.stubGlobal('fetch', fetch);
  const result = Effect.runPromise(markSessionRead('/project', 'session', undefined, () => visible));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  visible = false; release();
  expect(await result).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(publishTopic).not.toHaveBeenCalled();
});
it('keeps the task side independent when the session boundary request fails', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => url.startsWith('/api/global-state')
    ? new Response('{}', { status: 500 }) : init?.method ? new Response('{}') : boundary());
  vi.stubGlobal('fetch', fetch);
  expect(await Effect.runPromise(markSessionRead('/project', 'session', undefined, () => true))).toBeNull();
  expect(fetch.mock.calls.some(([url, init]) => url === '/api/scheduled-tasks' && init?.method === 'PATCH')).toBe(true);
  expect(publishTopic).toHaveBeenCalledTimes(1);
});
