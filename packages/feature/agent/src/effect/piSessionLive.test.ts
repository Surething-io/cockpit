import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';

const root = mkdtempSync(join(tmpdir(), 'cockpit-pi-readonly-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
let pi: typeof import('./piSessionLive');
let paths: typeof import('@cockpit/shared-utils');
let parsers: typeof import('../server/api/session/transcriptParsers');
let index: typeof import('./transcriptIndexLive');
beforeAll(async () => {
  pi = await import('./piSessionLive');
  paths = await import('@cockpit/shared-utils');
  parsers = await import('../server/api/session/transcriptParsers');
  index = await import('./transcriptIndexLive');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const timestamp = '2026-01-01T00:00:00.000Z';

describe('read-only native Pi sessions', () => {
  it.each([1, 2, 3])('reads v%i without migration writes or newline repair', async (version) => {
    const id = `legacy-pi-v${version}`;
    const dir = paths.getPiSessionsDir(root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `2026-01-01_${id}.jsonl`);
    const header = { type: 'session', version, id, cwd: root, timestamp };
    const entries = version === 1 ? [
      { type: 'model_change', provider: 'kimi', modelId: 'test', timestamp },
      { type: 'message', message: { role: 'user', content: 'Original subject', timestamp: 1 }, timestamp },
      { type: 'compaction', summary: 'Summary', firstKeptEntryIndex: 2, tokensBefore: 100, timestamp },
      { type: 'message', message: { role: 'user', content: 'Active branch', timestamp: 2 }, timestamp },
    ] : [
      { type: 'model_change', id: 'm', parentId: null, provider: 'kimi', modelId: 'test', timestamp },
      { type: 'message', id: 'u', parentId: 'm', message: { role: 'user', content: 'Original subject', timestamp: 1 }, timestamp },
      { type: 'message', id: 'side', parentId: 'm', message: { role: 'user', content: 'Inactive branch', timestamp: 2 }, timestamp },
      { type: 'message', id: 'leaf', parentId: 'u', message: { role: 'user', content: 'Active branch', timestamp: 3 }, timestamp },
      { type: 'session_info', id: 'name', parentId: 'leaf', name: 'Native Pi name', timestamp },
    ];
    writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n'));
    utimesSync(file, new Date(timestamp), new Date(timestamp));
    const before = readFileSync(file);
    const modified = statSync(file).mtimeMs;
    const first = await Effect.runPromise(pi.readPiSession(file));
    const second = await Effect.runPromise(pi.readPiSession(file));
    expect(first.manager.getCwd()).toBe(root);
    expect(first.manager.getSessionId()).toBe(id);
    expect(second.entries.map((entry) => entry.id)).toEqual(first.entries.map((entry) => entry.id));
    expect(JSON.stringify(first.messages)).not.toContain('Inactive branch');
    expect(JSON.stringify(first.messages)).toContain('Active branch');
    if (version === 1) {
      const original = first.entries.find((entry) => entry.type === 'message');
      expect(first.entries.find((entry) => entry.type === 'compaction')).toMatchObject({ firstKeptEntryId: original?.id });
    } else expect(first.name).toBe('Native Pi name');
    expect((await Effect.runPromise(pi.findPiSession(root, id)))?.engine).toBe('kimi');
    expect((await Effect.runPromise(pi.listPiSessions(root))).some((session) => session.id === id)).toBe(true);
    expect((await parsers.parseTranscriptFile(file)).title).toBe(version === 1 ? 'Original subject' : 'Native Pi name');
    expect(await index.runWithTranscriptIndex((service) => service.snapshot(file, 'pi'))).not.toBeNull();
    expect(readFileSync(file)).toEqual(before);
    expect(statSync(file).mtimeMs).toBe(modified);
  });

  it.each(['delete', 'prefix', 'single'] as const)('uses displayed v1 IDs for %s and preserves surviving IDs', async (action) => {
    const id = `12345678-0000-4000-8000-${action === 'delete' ? '000000000001' : action === 'prefix' ? '000000000002' : '000000000003'}`;
    const file = join(paths.getPiSessionsDir(root), `${id}.jsonl`);
    const entries = [
      { type: 'session', version: 1, id, cwd: root, timestamp },
      { type: 'model_change', provider: 'ollama', modelId: 'test', timestamp },
      ...['First', 'Second'].flatMap((text) => [
        { type: 'message', message: { role: 'user', content: text, timestamp: 1 }, timestamp },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: `${text} reply` }], stopReason: 'stop', provider: 'ollama', model: 'test', api: 'openai-completions', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 2 }, timestamp },
      ]),
    ];
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const original = readFileSync(file);
    const displayed = await Effect.runPromise(pi.readPiSession(file));
    const messages = displayed.entries.filter((entry) => entry.type === 'message');
    expect(readFileSync(file)).toEqual(original);
    const edit = await import('./piSessionEditLive');
    if (action === 'delete') {
      expect(await Effect.runPromise(edit.deletePiTurn(file, messages[0].id))).toMatchObject({ targetMissed: false });
      const remaining = await Effect.runPromise(pi.readPiSession(file));
      expect(remaining.entries.filter((entry) => entry.type === 'message').map((entry) => entry.id)).toEqual(messages.slice(2).map((entry) => entry.id));
      expect(await Effect.runPromise(edit.deletePiTurn(file, messages[2].id))).toMatchObject({ targetMissed: false });
    } else {
      const result = await Effect.runPromise(edit.forkPiSession(file, messages[2].id, action));
      expect(result).toBeDefined();
      const child = await Effect.runPromise(pi.findPiSession(root, result!.newSessionId));
      const view = await Effect.runPromise(pi.readPiSession(child!.path));
      expect(JSON.stringify(view.messages)).toContain('Second');
      expect(JSON.stringify(view.messages).includes('First')).toBe(action === 'prefix');
      expect((await Effect.runPromise(pi.readPiSession(file))).entries.map((entry) => entry.id)).toEqual(displayed.entries.map((entry) => entry.id));
    }
    expect(JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).version).toBe(3);
  });

  it('rejects empty or malformed sessions without initializing them', async () => {
    for (const content of ['', 'not-json\n']) {
      const file = join(root, 'invalid.jsonl');
      writeFileSync(file, content);
      const result = await Effect.runPromise(Effect.either(pi.readPiSession(file)));
      expect(result._tag).toBe('Left');
      expect(readFileSync(file, 'utf8')).toBe(content);
    }
  });
  it('does not migrate native files while discovering their IDs for retention', async () => {
    const file = join(paths.getPiSessionsDir(root), '2026-01-01_legacy-pi-v2.jsonl');
    const before = readFileSync(file);
    const modified = statSync(file).mtimeMs;
    const { cleanupSessions } = await import('./sessionCleanupLive');
    await Effect.runPromise(cleanupSessions(paths.PI_SESSIONS_DIR, 100000, join(root, 'missing-pins.json')));
    expect(readFileSync(file)).toEqual(before);
    expect(statSync(file).mtimeMs).toBe(modified);
  });
});
