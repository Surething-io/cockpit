import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rotateIfLarge } from './rotateLog.mjs';

describe('rotateIfLarge', () => {
  let dir;
  let log;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-rotate-'));
    log = join(dir, 'server.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a file under the limit alone', () => {
    writeFileSync(log, 'x'.repeat(100));
    expect(rotateIfLarge(log, 1000)).toBe(false);
    expect(existsSync(log)).toBe(true);
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it('rotates a file at or over the limit', () => {
    writeFileSync(log, 'x'.repeat(2000));
    expect(rotateIfLarge(log, 1000)).toBe(true);
    // The live path is freed so the caller can open a fresh fd on it.
    expect(existsSync(log)).toBe(false);
    expect(existsSync(`${log}.1`)).toBe(true);
  });

  it('keeps exactly one generation, discarding the older one', () => {
    writeFileSync(log, 'old'.repeat(1000));
    rotateIfLarge(log, 1000);
    writeFileSync(log, 'new'.repeat(1000));
    rotateIfLarge(log, 1000);

    expect(readdirSync(dir).sort()).toEqual(['server.log.1']);
    // .1 must hold the most recent rotation, not the first one.
    expect(readFileSync(`${log}.1`, 'utf8').startsWith('new')).toBe(true);
  });

  it('is a no-op when the file does not exist', () => {
    expect(rotateIfLarge(join(dir, 'absent.log'), 10)).toBe(false);
  });

  // A log that cannot be rotated must never prevent the server from starting,
  // so every failure path returns false instead of throwing.
  it('never throws on a bad path', () => {
    expect(() => rotateIfLarge(join(dir, 'no', 'such', 'dir', 'x.log'), 1)).not.toThrow();
    expect(rotateIfLarge('', 1)).toBe(false);
  });
});
