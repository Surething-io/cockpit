/**
 * Constraint: SecretFilesOwnerOnly (invariant, L4 — single write choke point).
 *
 * Files that hold credentials are readable and writable by their owner only
 * (mode 0600), however they are written. The rule lives in writeJsonFile — the
 * one function every JSON writer (incl. mutateJsonFile) goes through — keyed on
 * the SECRET_FILES registry in paths.ts, and startup tightens files an older
 * version left world-readable.
 *
 * Why: API keys (DeepSeek / Kimi / GLM), the Ollama API key and the Web Push
 * private key were written with the default umask, i.e. 0644: any other local
 * user could read them.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'cockpit-secret-files-'));
process.env.COCKPIT_HOME = home;

type Utils = typeof import('../packages/shared/utils/src/index');
let utils: Utils;

/** The secret files as they exist today — independent of the registry under test. */
const knownSecrets = (u: Utils) => [
  u.DEEPSEEK_CREDENTIALS_FILE,
  u.KIMI_CREDENTIALS_FILE,
  u.GLM_CREDENTIALS_FILE,
  u.OLLAMA_CONFIG_FILE,
  u.PUSH_VAPID_FILE,
];

const groupOrOtherBits = (path: string) => statSync(path).mode & 0o077;
// Windows has no group / other permission bits (chmod only toggles read-only), so the
// mode assertions are POSIX-only; the registry check below runs everywhere.
const posixModes = process.platform !== 'win32';

beforeAll(async () => {
  utils = await import('../packages/shared/utils/src/index');
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('SecretFilesOwnerOnly', () => {
  it.skipIf(!posixModes)('every credential store writes its file owner-only', async () => {
    const { deepseekApiKey, kimiApiKey, glmApiKey } = await import(
      '../packages/feature/agent/src/server/engines/credentials'
    );
    await deepseekApiKey.write('sk-deepseek');
    await kimiApiKey.write('sk-kimi');
    await glmApiKey.write('sk-glm');
    await utils.writeOllamaStoredConfig({ apiKey: 'ollama-key' });
    const { getVapid } = await import('../packages/feature/agent/src/server/push/push');
    await getVapid();

    for (const file of knownSecrets(utils)) {
      expect(groupOrOtherBits(file), file).toBe(0);
    }
  });

  it.skipIf(!posixModes)('a rewrite of a file left 0644 by an older version tightens it', async () => {
    const file = utils.KIMI_CREDENTIALS_FILE;
    chmodSync(file, 0o644);
    const { kimiApiKey } = await import('../packages/feature/agent/src/server/engines/credentials');
    await kimiApiKey.write('sk-kimi-2');
    expect(groupOrOtherBits(file)).toBe(0);
  });

  it.skipIf(!posixModes)('startup tightens existing secret files without rewriting them', async () => {
    const file = utils.GLM_CREDENTIALS_FILE;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{"apiKey":"old"}', { mode: 0o644 });
    chmodSync(file, 0o644);

    const tighten = (utils as { tightenSecretFiles?: () => Promise<void> }).tightenSecretFiles;
    expect(tighten, 'tightenSecretFiles exported').toBeTypeOf('function');
    await tighten!();
    expect(groupOrOtherBits(file)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('{"apiKey":"old"}');
  });

  it('the registry lists every credential file paths.ts defines', () => {
    const registry = (utils as { SECRET_FILES?: readonly string[] }).SECRET_FILES ?? [];
    for (const file of knownSecrets(utils)) expect(registry, file).toContain(file);
    // A new *_CREDENTIALS_FILE constant must be registered too.
    const declared = Object.entries(utils)
      .filter(([name]) => /_CREDENTIALS_FILE$/.test(name))
      .map(([, value]) => value as string);
    for (const file of declared) expect(registry, file).toContain(file);
  });
});
