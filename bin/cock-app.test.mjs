import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  assetFor,
  defaultTarget,
  expectedChecksum,
  applyStaged,
  appStatus,
  installApp,
  localArchive,
  parseArgs,
  readStaged,
  stageApp,
  stagedDirFor,
  startMenuShortcut,
  uninstallApp,
} from './cock-app.mjs';

const SHA = 'a'.repeat(64);

describe('parseArgs', () => {
  it('reads the command and options', () => {
    expect(parseArgs(['update', '--target', '/x/OpenCockpit.app', '--wait-pid', '42', '--relaunch'])).toEqual({
      command: 'update',
      target: '/x/OpenCockpit.app',
      waitPid: 42,
      relaunch: true,
      from: null,
      stage: false,
      apply: false,
      json: false,
      help: false,
    });
    expect(parseArgs(['update', '--stage']).stage).toBe(true);
    expect(parseArgs(['update', '--apply']).apply).toBe(true);
    expect(parseArgs(['install', '--from', 'desktop/dist']).from).toBe('desktop/dist');
  });

  it('rejects unknown flags and a second positional', () => {
    expect(() => parseArgs(['install', '--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['install', 'extra'])).toThrow(/unknown argument/);
  });
});

describe('assetFor', () => {
  it('matches electron-builder artifact names', () => {
    expect(assetFor('darwin', 'arm64', '1.2.0')).toBe('OpenCockpit-1.2.0-mac-arm64.zip');
    expect(assetFor('darwin', 'x64', '1.2.0')).toBe('OpenCockpit-1.2.0-mac-x64.zip');
    expect(assetFor('win32', 'x64', '1.2.0')).toBe('OpenCockpit-1.2.0-win-x64.zip');
  });

  it('serves the x64 build to Windows on ARM, and nothing to other platforms', () => {
    expect(assetFor('win32', 'arm64', '1.2.0')).toBe('OpenCockpit-1.2.0-win-x64.zip');
    expect(assetFor('linux', 'x64', '1.2.0')).toBeNull();
    expect(assetFor('darwin', 'ia32', '1.2.0')).toBeNull();
  });
});

describe('defaultTarget / startMenuShortcut', () => {
  it('uses per-user locations that need no admin rights', () => {
    expect(defaultTarget('darwin', {}, '/Users/a')).toBe(join('/Users/a', 'Applications', 'OpenCockpit.app'));
    expect(defaultTarget('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\a')).toBe(join('C:\\L', 'Programs', 'OpenCockpit'));
    expect(defaultTarget('linux', {}, '/home/a')).toBeNull();
    expect(startMenuShortcut({ APPDATA: 'C:\\R' })).toBe(
      join('C:\\R', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OpenCockpit.lnk'),
    );
  });
});

describe('expectedChecksum', () => {
  const asset = 'OpenCockpit-1.2.0-mac-arm64.zip';

  it('returns the recorded hash', () => {
    expect(expectedChecksum({ version: '1.2.0', files: { [asset]: SHA } }, '1.2.0', asset)).toBe(SHA);
  });

  it('refuses without a record, for another version, or for a malformed hash', () => {
    expect(() => expectedChecksum(null, '1.2.0', asset)).toThrow(/no desktop app checksums/);
    expect(() => expectedChecksum({ version: '1.1.0', files: { [asset]: SHA } }, '1.2.0', asset)).toThrow(/is for 1.1.0/);
    expect(() => expectedChecksum({ version: '1.2.0', files: { [asset]: 'abc' } }, '1.2.0', asset)).toThrow(
      /No checksum/,
    );
  });
});

describe('appStatus', () => {
  let root;
  afterEach(() => root && rmSync(root, { recursive: true, force: true }));
  const make = (checksums) => {
    root = mkdtempSync(join(tmpdir(), 'cock-app-status-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    if (checksums) writeFileSync(join(root, 'desktop-checksums.json'), JSON.stringify(checksums));
    return root;
  };

  it('reports the shell fingerprint recorded for this version', () => {
    expect(appStatus(make({ version: '1.2.0', shellHash: 'abc', files: {} }))).toEqual({ version: '1.2.0', shellHash: 'abc' });
  });

  it('reports none for a source checkout, an older record, or a stale file', () => {
    expect(appStatus(make(null))).toEqual({ version: '1.2.0', shellHash: null });
    expect(appStatus(make({ version: '1.2.0', files: {} }))).toEqual({ version: '1.2.0', shellHash: null });
    expect(appStatus(make({ version: '1.1.0', shellHash: 'abc', files: {} }))).toEqual({ version: '1.2.0', shellHash: null });
  });
});

describe('localArchive', () => {
  let tmp;
  afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

  it('picks the platform asset inside a directory, or takes a file as is', () => {
    tmp = mkdtempSync(join(tmpdir(), 'cock-app-local-'));
    writeFileSync(join(tmp, 'OpenCockpit-1.2.0-mac-arm64.zip'), 'x');
    expect(localArchive(tmp, 'OpenCockpit-1.2.0-mac-arm64.zip')).toBe(join(tmp, 'OpenCockpit-1.2.0-mac-arm64.zip'));
    expect(localArchive(join(tmp, 'OpenCockpit-1.2.0-mac-arm64.zip'), 'ignored.zip')).toBe(
      join(tmp, 'OpenCockpit-1.2.0-mac-arm64.zip'),
    );
  });

  it('points at desktop:build when the archive is missing', () => {
    tmp = mkdtempSync(join(tmpdir(), 'cock-app-local-'));
    expect(() => localArchive(tmp, 'OpenCockpit-1.2.0-mac-x64.zip')).toThrow(/npm run desktop:build/);
  });
});

// End to end against a local "release" server, with a real ditto-made zip.
describe.runIf(process.platform === 'darwin')('installApp on macOS', () => {
  const version = '9.9.9';
  let dir;
  let server;
  let base;
  let zipBytes;

  function fakeRelease(marker) {
    const src = join(dir, `src-${marker}`);
    const app = join(src, 'OpenCockpit.app', 'Contents');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'marker.txt'), marker);
    const zip = join(dir, `${marker}.zip`);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(src, 'OpenCockpit.app'), zip]);
    return readFileSync(zip);
  }

  function fakeRoot(sha) {
    const root = join(dir, 'pkg');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    const arch = process.arch === 'arm64' ? 'arm64' : execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']).toString().trim() === '1' ? 'arm64' : 'x64';
    const asset = `OpenCockpit-${version}-mac-${arch}.zip`;
    writeFileSync(join(root, 'desktop-checksums.json'), JSON.stringify({ version, files: { [asset]: sha } }));
    return root;
  }

  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
  const quiet = () => {};

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cock-app-'));
    server = createServer((req, res) => {
      if (req.url?.startsWith(`/v${version}/`)) {
        res.writeHead(200, { 'content-length': zipBytes.length });
        res.end(zipBytes);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it('installs, updates in place, and leaves no staging behind', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');

    zipBytes = fakeRelease('first');
    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, register: false, log: quiet });
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('first');

    zipBytes = fakeRelease('second');
    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, requireExisting: true, register: false, log: quiet });
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('second');
    expect(readdirSync(join(dir, 'Applications'))).toEqual(['OpenCockpit.app']);
  });

  it('keeps the existing app when the checksum does not match', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    zipBytes = fakeRelease('good');
    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, register: false, log: quiet });

    zipBytes = fakeRelease('tampered');
    await expect(
      installApp({ platform: 'darwin', root: fakeRoot('b'.repeat(64)), base, target, register: false, log: quiet }),
    ).rejects.toThrow(/Checksum mismatch/);
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('good');
    expect(readdirSync(join(dir, 'Applications'))).toEqual(['OpenCockpit.app']);
  });

  it('--from installs a local build (zip or its directory) with no checksum record', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    const root = join(dir, 'pkg');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    const zip = join(dir, 'local.zip');
    writeFileSync(zip, fakeRelease('local'));

    await installApp({ platform: 'darwin', root, base: 'http://127.0.0.1:1', target, from: zip, register: false, log: quiet });
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('local');

  });

  it('--stage prepares the update beside the app without touching it; --apply swaps it in', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    zipBytes = fakeRelease('old');
    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, register: false, log: quiet });

    zipBytes = fakeRelease('new');
    const { version: staged } = await stageApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, log: quiet });
    expect(staged).toBe(version);
    expect(readStaged(target)).toEqual({ version, app: join('unpacked', 'OpenCockpit.app') });
    // The running app is untouched while the update waits, and no zip is left behind.
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('old');
    expect(readdirSync(stagedDirFor(target)).sort()).toEqual(['staged.json', 'unpacked']);

    await applyStaged({ platform: 'darwin', target, register: false, log: quiet });
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('new');
    expect(existsSync(stagedDirFor(target))).toBe(false);
    expect(readStaged(target)).toBeNull();
  });

  it('a failed stage leaves no half-finished update; --apply with nothing staged refuses', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    zipBytes = fakeRelease('old');
    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, register: false, log: quiet });

    await expect(
      stageApp({ platform: 'darwin', root: fakeRoot('c'.repeat(64)), base, target, log: quiet }),
    ).rejects.toThrow(/Checksum mismatch/);
    expect(existsSync(stagedDirFor(target))).toBe(false);
    await expect(applyStaged({ platform: 'darwin', target, register: false, log: quiet })).rejects.toThrow(/No staged update/);
    expect(readFileSync(join(target, 'Contents', 'marker.txt'), 'utf8')).toBe('old');
  });

  it('--stage needs an installed app to update', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    zipBytes = fakeRelease('x');
    await expect(
      stageApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, log: quiet }),
    ).rejects.toThrow(/No desktop app/);
  });

  it('update refuses when nothing is installed; uninstall removes the bundle', async () => {
    const target = join(dir, 'Applications', 'OpenCockpit.app');
    zipBytes = fakeRelease('x');
    await expect(
      installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, requireExisting: true, register: false, log: quiet }),
    ).rejects.toThrow(/No desktop app/);

    await installApp({ platform: 'darwin', root: fakeRoot(sha256(zipBytes)), base, target, register: false, log: quiet });
    await uninstallApp({ platform: 'darwin', target, register: false, log: quiet });
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(join(dir, 'Applications'))).toEqual([]);
  });
});
