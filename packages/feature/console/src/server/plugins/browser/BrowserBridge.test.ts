import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { toShortId } from '@cockpit/shared-utils';
import {
  dispatchBrowserCommand,
  dropExtensionTabs,
  getBrowserHealth,
  listBrowsers,
  registerBrowser,
  resolvePendingRequest,
  syncExtensionTabs,
  unregisterBrowser,
  unregisterBubbleSocket,
} from './BrowserBridge';
import { registerExtension, unregisterExtension } from './ExtensionBridge';

type Msg = Record<string, unknown> & { reqId?: string; type?: string };

/** A fake `ws` socket whose replies are produced by `respond`. */
function fakeSocket(respond: (msg: Msg) => { ok: boolean; data?: unknown; error?: string; code?: string } | null) {
  const sent: Msg[] = [];
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send(raw: string) {
      const msg = JSON.parse(raw) as Msg;
      sent.push(msg);
      const r = respond(msg);
      if (r && msg.reqId) queueMicrotask(() => resolvePendingRequest(msg.reqId!, r.ok, r.data, r.error, r.code));
    },
  };
  return { ws: ws as unknown as WebSocket, sent };
}

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function addExtension(respond: Parameters<typeof fakeSocket>[0]) {
  const sock = fakeSocket(respond);
  const id = registerExtension(sock.ws);
  cleanups.push(() => { unregisterExtension(id); dropExtensionTabs(id); });
  return { id, ...sock };
}

function addBubble(fullId: string, respond: Parameters<typeof fakeSocket>[0] = (m) =>
  m.op === 'prepare-screenshot' ? { ok: true, data: { x: 1, y: 2, width: 3, height: 4 } } : { ok: true, data: { ready: true } }) {
  const sock = fakeSocket(respond);
  const shortId = registerBrowser(fullId, sock.ws, '/proj', 'default');
  cleanups.push(() => unregisterBrowser(fullId));
  return { shortId, ...sock };
}

describe('tab targets', () => {
  it('tracks the tabs an extension reports and drops them when it goes away', () => {
    const ext = addExtension(() => null);
    const { ids } = syncExtensionTabs(ext.id, [{ fullId: 'tab-a', url: 'https://a.test/', title: 'A', allowed: true }]);
    // The short id goes back to the extension for its toolbar badge.
    expect(ids).toEqual({ 'tab-a': toShortId('tab-a') });
    const a = listBrowsers().find((b) => b.fullId === 'tab-a');
    expect(a).toMatchObject({ kind: 'tab', connected: true, url: 'https://a.test/', allowed: true });

    syncExtensionTabs(ext.id, [{ fullId: 'tab-b' }]);
    expect(listBrowsers().some((b) => b.fullId === 'tab-a')).toBe(false);

    dropExtensionTabs(ext.id);
    expect(listBrowsers().some((b) => b.fullId === 'tab-b')).toBe(false);
  });

  it('never lets two targets share a short id', async () => {
    // Find two fullIds whose short ids collide (4 letters → quick birthday search).
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair; i++) {
      const f = `tab-c${i}`;
      const s = toShortId(f);
      if (seen.has(s)) pair = [seen.get(s)!, f]; else seen.set(s, f);
    }
    const [first, second] = pair;
    const ext = addExtension(() => null);
    const res = syncExtensionTabs(ext.id, [{ fullId: first }, { fullId: second }]);
    expect(Object.keys(res.ids)).toEqual([first]);
    expect(res.reroll).toEqual([second]);
    expect(listBrowsers().filter((b) => b.shortId === toShortId(first)).map((b) => b.fullId)).toEqual([first]);
  });

  it('makes a tab yield its short id to a bubble that needs it', () => {
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair; i++) {
      const f = i % 2 ? `tab-y${i}` : `browser-y${i}`;
      const s = toShortId(f);
      const other = seen.get(s);
      if (other && other.startsWith('tab-') !== f.startsWith('tab-')) pair = other.startsWith('tab-') ? [other, f] : [f, other];
      else seen.set(s, f);
    }
    const [tabFullId, bubbleFullId] = pair;
    const ext = addExtension(() => null);
    syncExtensionTabs(ext.id, [{ fullId: tabFullId }]);
    addBubble(bubbleFullId);
    expect(listBrowsers().find((b) => b.shortId === toShortId(bubbleFullId))?.kind).toBe('bubble');
    expect(ext.sent.at(-1)).toMatchObject({ type: 'tab-ids', reroll: [tabFullId] });
  });

  it('routes a command to the owning extension with a tab target', async () => {
    const ext = addExtension((m) => (m.type === 'cmd' ? { ok: true, data: 'Title' } : null));
    syncExtensionTabs(ext.id, [{ fullId: 'tab-c' }]);
    await expect(dispatchBrowserCommand(toShortId('tab-c'), 'title', {}, 1000)).resolves.toBe('Title');
    expect(ext.sent.at(-1)).toMatchObject({ type: 'cmd', action: 'title', target: { kind: 'tab', fullId: 'tab-c' }, timeout: 1000 });
    expect(getBrowserHealth(toShortId('tab-c'))).toMatchObject({ found: true, kind: 'tab', lastSuccessAction: 'title' });
  });
});

