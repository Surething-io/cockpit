import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EXTENSION_ID, HOST_NAME, browserManifestDirs, hostManifest, installNativeHost,
  launcherScript, listInstances, registerInstance,
} from './bridgeInstall.mjs';
import { createDecoder, encodeMessage } from './bridgeProtocol.mjs';

const MANIFEST = JSON.parse(readFileSync(join(__dirname, '..', 'chrome-extension', 'manifest.json'), 'utf8'));

describe('extension manifest', () => {
  it('derives the extension ID that the native host allows', () => {
    // Chrome: ID = first 32 hex chars of sha256(DER public key), mapped 0-f → a-p.
    const der = Buffer.from(MANIFEST.key, 'base64');
    const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
      .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
    expect(id).toBe(EXTENSION_ID);
    expect(hostManifest('/x').allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
  });

  it('exposes no page-facing channel and no network rewriting', () => {
    expect(MANIFEST.externally_connectable).toBeUndefined();
    expect(MANIFEST.web_accessible_resources).toBeUndefined();
    expect(MANIFEST.declarative_net_request).toBeUndefined();
    for (const p of ['cookies', 'webRequest', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess']) {
      expect(MANIFEST.permissions).not.toContain(p);
    }
  });

  it('only declares the inert MAIN-world bubble hook as a content script', () => {
    expect(MANIFEST.content_scripts).toHaveLength(1);
    expect(MANIFEST.content_scripts[0]).toMatchObject({ js: ['bubble-hook.js'], world: 'MAIN' });
    const hook = readFileSync(join(__dirname, '..', 'chrome-extension', 'bubble-hook.js'), 'utf8');
    // The gate must run before anything else touches the page.
    const gate = hook.indexOf("window.name.startsWith('cockpit-bubble-')");
    const firstPatch = hook.indexOf('console[level] = function');
    expect(gate).toBeGreaterThan(0);
    expect(hook.indexOf('location.ancestorOrigins')).toBeLessThan(firstPatch);
    expect(gate).toBeLessThan(firstPatch);
  });
});

describe('native messaging framing', () => {
  it('round-trips messages split across arbitrary chunk boundaries', () => {
    const msgs = [{ type: 'hello' }, { type: 'msg', instance: '3457', msg: { text: 'é'.repeat(3000) } }, { n: 1 }];
    const wire = Buffer.concat(msgs.map(encodeMessage));
    const got = [];
    const feed = createDecoder((m) => got.push(m));
    for (let i = 0; i < wire.length; i += 7) feed(wire.subarray(i, i + 7));
    expect(got).toEqual(msgs);
  });

  it('reports a bad frame and keeps decoding the next one', () => {
    const bad = Buffer.from('{nope', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(bad.length, 0);
    const got = [];
    const errors = [];
    const feed = createDecoder((m) => got.push(m), (e) => errors.push(e));
    feed(Buffer.concat([header, bad, encodeMessage({ ok: true })]));
    expect(errors).toHaveLength(1);
    expect(got).toEqual([{ ok: true }]);
  });
});

describe('installNativeHost', () => {
  let home;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cockpit-bridge-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('writes a manifest only for browsers that exist (macOS)', async () => {
    const dirs = browserManifestDirs('darwin', home);
    const chrome = dirs.find((d) => d.base.endsWith(join('Google', 'Chrome')));
    const brave = dirs.find((d) => d.base.includes('Brave-Browser'));
    mkdirSync(chrome.base, { recursive: true });
    mkdirSync(brave.base, { recursive: true });

    const res = await installNativeHost({ platform: 'darwin', home, nodePath: '/opt/node', hostScript: '/pkg/bin/bridge-host.mjs' });
    expect(res.written.sort()).toEqual([brave.dir, chrome.dir].sort());

    const manifest = JSON.parse(readFileSync(join(chrome.dir, `${HOST_NAME}.json`), 'utf8'));
    expect(manifest).toMatchObject({ name: HOST_NAME, type: 'stdio', path: res.launcher });
    expect(readFileSync(res.launcher, 'utf8')).toBe(launcherScript('darwin', '/opt/node', '/pkg/bin/bridge-host.mjs'));
    expect(statSync(res.launcher).mode & 0o111).not.toBe(0);
    expect(existsSync(join(dirs.find((d) => d.base.endsWith('Vivaldi')).dir))).toBe(false);
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(home, 'cfg');
    try {
      expect(browserManifestDirs('linux', home)[0].dir).toBe(join(home, 'cfg', 'google-chrome', 'NativeMessagingHosts'));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev;
    }
  });

  it('quotes paths with spaces and quotes in the POSIX launcher; uses a .cmd on Windows', () => {
    expect(launcherScript('darwin', "/A B/it's/node", '/x/host.mjs')).toBe(
      `#!/bin/sh\nexec '/A B/it'\\''s/node' '/x/host.mjs' "$@"\n`,
    );
    expect(launcherScript('win32', 'C:\\n\\node.exe', 'C:\\p\\host.mjs')).toBe(
      '@echo off\r\n"C:\\n\\node.exe" "C:\\p\\host.mjs" %*\r\n',
    );
  });
});

describe('instance registry', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cockpit-instances-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('publishes an owner-only record and removes it on cleanup', () => {
    const cleanup = registerInstance({ port: 4567, token: 't0k', home: '/h', version: '1.0.0', dir });
    const path = join(dir, '4567.json');
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(listInstances(dir)).toMatchObject([{ id: '4567', port: 4567, token: 't0k', pid: process.pid }]);
    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it('skips records whose process is gone and files that are not records', () => {
    writeFileSync(join(dir, '1.json'), JSON.stringify({ id: '1', port: 1, token: 'x', pid: 2 ** 22 + 12345 }));
    writeFileSync(join(dir, '2.json'), '{half');
    writeFileSync(join(dir, '3.json'), JSON.stringify({ port: 3 }));
    expect(listInstances(dir)).toEqual([]);
  });
});
