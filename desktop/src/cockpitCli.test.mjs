import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix } from 'path';
import { compareVersions, findTools, pathOf, portOf, readServerRecord, shellUpdateFor, whichIn } from './cockpitCli.mjs';

describe('pathOf', () => {
  it('reads PATH whatever its case', () => {
    expect(pathOf({ Path: 'C:\\a' })).toBe('C:\\a');
    expect(pathOf({ PATH: '/bin' })).toBe('/bin');
    expect(pathOf({})).toBe('');
  });
});

describe('whichIn / findTools', () => {
  it('returns the first hit in PATH order', () => {
    const present = new Set(['/b/node', '/c/node']);
    expect(whichIn(['node'], '/a:/b:/c', { sep: ':', joinPath: posix.join, exists: (p) => present.has(p) })).toBe('/b/node');
  });

  it('uses Windows shim names and the ; separator on win32', () => {
    const present = new Set(['C:\\npm\\cockpit.cmd', 'C:\\node\\node.exe', 'C:\\node\\npm.cmd']);
    const tools = findTools({ Path: 'C:\\node;C:\\npm' }, 'win32', (p) => present.has(p));
    expect(tools).toEqual({
      node: 'C:\\node\\node.exe',
      npm: 'C:\\node\\npm.cmd',
      cockpit: 'C:\\npm\\cockpit.cmd',
    });
  });

  it('builds POSIX paths on darwin whatever the host is', () => {
    const present = new Set(['/opt/homebrew/bin/cockpit']);
    expect(findTools({ PATH: '/usr/bin:/opt/homebrew/bin' }, 'darwin', (p) => present.has(p)).cockpit).toBe(
      '/opt/homebrew/bin/cockpit',
    );
  });

  it('reports missing tools as null', () => {
    expect(findTools({ PATH: '/nowhere' }, 'darwin', () => false)).toEqual({ node: null, npm: null, cockpit: null });
  });
});

describe('shellUpdateFor', () => {
  it('offers an update only when the installed cockpit carries a different shell', () => {
    expect(shellUpdateFor('aaa', { version: '1.2.0', shellHash: 'aaa' })).toBeNull();
    expect(shellUpdateFor('aaa', { version: '1.2.0', shellHash: 'bbb' })).toBe('1.2.0');
  });

  it('replaces a local or unfingerprinted build once a release records one', () => {
    expect(shellUpdateFor('aaa-dirty', { version: '1.2.0', shellHash: 'aaa' })).toBe('1.2.0');
    expect(shellUpdateFor(null, { version: '1.2.0', shellHash: 'aaa' })).toBe('1.2.0');
  });

  it('never triggers from a package without a fingerprint', () => {
    expect(shellUpdateFor('aaa', { version: '1.2.0', shellHash: null })).toBeNull();
    expect(shellUpdateFor('aaa', null)).toBeNull();
    expect(shellUpdateFor('aaa', { shellHash: 'bbb' })).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, accepting a leading v', () => {
    expect(compareVersions('v24.1.0', '22.19.0')).toBe(1);
    expect(compareVersions('22.9.0', '22.19.0')).toBe(-1);
    expect(compareVersions('1.1.5', '1.1.5')).toBe(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(0);
  });

  it('returns null for garbage', () => {
    expect(compareVersions('', '1.0.0')).toBeNull();
    expect(compareVersions('1.0.0', 'latest')).toBeNull();
  });
});

describe('readServerRecord / portOf', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('honours COCKPIT_HOME and prefers the recorded port', () => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-desktop-'));
    writeFileSync(join(dir, 'server.json'), JSON.stringify({ pid: 1, port: 4100 }));
    const env = { COCKPIT_HOME: dir, PORT: '5000' };
    expect(readServerRecord(env)).toEqual({ pid: 1, port: 4100 });
    expect(portOf(env)).toBe(4100);
  });

  it('falls back to PORT, then the default, when nothing is recorded', () => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-desktop-'));
    expect(readServerRecord({ COCKPIT_HOME: dir })).toBeNull();
    expect(portOf({ COCKPIT_HOME: dir, PORT: '5000' })).toBe(5000);
    expect(portOf({ COCKPIT_HOME: dir })).toBe(3457);
  });
});