describe('bubble targets', () => {
  it('waits for the bubble UI, then tries each browser until one finds the frame', async () => {
    const miss = addExtension(() => ({ ok: false, error: 'not here', code: 'TARGET_NOT_FOUND' }));
    const hit = addExtension(() => ({ ok: true, data: { url: 'http://localhost:3000/' } }));
    const bubble = addBubble('bubble-1');

    await expect(dispatchBrowserCommand(bubble.shortId, 'status', {}, 1000)).resolves.toEqual({ url: 'http://localhost:3000/' });
    expect(bubble.sent[0]).toMatchObject({ type: 'browser:ui', op: 'ensure-ready' });
    const cmds = [...miss.sent, ...hit.sent].filter((m) => m.type === 'cmd');
    expect(cmds.every((m) => (m.target as Msg).kind === 'bubble' && (m.target as Msg).bubbleId === 'bubble-1')).toBe(true);
    expect(hit.sent.filter((m) => m.type === 'cmd')).toHaveLength(1);

    // The browser that found it is asked first next time.
    const missBefore = miss.sent.length;
    await dispatchBrowserCommand(bubble.shortId, 'status', {}, 1000);
    expect(miss.sent.length).toBe(missBefore);
  });

  it('does not fall through on a real failure', async () => {
    addExtension(() => ({ ok: false, error: 'boom' }));
    const other = addExtension(() => ({ ok: true, data: 1 }));
    const bubble = addBubble('bubble-2');
    // Most recent connection is tried first — make the failing one the newest.
    const failing = addExtension(() => ({ ok: false, error: 'page threw' }));
    await expect(dispatchBrowserCommand(bubble.shortId, 'evaluate', { js: 'x' }, 1000)).rejects.toThrow('page threw');
    expect(failing.sent.some((m) => m.type === 'cmd')).toBe(true);
    expect(other.sent.some((m) => m.type === 'cmd')).toBe(false);
  });

  it('frames a screenshot through the UI and always restores it', async () => {
    const ext = addExtension((m) => ({ ok: true, data: { image: 'data:', bounds: m.params } }));
    const bubble = addBubble('bubble-3');
    const res = await dispatchBrowserCommand(bubble.shortId, 'screenshot', {}, 1000) as { bounds: Msg };
    expect(res.bounds).toMatchObject({ bounds: { x: 1, y: 2, width: 3, height: 4 } });
    expect(bubble.sent.map((m) => m.op)).toEqual(['ensure-ready', 'prepare-screenshot', 'screenshot-done']);
    expect(ext.sent.at(-1)).toMatchObject({ action: 'screenshot' });
  });

  it('explains how to fix a missing extension', async () => {
    const bubble = addBubble('bubble-4');
    await expect(dispatchBrowserCommand(bubble.shortId, 'url', {}, 1000)).rejects.toMatchObject({ code: 'NO_EXTENSION' });
  });

  it('keeps a re-registered bubble when the old socket closes late', () => {
    const first = addBubble('bubble-5');
    const second = addBubble('bubble-5');
    unregisterBubbleSocket('bubble-5', first.ws);
    expect(listBrowsers().some((b) => b.fullId === 'bubble-5')).toBe(true);
    unregisterBubbleSocket('bubble-5', second.ws);
    expect(listBrowsers().some((b) => b.fullId === 'bubble-5')).toBe(false);
  });
});
