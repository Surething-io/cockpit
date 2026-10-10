/**
 * getVapid key storage: push-vapid.json, with migration from settings.json.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load. Modules are reset per test since
 * getVapid caches the configured pair for the life of the process.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import webpush from 'web-push';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'cockpit-push-test-'));
process.env.COCKPIT_HOME = home;

const settingsFile = join(home, 'settings.json');
const vapidFile = join(home, 'push-vapid.json');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

async function freshGetVapid() {
  vi.resetModules();
  return (await import('./push')).getVapid;
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(settingsFile, { force: true });
  rmSync(vapidFile, { force: true });
});

describe('getVapid', () => {
  it('moves a legacy pair out of settings.json, keeping the same keys', async () => {
    const keys = webpush.generateVAPIDKeys();
    writeFileSync(
      settingsFile,
      JSON.stringify({ language: 'zh', push: { ...keys, subject: 'mailto:cockpit@localhost' } }),
    );

    const vapid = await (await freshGetVapid())();

    expect(vapid.publicKey).toBe(keys.publicKey);
    expect(vapid.privateKey).toBe(keys.privateKey);
    expect(vapid.subject).not.toContain('localhost'); // invalid subject healed
    expect(readJson(vapidFile)).toEqual(vapid);
    expect(statSync(vapidFile).mode & 0o077).toBe(0); // owner-only
    expect(readJson(settingsFile)).toEqual({ language: 'zh' }); // push dropped, rest kept
  });

  it('generates and stores a pair on first use without touching settings.json', async () => {
    const vapid = await (await freshGetVapid())();

    expect(vapid.publicKey).toBeTruthy();
    expect(readJson(vapidFile)).toEqual(vapid);
    expect(existsSync(settingsFile)).toBe(false);
  });

  it('reuses the stored pair across restarts', async () => {
    const first = await (await freshGetVapid())();
    const second = await (await freshGetVapid())();
    expect(second).toEqual(first);
  });

  it('refuses a corrupt key file instead of regenerating keys', async () => {
    writeFileSync(vapidFile, '{not json');
    await expect((await freshGetVapid())()).rejects.toThrow();
    expect(readFileSync(vapidFile, 'utf8')).toBe('{not json');
  });
});
