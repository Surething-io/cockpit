import { describe, expect, it } from 'vitest';
import { expandWindowsVars, mergeWindowsPath, parseEnvDump, parseRegQuery } from './userEnv.mjs';

const M = '__M__';

describe('parseEnvDump', () => {
  it('reads NUL-separated variables between the markers, ignoring rc-file noise', () => {
    const out = `Welcome to zsh!\nnvm: using v24\n${M}PATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/a\0EMPTY=\0${M}trailing`;
    expect(parseEnvDump(out, M)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/a', EMPTY: '' });
  });

  it('keeps "=" and newlines inside values', () => {
    const out = `${M}A=x=y\0B=line1\nline2\0${M}`;
    expect(parseEnvDump(out, M)).toEqual({ A: 'x=y', B: 'line1\nline2' });
  });

  it('drops variables that describe the probe shell itself', () => {
    const out = `${M}_=/usr/bin/env\0SHLVL=2\0PWD=/\0COCKPIT_DESKTOP_ENV_PROBE=1\0KEEP=1\0${M}`;
    expect(parseEnvDump(out, M)).toEqual({ KEEP: '1' });
  });

  it('returns null when the markers are missing or empty', () => {
    expect(parseEnvDump('no markers here', M)).toBeNull();
    expect(parseEnvDump(`${M}`, M)).toBeNull();
    expect(parseEnvDump(`${M}${M}`, M)).toBeNull();
  });
});

describe('parseRegQuery', () => {
  const sample = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    Path    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming\\npm;C:\\Tools',
    '',
  ].join('\r\n');

  it('extracts the value and its type, matching the name case-insensitively', () => {
    expect(parseRegQuery(sample, 'PATH')).toEqual({
      type: 'REG_EXPAND_SZ',
      value: '%USERPROFILE%\\AppData\\Roaming\\npm;C:\\Tools',
    });
  });

  it('returns null for an absent value', () => {
    expect(parseRegQuery(sample, 'TEMP')).toBeNull();
  });
});

describe('expandWindowsVars', () => {
  it('expands known variables case-insensitively and leaves unknown ones', () => {
    expect(expandWindowsVars('%UserProfile%\\npm;%NOPE%\\x', { USERPROFILE: 'C:\\Users\\a' })).toBe(
      'C:\\Users\\a\\npm;%NOPE%\\x',
    );
  });
});

describe('mergeWindowsPath', () => {
  it('keeps order, drops empties and case-insensitive duplicates', () => {
    expect(mergeWindowsPath('C:\\Windows;C:\\Program Files\\nodejs', ';c:\\windows;C:\\Users\\a\\npm;', undefined)).toBe(
      'C:\\Windows;C:\\Program Files\\nodejs;C:\\Users\\a\\npm',
    );
  });
});
