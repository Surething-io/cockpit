// Native-messaging plumbing for the OpenCockpit Bridge extension.
//
// Two jobs, both idempotent and safe to run on every server boot:
//
//   1. installNativeHost(): register `com.opencockpit.bridge` with every
//      Chromium-family browser present on this machine, so the extension's
//      `chrome.runtime.connectNative()` finds bin/bridge-host.mjs.
//        macOS / Linux — a manifest JSON in each browser's NativeMessagingHosts dir
//        Windows       — one manifest file + a registry value per browser key
//      `allowed_origins` pins the extension ID (fixed by the `key` in
//      chrome-extension/manifest.json), so no other extension can talk to it.
//
//   2. registerInstance(): advertise a running Cockpit server to the host by
//      writing ~/.cockpit/bridge/instances/<port>.json (port + per-boot token,
//      owner-only). The host connects to every live instance it finds there.
//
// The bridge dir is a fixed path, ~/.cockpit/bridge, deliberately NOT under
// COCKPIT_HOME: one browser runs one host, launched without Cockpit's
// environment, and it must find the dev, prod and any isolated instance alike.
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const HOST_NAME = 'com.opencockpit.bridge';
export const EXTENSION_ID = 'lhgblandfgocglaofedkbphcbhcicdal';
// COCKPIT_BRIDGE_DIR exists for tests; real installs always use the default.
export const BRIDGE_DIR = process.env.COCKPIT_BRIDGE_DIR || join(homedir(), '.cockpit', 'bridge');
export const INSTANCES_DIR = join(BRIDGE_DIR, 'instances');

const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'bridge-host.mjs');

/**
 * Per-browser user-level NativeMessagingHosts dirs. `base` must already exist
 * (i.e. the browser has been run once) — we never create a browser's profile
 * dir just to drop a manifest into it.
 */
export function browserManifestDirs(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') {
    const as = join(home, 'Library', 'Application Support');
    return [
      ['Google/Chrome'], ['Google/Chrome Beta'], ['Google/Chrome Canary'], ['Google/Chrome for Testing'],
      ['Chromium'], ['Microsoft Edge'], ['BraveSoftware/Brave-Browser'], ['Vivaldi'],
      ['com.operasoftware.Opera'], ['Arc/User Data'],
    ].map(([rel]) => ({ base: join(as, rel), dir: join(as, rel, 'NativeMessagingHosts') }));
  }
  if (platform === 'linux') {
    const cfg = process.env.XDG_CONFIG_HOME || join(home, '.config');
    return [
      'google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-for-testing',
      'chromium', 'microsoft-edge', 'BraveSoftware/Brave-Browser', 'vivaldi', 'opera',
    ].map((rel) => ({ base: join(cfg, rel), dir: join(cfg, rel, 'NativeMessagingHosts') }));
  }
  return [];
}

/**
 * Windows registry keys (HKCU). Brave, Vivaldi and Opera read Chrome's key;
 * Edge and Chromium have their own.
 */
export const WINDOWS_REGISTRY_KEYS = [
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
];

export function hostManifest(launcherPath) {
  return {
    name: HOST_NAME,
    description: 'OpenCockpit Bridge native messaging host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

/**
 * Chrome launches the host with a minimal environment (no shell PATH), so the
 * launcher pins the absolute node binary that is running Cockpit right now.
 */
export function launcherScript(platform, nodePath, hostScript) {
  if (platform === 'win32') {
    return `@echo off\r\n"${nodePath}" "${hostScript}" %*\r\n`;
  }
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\nexec ${q(nodePath)} ${q(hostScript)} "$@"\n`;
}

function writeIfChanged(path, content, mode) {
  try {
    if (readFileSync(path, 'utf8') === content) return false;
  } catch { /* missing — write it */ }
  writeFileSync(path, content, mode ? { mode } : undefined);
  if (mode) chmodSync(path, mode);
  return true;
}

function regAdd(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (err) => resolve(!err));
  });
}

/**
 * Install / refresh the native host registration. Returns where it was written.
 * Never throws — a browser we cannot register with simply isn't listed.
 */
export async function installNativeHost({
  platform = process.platform,
  home = homedir(),
  nodePath = process.execPath,
  hostScript = HOST_SCRIPT,
} = {}) {
  const bridgeDir = home === homedir() ? BRIDGE_DIR : join(home, '.cockpit', 'bridge');
  mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  const launcher = join(bridgeDir, platform === 'win32' ? 'bridge-host.cmd' : 'bridge-host.sh');
  writeIfChanged(launcher, launcherScript(platform, nodePath, hostScript), platform === 'win32' ? undefined : 0o755);
  const manifestJson = JSON.stringify(hostManifest(launcher), null, 2) + '\n';

  const written = [];
  if (platform === 'win32') {
    const manifestPath = join(bridgeDir, `${HOST_NAME}.json`);
    writeIfChanged(manifestPath, manifestJson);
    for (const key of WINDOWS_REGISTRY_KEYS) {
      if (await regAdd(key, manifestPath)) written.push(key);
    }
    return { launcher, written };
  }
  for (const { base, dir } of browserManifestDirs(platform, home)) {
    if (!existsSync(base)) continue;
    try {
      mkdirSync(dir, { recursive: true });
      writeIfChanged(join(dir, `${HOST_NAME}.json`), manifestJson);
      written.push(dir);
    } catch { /* read-only profile dir — skip this browser */ }
  }
  return { launcher, written };
}

/**
 * Advertise this server to the native host. Returns a cleanup function that
 * removes the record (call it on shutdown). A record left by a crash is
 * ignored by the host because its pid is dead.
 */
export function registerInstance({ port, token, home, version, dir = INSTANCES_DIR }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${port}.json`);
  writeFileSync(path, JSON.stringify({
    id: String(port), port, pid: process.pid, token, home, version, startedAt: Date.now(),
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return () => {
    try {
      const rec = JSON.parse(readFileSync(path, 'utf8'));
      if (rec.pid === process.pid) rmSync(path, { force: true });
    } catch { /* already gone */ }
  };
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Live instance records, newest first. Stale records (dead pid) are skipped. */
export function listInstances(dir = INSTANCES_DIR) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!Number.isInteger(rec.port) || typeof rec.token !== 'string') continue;
      if (Number.isInteger(rec.pid) && !pidAlive(rec.pid)) continue;
      out.push(rec);
    } catch { /* half-written or foreign file */ }
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}
