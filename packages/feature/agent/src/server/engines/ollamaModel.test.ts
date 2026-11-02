/**
 * Ollama model resolution — the four 404s this ladder exists to prevent.
 *
 * Every case here was reproduced from one real delegation: a bare `gpt-oss` that only
 * existed locally as `gpt-oss:20b`, a follow-up turn sent to that session with no `model`
 * that fell through to a compiled-in default the machine had never had, and a default id
 * (`qwen3.5:…`) left behind by a `qwen3.6:…` upgrade.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OllamaCatalog } from './ollamaCatalog';
import type { DispatchParams } from './types';

let catalog: OllamaCatalog;
vi.mock('./ollamaCatalog', () => ({ listOllamaModels: async () => catalog }));

const BASE = 'http://127.0.0.1:11434';
const entry = (name: string) => ({ name, size: 0, modified_at: '' });
const installed = (...names: string[]): OllamaCatalog => ({ ok: true, baseUrl: BASE, models: names.map(entry) });
const unreachable = (reason: string): OllamaCatalog => ({ ok: false, baseUrl: BASE, reason });

const CWD = '/Users/x/glasser';

let home: string;
let ollamaSpec: typeof import('./ollama').ollamaSpec;
let resolveDefaultOllamaModel: typeof import('./ollama').resolveDefaultOllamaModel;
let recordSessionModel: typeof import('./sessionModel').recordSessionModel;
let rememberOllamaLastModel: typeof import('@cockpit/shared-utils').rememberOllamaLastModel;
let readOllamaLastModel: typeof import('@cockpit/shared-utils').readOllamaLastModel;
let writeOllamaStoredConfig: typeof import('@cockpit/shared-utils').writeOllamaStoredConfig;

/** Run the engine's preflight over a request and report what it settled on. */
async function preflight(params: DispatchParams) {
  const result = await ollamaSpec.preflight!(params);
  return { result, model: params.model };
}

const ask = (extra: Partial<DispatchParams> = {}): DispatchParams => ({ prompt: 'hi', cwd: CWD, ...extra });

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so set it before importing anything.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;
  ({ ollamaSpec, resolveDefaultOllamaModel } = await import('./ollama'));
  ({ recordSessionModel } = await import('./sessionModel'));
  ({ rememberOllamaLastModel, readOllamaLastModel, writeOllamaStoredConfig } = await import('@cockpit/shared-utils'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
});

// Each test owns its starting point: the last-used model is global state on disk.
beforeEach(async () => {
  catalog = installed('qwen3.6:35b', 'gpt-oss:20b', 'deepseek-r1:7b');
  await writeOllamaStoredConfig({ lastModel: '' });
});

