// End-to-end check of bin/bridge-host.mjs: browser side over stdio framing,
// server side over a real WebSocket that demands the instance token.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WebSocketServer } from 'ws';
import { createDecoder, encodeMessage } from './bridgeProtocol.mjs';

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

function startServer(token) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve({ wss, port: wss.address().port }));
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/ws/browser-ext' || url.searchParams.get('token') !== token || req.headers.origin) {
        ws.close(4401);
        return;
      }
      wss.emit('authed', ws);
    });
    cleanups.push(() => wss.close());
  });
}

function startHost(bridgeDir) {
  const child = spawn(process.execPath, [join(__dirname, 'bridge-host.mjs')], {
    env: { ...process.env, COCKPIT_BRIDGE_DIR: bridgeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanups.push(() => child.kill());
  const inbox = [];
  const waiters = [];
  child.stdout.on('data', createDecoder((m) => {
    inbox.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  }));
  const next = (pred) => new Promise((resolve, reject) => {
    const hit = inbox.find(pred);
    if (hit) return resolve(hit);
    const timer = setTimeout(() => reject(new Error('host message timeout')), 5000);
    waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
  return { child, next, write: (m) => child.stdin.write(encodeMessage(m)) };
}

describe('bridge-host relay', () => {
  it('connects to a live instance and relays both ways', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-host-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'instances'));
    const { wss, port } = await startServer('secret');
    const authed = new Promise((r) => wss.once('authed', r));
    writeFileSync(join(dir, 'instances', `${port}.json`), JSON.stringify({ id: String(port), port, pid: process.pid, token: 'secret' }));

    const host = startHost(dir);
    host.write({ type: 'hello', protocol: 1 });
    const serverWs = await authed;
    const inst = await host.next((m) => m.type === 'instances' && m.instances.length === 1);
    expect(inst.instances[0]).toEqual({ id: String(port), port });

    // server → browser
    serverWs.send(JSON.stringify({ type: 'cmd', reqId: 'r1', action: 'title' }));
    const relayed = await host.next((m) => m.type === 'msg' && m.msg?.reqId === 'r1');
    expect(relayed).toEqual({ type: 'msg', instance: String(port), msg: { type: 'cmd', reqId: 'r1', action: 'title' } });

    // browser → server
    const got = new Promise((r) => serverWs.once('message', (d) => r(JSON.parse(String(d)))));
    host.write({ type: 'msg', instance: String(port), msg: { type: 'result', reqId: 'r1', ok: true, data: 'T' } });
    expect(await got).toEqual({ type: 'result', reqId: 'r1', ok: true, data: 'T' });
  }, 15000);

  it('ignores records whose process is dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-host-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'instances'));
    const { wss, port } = await startServer('secret');
    let connected = false;
    wss.on('authed', () => { connected = true; });
    writeFileSync(join(dir, 'instances', `${port}.json`), JSON.stringify({ id: String(port), port, pid: 2 ** 22 + 4321, token: 'secret' }));
    const host = startHost(dir);
    host.write({ type: 'hello', protocol: 1 });
    const inst = await host.next((m) => m.type === 'instances');
    expect(inst.instances).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(connected).toBe(false);
  }, 15000);
});
