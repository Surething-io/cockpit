import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * COCKPIT_ROOT is pinned per test rather than inherited.
 *
 * The route resolves against COCKPIT_ROOT by design — in production Cockpit runs from its npm
 * install directory, not the cwd. But a Cockpit that spawns an agent leaks COCKPIT_ROOT into
 * it, so an inherited value would silently point these assertions at whatever build happens to
 * be installed globally. Same failure mode the NODE_ENV note in vitest.config.ts describes.
 */
const REPO = process.cwd();
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.COCKPIT_ROOT;
  process.env.COCKPIT_ROOT = REPO;
});

afterEach(() => {
  if (saved === undefined) delete process.env.COCKPIT_ROOT;
  else process.env.COCKPIT_ROOT = saved;
});

const get = async () => {
  const res = await GET(new Request('http://localhost/api/version'));
  return { status: res.status, body: await res.json() };
};

describe('GET /api/version', () => {
  it('reports the cockpit version', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('reports the bundled agent CLI versions', async () => {
    // What a bug report needs: both CLIs ship inside their SDKs at a pinned version, so "which
    // Claude am I running" is otherwise invisible from the UI. A wrong package name or field
    // name yields null, which these patterns reject — no need to restate the lookup here.
    const { body } = await get();
    expect(body.agents.claude).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.agents.codex).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves against COCKPIT_ROOT, not the cwd', async () => {
    process.env.COCKPIT_ROOT = '/nonexistent-root';
    const { status, body } = await get();
    // Unreadable packages degrade to null; /api/version itself must never break.
    expect(status).toBe(200);
    expect(body.agents).toEqual({ claude: null, codex: null });
  });
});