describe('ollama preflight — requested model', () => {
  it('completes a bare name to its one installed tag', async () => {
    const { result, model } = await preflight(ask({ model: 'gpt-oss' }));
    expect(result.ok).toBe(true);
    expect(model).toBe('gpt-oss:20b');
  });

  it('refuses an uninstalled model before the run starts, and names what is available', async () => {
    const { result } = await preflight(ask({ model: 'llama9' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain("'llama9' is not installed");
    expect(result.error).toContain('gpt-oss:20b');
  });

  it('leaves an ambiguous bare name alone rather than guessing between tags', async () => {
    catalog = installed('gpt-oss:20b', 'gpt-oss:120b');
    const { result } = await preflight(ask({ model: 'gpt-oss' }));
    expect(result.ok).toBe(false);
  });

  it('passes a requested model through when the catalog cannot be read', async () => {
    catalog = unreachable('Cannot reach the Ollama server.');
    const { result, model } = await preflight(ask({ model: 'whatever' }));
    expect(result.ok).toBe(true);
    expect(model).toBe('whatever');
  });
});

describe('ollama preflight — no model in the request', () => {
  it("uses the session's recorded model instead of any default", async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { getPiSessionsDir } = await import('@cockpit/shared-utils');
    const manager = SessionManager.create(CWD, getPiSessionsDir(CWD), { id: 'sess-1' });
    manager.appendModelChange('ollama', 'gpt-oss:20b');
    manager.appendMessage({ role: 'user', content: 'previous task', timestamp: Date.now() });
    await rememberOllamaLastModel('deepseek-r1:7b'); // must NOT win over the session
    const { result, model } = await preflight(ask({ sessionId: 'sess-1' }));
    expect(result.ok).toBe(true);
    expect(model).toBe('gpt-oss:20b');
  });

  it('falls back to the last model any run used', async () => {
    await rememberOllamaLastModel('deepseek-r1:7b');
    const { model } = await preflight(ask({ sessionId: 'never-ran' }));
    expect(model).toBe('deepseek-r1:7b');
  });

  it('ignores a last-used model the machine no longer has', async () => {
    await rememberOllamaLastModel('qwen3.5:35b'); // the stale-upgrade case
    const { model } = await preflight(ask());
    expect(model).toBe('qwen3.6:35b'); // first installed
  });

  it("takes the catalog's first entry when nothing was ever used", async () => {
    const { model } = await preflight(ask());
    expect(model).toBe('qwen3.6:35b');
  });

  it('refuses with the reason when the catalog cannot be read', async () => {
    catalog = unreachable('Cannot reach the Ollama server at http://127.0.0.1:11434 (ECONNREFUSED).');
    const { result } = await preflight(ask());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('refuses with the reason when the server has no models at all', async () => {
    catalog = installed();
    const { result } = await preflight(ask());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('no models installed');
    expect(result.error).toContain('ollama pull');
  });
});

describe('session model record', () => {
  it('survives for a session nothing else knows about (the delegation case)', async () => {
    const { readSessionModel } = await import('./sessionModel');
    await recordSessionModel('ollama', CWD, 'delegated-1', 'gpt-oss:20b');
    expect(await readSessionModel('ollama', CWD, 'delegated-1')).toBe('gpt-oss:20b');
    // Written under the same key the chat-header picker reads through /api/project-state.
    const { getSessionFilePath, readJsonFile } = await import('@cockpit/shared-utils');
    const state = await readJsonFile<Record<string, unknown>>(getSessionFilePath(CWD), {});
    expect((state.ollamaModels as Record<string, string>)['delegated-1']).toBe('gpt-oss:20b');
  });

  it('keeps each engine in its own map', async () => {
    const { readSessionModel } = await import('./sessionModel');
    await recordSessionModel('kimi', CWD, 'shared-id', 'k3');
    expect(await readSessionModel('kimi', CWD, 'shared-id')).toBe('k3');
    expect(await readSessionModel('ollama', CWD, 'shared-id')).toBeUndefined();
  });
});

/**
 * The UI asks this the moment a new ollama tab is opened, so that the picker shows the model
 * the engine would have chosen anyway instead of "Select model".
 */
describe('resolveDefaultOllamaModel — what a new chat opens on', () => {
  it('is the model last used, when the machine still has it', async () => {
    await rememberOllamaLastModel('gpt-oss:20b');
    expect(await resolveDefaultOllamaModel()).toEqual({ ok: true, model: 'gpt-oss:20b' });
  });

  it('falls to the first installed when the last used is gone', async () => {
    await rememberOllamaLastModel('qwen3.5:35b');
    expect(await resolveDefaultOllamaModel()).toEqual({ ok: true, model: 'qwen3.6:35b' });
  });

  it('records nothing — asking is not using', async () => {
    await resolveDefaultOllamaModel();
    expect(await readOllamaLastModel()).toBeUndefined();
  });

  it('reports why rather than guessing when the server is unreachable', async () => {
    catalog = unreachable('Cannot reach the Ollama server at http://127.0.0.1:1 (ECONNREFUSED).');
    const choice = await resolveDefaultOllamaModel();
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.reason).toContain('ECONNREFUSED');
  });

  it('agrees with what preflight would pick for the same machine', async () => {
    await rememberOllamaLastModel('deepseek-r1:7b');
    const choice = await resolveDefaultOllamaModel();
    const { model } = await preflight(ask({ sessionId: 'brand-new' }));
    expect(choice).toEqual({ ok: true, model });
  });
});
