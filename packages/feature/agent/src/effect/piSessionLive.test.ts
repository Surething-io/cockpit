import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { chatHistoryReducer as reduce, emptyChatHistory } from '../client/chatHistoryState';
import { applyStreamEvent } from '../client/applyStreamEvent';
import { historyWindow } from '../server/historyWindow';
import { deriveContent } from '../shared/assistantText';

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
  it.each(['ollama', 'deepseek', 'kimi', 'glm'] as const)('keeps native %s errors structured through both history readers and reconciliation', async (provider) => {
    const error = 'Provider capacity reached';
    const dir = paths.getPiSessionsDir(root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${provider}-errors.jsonl`);
    const { parseTranscriptFile: readHistory } = await import('../server/api/session/transcriptToMessages');
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    for (const persisted of [true, false]) {
      const entries = [{ type: 'session', version: 3, id: `${provider}-errors`, cwd: root, timestamp },
        ...['previous', 'current'].flatMap((task, index) => {
          const time = Date.parse(timestamp) + index * 1000;
          const stamp = new Date(time).toISOString();
          const failed = task === 'previous' || persisted;
          return [
            { type: 'message', id: `${task}-input`, parentId: index ? 'previous-output' : null, timestamp: stamp, message: { role: 'user', content: task, timestamp: time } },
            { type: 'message', id: `${task}-output`, parentId: `${task}-input`, timestamp: stamp,
              message: { role: 'assistant', content: [{ type: 'text', text: failed ? 'Partial answer' : `⚠️ ${error}` }],
                stopReason: failed ? 'error' : 'stop', ...(failed ? { errorMessage: error } : {}), provider, model: 'test', api: 'openai-completions', usage, timestamp: time } },
          ];
        })];
      writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      for (const messages of [(await parsers.parseTranscriptFile(file)).messages, await readHistory(file)]) {
        expect(messages.find((row) => row.id === 'current-output')?.streamError).toBe(persisted ? error : undefined);
        const run = { id: 'run', startedAt: Date.parse(timestamp) + 1000 };
        let state = reduce(emptyChatHistory, { type: 'replay-start', run });
        const live = applyStreamEvent([
          { id: 'live-input', role: 'user', content: 'current', timestamp: new Date(run.startedAt).toISOString() },
          { id: 'live-output', role: 'assistant', content: 'Partial answer' },
        ], { type: 'error', error }, { engine: provider, assistantId: 'live-output' });
        state = reduce(state, { type: 'run-messages', runId: run.id, update: live });
        state = reduce(state, { type: 'run-end', runId: run.id, writerActive: false, failed: true });
        for (let read = 0; read < 2; read++) {
          state = reduce(state, { type: 'page', sessionId: provider, mode: 'incremental', page: { ...historyWindow(messages, {}), stable: true }, reconciles: [run.id] });
          expect(state.messages.some((row) => row.id.startsWith('live-'))).toBe(false);
          expect(state.failures[0].messages.find((row) => row.id === 'live-output')?.streamError).toBe(error);
          expect(state.messages.find((row) => row.id === 'previous-output')?.content).toContain(error);
          for (const row of state.messages) if (row.parts?.length) expect(row.content).toBe(deriveContent(row.parts));
        }
      }
    }
  });

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

  it('carries recovery identity through native branch rebasing and a subsequent deletion', async () => {
    const id = '12345678-0000-4000-8000-000000000099';
    const dir = paths.getPiSessionsDir(root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const entries = [
      { type: 'session', version: 3, id, cwd: root, timestamp },
      { type: 'model_change', id: 'model', parentId: null, provider: 'ollama', modelId: 'test', timestamp },
      { type: 'message', id: 'first', parentId: 'model', timestamp, message: { role: 'user', content: 'First', timestamp: 1 } },
      { type: 'message', id: 'second', parentId: 'first', timestamp, message: { role: 'user', content: 'Second', timestamp: 2 } },
      { type: 'custom', id: 'other-branch', parentId: 'second', timestamp, customType: 'probe' },
      { type: 'custom', id: 'active-leaf', parentId: 'second', timestamp, customType: 'probe' },
    ];
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const { removeRecoveryTurns } = await import('../shared/recoveryCopy');
    const { deletePiTurn } = await import('./piSessionEditLive');
    let copy = ['first', 'second', 'queued'].map((sourceId) => ({ id: sourceId, sourceId, role: 'user' as const, content: sourceId }));
    const first = await Effect.runPromise(deletePiTurn(file, 'first'));
    expect(first.recoveryDeletion?.sourceIds).toContain('first');
    const remapped = first.recoveryDeletion?.sourceRemap?.second;
    expect(remapped).toBeTypeOf('string');
    copy = removeRecoveryTurns(copy, first.recoveryDeletion!);
    expect(copy.map((row) => row.sourceId)).toEqual([remapped, 'queued']);
    const second = await Effect.runPromise(deletePiTurn(file, remapped!));
    copy = removeRecoveryTurns(copy, second.recoveryDeletion!);
    expect(copy.map((row) => row.id)).toEqual(['queued']);
    const native = await Effect.runPromise(pi.readPiSession(file));
    expect(native.messages.filter((row) => row.type === 'user' && !row.isMeta)).toEqual([]);
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
