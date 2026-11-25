#!/usr/bin/env node
// OpenCockpit Bridge native messaging host.
//
// Launched by the browser when the extension calls
// chrome.runtime.connectNative('com.opencockpit.bridge'); lives as long as
// that port. It is a dumb, multiplexing relay:
//
//   extension ⇄ (stdio, native framing) ⇄ this process ⇄ (WebSocket) ⇄ each
//   running Cockpit server listed in ~/.cockpit/bridge/instances/
//
// Each server is reached at ws://127.0.0.1:<port>/ws/browser-ext with the
// per-boot token from its instance record — the server rejects anything else.
// stdout carries protocol frames ONLY; diagnostics go to stderr.
import { execFile } from 'child_process';
import { watch } from 'fs';
import { encodeMessage, createDecoder, MAX_HOST_TO_BROWSER } from './bridgeProtocol.mjs';
import { INSTANCES_DIR, listInstances } from './bridgeInstall.mjs';
import { activationPlan, wmctrlWindowFor } from './bridgeActivate.mjs';

const SCAN_MS = 2000;
const log = (...a) => process.stderr.write(`[bridge-host] ${a.join(' ')}\n`);

/** id → { rec, ws, open } */
const conns = new Map();

function send(obj) {
  const frame = encodeMessage(obj);
  if (frame.length - 4 > MAX_HOST_TO_BROWSER) {
    log(`dropping oversize message (${frame.length} bytes) for the browser`);
    if (obj?.type === 'msg' && obj.msg?.reqId) {
      sendToServer(obj.instance, { type: 'result', reqId: obj.msg.reqId, ok: false, error: 'Command too large for the native messaging channel (>1 MB)' });
    }
    return;
  }
  process.stdout.write(frame);
}

function announce() {
  const list = [...conns.values()].filter((c) => c.open).map((c) => ({ id: c.rec.id, port: c.rec.port }));
  send({ type: 'instances', instances: list });
}

function sendToServer(id, msg) {
  const c = conns.get(String(id));
  if (c?.open) c.ws.send(JSON.stringify(msg));
}

function connect(rec) {
  const id = String(rec.id);
  const url = `ws://127.0.0.1:${rec.port}/ws/browser-ext?token=${encodeURIComponent(rec.token)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    log(`connect ${id} failed: ${err.message}`);
    return;
  }
  const c = { rec, ws, open: false };
  conns.set(id, c);
  ws.addEventListener('open', () => { c.open = true; announce(); });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg?.type === 'ping') return;
    send({ type: 'msg', instance: id, msg });
  });
  const drop = () => {
    if (conns.get(id) !== c) return;
    conns.delete(id);
    if (c.open) announce();
  };
  ws.addEventListener('close', drop);
  ws.addEventListener('error', () => { try { ws.close(); } catch { /* ignore */ } drop(); });
}

function scan() {
  const live = new Map(listInstances().map((r) => [String(r.id), r]));
  for (const [id, c] of conns) {
    const rec = live.get(id);
    // Gone, or the same port restarted with a new token → reconnect.
    if (!rec || rec.token !== c.rec.token) {
      conns.delete(id);
      try { c.ws.close(); } catch { /* ignore */ }
      if (c.open) announce();
    }
  }
  for (const [id, rec] of live) if (!conns.has(id)) connect(rec);
}

/**
 * Bring the browser that launched us to the front (see bridgeActivate.mjs).
 * The extension asks when the user has to look at a tab: an approval prompt,
 * or a page they just opened from Cockpit. Attempts run in order until one
 * succeeds; all of them failing is fine.
 */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
  });
}

async function activateBrowser() {
  let parentExe = '';
  if (process.platform === 'darwin') parentExe = (await run('ps', ['-o', 'comm=', '-p', String(process.ppid)])).stdout.trim();
  const plan = activationPlan({ platform: process.platform, ppid: process.ppid, env: process.env, parentExe });
  for (const step of plan) {
    const res = await run(step.cmd, step.args);
    if (!res.ok) continue;
    if (step.match === 'wmctrl') {
      const win = wmctrlWindowFor(res.stdout, process.ppid);
      if (win && (await run('wmctrl', ['-i', '-a', win])).ok) return;
      continue;
    }
    return;
  }
  if (plan.length) log('activate: could not raise the browser; the extension falls back to drawAttention');
}

process.stdin.on('data', createDecoder((m) => {
  if (m?.type === 'msg') sendToServer(m.instance, m.msg);
  if (m?.type === 'activate-browser') activateBrowser();
  // `hello` from the extension needs no reply beyond the instance list.
  if (m?.type === 'hello') announce();
}, (err) => log(`bad frame from browser: ${err.message}`)));
process.stdin.on('end', () => process.exit(0));

scan();
setInterval(scan, SCAN_MS);
try { watch(INSTANCES_DIR, () => scan()); } catch { /* dir not created yet — polling covers it */ }
