/**
 * Constraint: SettingsBrowserSafe (invariant, L2).
 *
 * GET and PUT /api/settings send settings to the browser, so no response may
 * carry a secret — at any depth. Secrets live in their own files instead
 * (engine credentials, Ollama config, the Web Push VAPID key pair).
 *
 * Why: the VAPID private key was stored under `push` in settings.json and
 * GET /api/settings returned it verbatim.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing the route, because
 * paths.ts resolves COCKPIT_DIR once at module load.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'cockpit-settings-safe-'));
process.env.COCKPIT_HOME = home;

// Keys that must never reach the browser, whatever object they sit in.
const SECRET_KEY = /^(privateKey|apiKey|secret|password|token)$/i;

function secretPaths(value: unknown, path = '$'): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(SECRET_KEY.test(k) ? [`${path}.${k}`] : []),
    ...secretPaths(v, `${path}.${k}`),
  ]);
}

let GET: (req: Request) => Promise<Response>;
let PUT: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const mod = await import('../src/app/api/settings/route');
  GET = mod.GET as typeof GET;
  PUT = mod.PUT as typeof PUT;
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

// A settings.json as an existing install has it: VAPID keys under `push`.
beforeEach(() => {
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      language: 'en',
      push: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:a@b.c' },
    }),
  );
});

const url = 'http://localhost/api/settings';

describe('SettingsBrowserSafe', () => {
  it('GET returns settings without any secret', async () => {
    const body = await (await GET(new Request(url))).json();
    expect(body.language).toBe('en');
    expect(secretPaths(body)).toEqual([]);
  });

  it('PUT returns the merged settings without any secret', async () => {
    const res = await PUT(
      new Request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'zh' }),
      }),
    );
    const body = await res.json();
    expect(body.language).toBe('zh');
    expect(secretPaths(body)).toEqual([]);
  });
});
