import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Either } from 'effect';

const root = mkdtempSync(join(tmpdir(), 'cockpit-logical-transcript-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
process.env.HOME = root;
let logical: typeof import('./logicalTranscript');
let index: typeof import('./transcriptIndexLive');
let claude: typeof import('../server/engines/shared/noHistoryTranscript');
let codex: typeof import('../server/engines/shared/noHistoryRollout');
let parsers: typeof import('../server/api/session/transcriptParsers');
beforeAll(async () => {
  logical = await import('./logicalTranscript');
  index = await import('./transcriptIndexLive');
  claude = await import('../server/engines/shared/noHistoryTranscript');
  codex = await import('../server/engines/shared/noHistoryRollout');
  parsers = await import('../server/api/session/transcriptParsers');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
const line = (value: unknown) => JSON.stringify(value) + '\n';
const user = (engine: string, text: string, id = text) => engine === 'codex'
  ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
  : { type: 'user', uuid: id, parentUuid: null, sessionId: 'fixture', message: { role: 'user', content: text } };
const fixture = (engine: string) => {
  const file = join(root, `${serial++}.jsonl`);
  writeFileSync(file, (engine === 'codex' ? line({ type: 'session_meta', payload: { id: 'fixture', cwd: root } }) : '') + line(user(engine, 'Original subject')));
  return file;
};
const read = (file: string, engine: string) => Effect.runPromise(logical.readLogicalTranscript(file, engine, (view) => view.projection));

describe('logical transcript reads', () => {
  it.each([
    ['claude', 'empty'], ['claude', 'incomplete'], ['codex', 'empty'], ['codex', 'incomplete'],
  ])('invalidates %s indexes when restoring an %s turn', async (engine, mode) => {
    const file = fixture(engine);
    const original = readFileSync(file, 'utf8');
    const stash = engine === 'codex' ? codex.stashCodexRollout : claude.stashTranscript;
    const merge = engine === 'codex' ? codex.mergeStashedCodexRollout : claude.mergeStashedTranscript;
    stash(file);
    if (mode === 'incomplete') appendFileSync(file, '{"type":');
    const before = index.transcriptGeneration(file);
    expect(merge(file)).toBe('restored');
    expect(index.transcriptGeneration(file)).toBe(before + 1);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect((await read(file, engine)).corpus.map((entry) => entry.text)).toEqual(['Original subject']);
  });
  it.each(['claude', 'codex'])('keeps %s history and details through stash and merge', async (engine) => {
    const file = fixture(engine);
    const stash = engine === 'codex' ? codex.stashCodexRollout : claude.stashTranscript;
    const merge = engine === 'codex' ? codex.mergeStashedCodexRollout : claude.mergeStashedTranscript;
    stash(file);
    expect((await read(file, engine)).userTurns).toHaveLength(1);
    appendFileSync(file, line(user(engine, 'Independent prompt')));
    const before = await read(file, engine);
    expect(before.corpus.map((entry) => entry.text)).toEqual(['Original subject', 'Independent prompt']);
    const currentBytes = readFileSync(file, 'utf8');
    const source = await Effect.runPromise(logical.readLogicalTranscript(file, engine, (view) => view.source));
    expect(typeof source).toBe('object');
    if (typeof source === 'string') throw new Error('Expected composed source');
    const records = source.text.trim().split('\n').map((entry) => JSON.parse(entry));
    if (engine === 'codex') expect(records.filter((entry) => entry.type === 'session_meta')).toHaveLength(1);
    else expect(records[1].parentUuid).toBe('Original subject');
    expect(readFileSync(file, 'utf8')).toBe(currentBytes);
    const parsed = await Effect.runPromise(logical.readLogicalTranscript(file, engine, (view) => view.source.pipe(
      Effect.flatMap((source) => Effect.promise(() => engine === 'codex' ? parsers.parseCodexTranscriptFile(source) : parsers.parseTranscriptFile(source))),
    )));
    merge(file);
    expect(readFileSync(file, 'utf8')).toBe(source.text);
    const completed = await (engine === 'codex' ? parsers.parseCodexTranscriptFile(file) : parsers.parseTranscriptFile(file));
    expect(parsed.messages.map((entry) => [entry.id, entry.content])).toEqual(completed.messages.map((entry) => [entry.id, entry.content]));
    expect((await read(file, engine)).corpus).toEqual(before.corpus);
  });

  it.each(['claude', 'codex'])('retries a %s merge between reading history and returning', async (engine) => {
    const file = fixture(engine);
    const stash = engine === 'codex' ? codex.stashCodexRollout : claude.stashTranscript;
    const merge = engine === 'codex' ? codex.mergeStashedCodexRollout : claude.mergeStashedTranscript;
    stash(file);
    appendFileSync(file, line(user(engine, 'Independent prompt')));
    let attempts = 0;
    const result = await Effect.runPromise(logical.readLogicalTranscript(file, engine, (view) => Effect.gen(function* () {
      const projection = yield* view.projection;
      if (attempts++ === 0) merge(file);
      return projection;
    })));
    expect(attempts).toBe(2);
    expect(result.corpus.map((entry) => entry.text)).toEqual(['Original subject', 'Independent prompt']);
  });

  it('retries a stash during a plain read and accepts an ordinary append without retry', async () => {
    const file = fixture('claude');
    let attempts = 0;
    const result = await Effect.runPromise(logical.readLogicalTranscript(file, 'claude', (view) => Effect.gen(function* () {
      const projection = yield* view.projection;
      if (attempts++ === 0) claude.stashTranscript(file);
      return projection;
    })));
    expect(attempts).toBe(2);
    expect(result.userTurns).toHaveLength(1);
    claude.mergeStashedTranscript(file);
    attempts = 0;
    await Effect.runPromise(logical.readLogicalTranscript(file, 'claude', (view) => Effect.gen(function* () {
      const projection = yield* view.projection;
      attempts++;
      appendFileSync(file, line(user('claude', 'Next prompt')));
      return projection;
    })));
    expect(attempts).toBe(1);
  });

  it('bounds retries when repeated rewrites invalidate the read', async () => {
    const file = fixture('claude');
    let attempts = 0;
    const result = await Effect.runPromise(Effect.either(logical.readLogicalTranscript(file, 'claude', (view) => Effect.gen(function* () {
      const value = yield* view.projection;
      attempts++;
      index.invalidateTranscript(file);
      return value;
    }))));
    expect(attempts).toBe(3);
    expect(Either.isLeft(result)).toBe(true);
  });

  it('does not reparse unchanged segments and does not read a Grok stash', async () => {
    const file = fixture('claude');
    claude.stashTranscript(file);
    appendFileSync(file, line(user('claude', 'Current prompt')));
    await read(file, 'claude');
    const before = await index.runWithTranscriptIndex((service) => service.counters);
    await read(file, 'claude');
    const after = await index.runWithTranscriptIndex((service) => service.counters);
    expect(after.bytesParsed).toBe(before.bytesParsed);
    expect((await read(file, 'grok')).corpus.map((entry) => entry.text)).toEqual(['Current prompt']);
  });
});
