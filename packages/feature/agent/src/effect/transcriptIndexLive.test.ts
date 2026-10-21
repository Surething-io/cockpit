// Over a throwaway COCKPIT_HOME: paths.ts reads it at module load, so the env is
// set before the modules are imported.
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Effect } from 'effect';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ti-'));
process.env.COCKPIT_HOME = path.join(root, 'cockpit');

type LiveMod = typeof import('./transcriptIndexLive');
type Services = typeof import('@cockpit/effect-services');
type Views = typeof import('../server/transcriptViews');
let live: LiveMod;
let services: Services;
let views: Views;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', sessionId: 's1', timestamp: '2026-09-01T03:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (model: string, input: number, tools = 0) =>
  line({
    type: 'assistant',
    sessionId: 's1',
    timestamp: '2026-09-01T03:00:05.000Z',
    message: {
      model,
      usage: { input_tokens: input, output_tokens: 1 },
      content: [{ type: 'text', text: 'ok' }, ...Array.from({ length: tools }, () => ({ type: 'tool_use' }))],
    },
  });

type Index = import('@cockpit/effect-services').TranscriptIndex;
const run = <A>(f: (i: Index) => Effect.Effect<A, never>) =>
  Effect.runPromise(Effect.flatMap(services.TranscriptIndex, f).pipe(Effect.provide(live.TranscriptIndexLive)));
const snap = (p: string, format: 'claude' | 'codex' = 'claude') => run((i) => i.snapshot(p, format));
const counters = () => run((i) => i.counters);

/** Bytes parsed by `f`, measured on the index's own counter. */
const parsedBy = async (f: () => Promise<unknown>) => {
  const before = await counters();
  await f();
  const after = await counters();
  return { bytes: after.bytesParsed - before.bytesParsed, rebuilds: after.rebuilds - before.rebuilds };
};

let n = 0;
const newFile = (text: string) => {
  const p = path.join(root, `t${n++}.jsonl`);
  fs.writeFileSync(p, text);
  return p;
};

beforeAll(async () => {
  services = await import('@cockpit/effect-services');
  live = await import('./transcriptIndexLive');
  views = await import('../server/transcriptViews');
});

describe('TranscriptIndex refresh', () => {
  it('parses a file once: an unchanged file costs no bytes', async () => {
    const p = newFile(line({ type: 'ai-title', aiTitle: 'T' }) + user('hello', { cwd: '/w' }));
    const first = await parsedBy(() => snap(p));
    expect(first.bytes).toBe(fs.statSync(p).size);
    const s = await snap(p);
    expect(s?.aiTitle).toBe('T');
    expect(s?.cwd).toBe('/w');
    expect((await parsedBy(() => snap(p))).bytes).toBe(0);
  });

  it('parses only the appended bytes', async () => {
    const p = newFile(user('one'));
    await snap(p);
    const added = user('two');
    fs.appendFileSync(p, added);
    const r = await parsedBy(() => snap(p));
    expect(r).toEqual({ bytes: Buffer.byteLength(added), rebuilds: 0 });
    expect(views.previewMessages((await snap(p))!)).toEqual(['one', 'two']);
  });

  it('leaves a half-written line for the next read', async () => {
    const p = newFile(user('one'));
    await snap(p);
    const full = user('two');
    fs.appendFileSync(p, full.slice(0, 10));
    expect(views.previewMessages((await snap(p))!)).toEqual(['one']);
    fs.appendFileSync(p, full.slice(10));
    expect(views.previewMessages((await snap(p))!)).toEqual(['one', 'two']);
  });

  it('rebuilds when the file is truncated', async () => {
    const p = newFile(user('one') + user('two'));
    await snap(p);
    fs.writeFileSync(p, user('x'));
    const r = await parsedBy(() => snap(p));
    expect(r.rebuilds).toBe(1);
    expect(views.previewMessages((await snap(p))!)).toEqual(['x']);
  });

  it('rebuilds when the file is replaced (new inode)', async () => {
    const p = newFile(user('one'));
    await snap(p);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, user('one') + user('rewritten'));
    fs.renameSync(tmp, p);
    expect((await parsedBy(() => snap(p))).rebuilds).toBe(1);
    expect(views.previewMessages((await snap(p))!)).toEqual(['one', 'rewritten']);
  });

  it('rebuilds when already-indexed bytes are edited in place', async () => {
    const p = newFile(user('aaaa') + user('bbbb'));
    await snap(p);
    const text = fs.readFileSync(p, 'utf8').replace('bbbb', 'cccc') + user('dddd');
    fs.writeFileSync(p, text); // same inode, grown, but the anchor bytes changed
    expect((await parsedBy(() => snap(p))).rebuilds).toBe(1);
    expect(views.previewMessages((await snap(p))!)).toEqual(['aaaa', 'cccc', 'dddd']);
  });

  it('returns null for a missing file', async () => {
    expect(await snap(path.join(root, 'nope.jsonl'))).toBeNull();
  });
});

describe('TranscriptIndex persistence', () => {
  it('a fresh process resumes from the persisted shard instead of re-parsing', async () => {
    const p = newFile(user('persisted'));
    await snap(p);
    // Wait out the flush debounce.
    await Effect.runPromise(Effect.sleep('3500 millis'));
    const shards = fs.readdirSync(path.join(process.env.COCKPIT_HOME!, 'transcript-index'));
    expect(shards.length).toBeGreaterThan(0);

    // Simulate a restart: drop the pinned process state and reload the module.
    delete (globalThis as { __cockpitTranscriptIndex?: unknown }).__cockpitTranscriptIndex;
    vi.resetModules();
    services = await import('@cockpit/effect-services');
    live = await import('./transcriptIndexLive');

    const r = await parsedBy(() => snap(p));
    expect(r.bytes).toBe(0);
    expect(views.previewMessages((await snap(p))!)).toEqual(['persisted']);
  }, 10_000);
});

describe('claude adapter + views', () => {
  it('keeps the per-view filtering rules', async () => {
    const p = newFile(
      user('<command-name>/x</command-name>real') +
        user([{ type: 'text', text: '' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }]) +
        user('Caveat: The messages below were generated', { isMeta: true }) +
        user([{ type: 'tool_result', content: 'ignored' }]) +
        line({ type: 'summary', summary: 'S' })
    );
    const s = (await snap(p))!;
    expect(s.summary).toBe('S');
    // preview: first non-empty block, command tags stripped, injected context dropped
    expect(views.previewMessages(s)).toEqual(['real', 'first']);
    // list: meta skipped, all text blocks joined with ' ', no tag stripping
    expect(views.listMessages(s)).toEqual(['<command-name>/x</command-name>real', ' first second']);
    // title: every non-empty block, unfiltered
    expect(views.titleMessages(s)).toEqual([
      '<command-name>/x</command-name>real',
      'first',
      'second',
      'Caveat: The messages below were generated',
    ]);
  });

  it('keeps a line whose JSON holds a raw U+2028 / U+2029 intact', async () => {
    // JSON.stringify leaves both unescaped; readline treats them as line breaks and
    // used to split such a line into unparseable fragments, silently dropping it.
    const p = newFile(user('a b c') + assistant('m1', 7));
    const s = (await snap(p))!;
    expect(views.previewMessages(s)).toEqual(['a b c']);
    expect(s.stats.modelUsage.m1.inputTokens).toBe(7);
  });

  it('folds usage stats that merge like the old full scan', async () => {
    const a = newFile(user('q') + assistant('m1', 10, 2));
    const b = newFile(line({ type: 'user', sessionId: 's2', timestamp: '2026-09-02T03:00:00.000Z', message: { content: 'r' } }) + assistant('m1', 5));
    const stats = views.mergeStats([(await snap(a))!.stats, (await snap(b))!.stats]);
    expect(stats.totalSessions).toBe(2);
    expect(stats.totalMessages).toBe(4);
    expect(stats.modelUsage.m1.inputTokens).toBe(15);
    expect(stats.dailyActivity.map((d) => [d.date, d.messageCount, d.toolCallCount])).toEqual([
      ['2026-09-01', 1, 2],
      ['2026-09-02', 1, 0],
    ]);
    expect(stats.firstSessionDate).toBe('2026-09-01');
  });
});

describe('total decoding', () => {
  const codexUser = (content: unknown) =>
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content } });

  it('a malformed codex record costs that line, not the session', async () => {
    const p = newFile(
      codexUser([{ type: 'input_text', text: 'before' }]) +
        codexUser('bad shape') +
        codexUser([null, 7, { type: 'input_text', text: 42 }]) +
        codexUser([{ type: 'input_text', text: 'after' }])
    );
    const s = await snap(p, 'codex');
    expect(s).not.toBeNull();
    expect(views.previewMessages(s!)).toEqual(['before', 'after']);
  });

  it('a malformed claude record costs that line; string usage cannot corrupt counts', async () => {
    const p = newFile(
      user('before') +
        line({ type: 'user', message: { content: { not: 'a string or array' } } }) +
        line({ type: 'assistant', message: { model: 'm9', usage: { input_tokens: '1000', output_tokens: 2 }, content: 'x' } }) +
        '{"type":"user","message":' + '\n' +
        user('after')
    );
    const s = (await snap(p))!;
    expect(views.previewMessages(s)).toEqual(['before', 'after']);
    expect(s.stats.modelUsage.m9).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
    });
  });

  it('decoders never throw on arbitrary JSON (property)', () => {
    // Deterministic generator: nested values of every JSON shape under the keys the
    // decoders look at.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const keys = ['type', 'message', 'content', 'payload', 'role', 'text', 'usage', 'model', 'isMeta', 'cwd', 'timestamp', 'sessionId', 'aiTitle', 'summary', 'input_tokens'];
    const value = (depth: number): unknown => {
      const r = rnd();
      if (depth > 3 || r < 0.15) return null;
      if (r < 0.3) return Math.floor(rnd() * 100) - 50;
      if (r < 0.45) return ['user', 'assistant', 'text', 'response_item', 'message', 'input_text', 'output_text', 'tool_use', ''][Math.floor(rnd() * 9)];
      if (r < 0.55) return rnd() < 0.5;
      if (r < 0.75) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 1 + Math.floor(rnd() * 4); i++) o[keys[Math.floor(rnd() * keys.length)]] = value(depth + 1);
      return o;
    };
    for (let i = 0; i < 10_000; i++) {
      const text = JSON.stringify(value(0));
      expect(() => live.decodeClaudeLine(text)).not.toThrow();
      expect(() => live.decodeCodexLine(text)).not.toThrow();
      const state = live.emptyFoldState();
      expect(() => live.foldLine(state, 'claude', text)).not.toThrow();
      expect(() => live.foldLine(state, 'codex', text)).not.toThrow();
    }
  });
});

describe('round-3 review regressions', () => {
  // Keys that collide with Object.prototype members, fed through every field that
  // becomes a dictionary key (date, session id, model).
  const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

  it.each(hostile)('key %s in timestamp / sessionId / model neither throws nor pollutes', async (key) => {
    const p = newFile(
      user('before') +
        line({ type: 'user', sessionId: key, timestamp: key, message: { content: 'mid' } }) +
        line({ type: 'assistant', sessionId: key, timestamp: '2026-09-01T00:00:00Z', message: { model: key, usage: { input_tokens: 3 }, content: [] } }) +
        user('after')
    );
    const s = (await snap(p))!;
    expect(views.previewMessages(s)).toEqual(['before', 'mid', 'after']);
    expect(({} as Record<string, unknown>).messages).toBeUndefined();
    expect((Object as unknown as Record<string, unknown>).inputTokens).toBeUndefined();
    const merged = views.mergeStats([s.stats, s.stats]);
    expect(views.getOwn(merged.modelUsage, key)?.inputTokens).toBe(6);
    expect(merged.dailyActivity.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))).toBe(true);
  });

  it.each([
    ['input_text.text is a number', { type: 'input_text', text: 42 }],
    ['input_image.image_url is a number', { type: 'input_image', image_url: 42 }],
    ['input_text.text is an object', { type: 'input_text', text: { a: 1 } }],
    ['output_text.text is null', { type: 'output_text', text: null }],
  ])('codex decoder returns a value, never throws, when %s', (_name, block) => {
    for (const role of ['user', 'assistant']) {
      const text = JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content: [block, { type: 'input_text', text: 'ok' }] } });
      expect(() => live.decodeCodexLine(text)).not.toThrow();
    }
  });

  it('a prompt queued while a run was busy is searchable (corpus), not listed', async () => {
    const p = newFile(
      user('first') +
        line({ type: 'attachment', sessionId: 's1', timestamp: '2026-09-01T00:00:01Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'queued-only-needle' } })
    );
    const s = (await snap(p))!;
    expect(s.corpus.map((l) => l.text)).toEqual(['first', 'queued-only-needle']);
    expect(views.listMessages(s)).toEqual(['first']);
    expect(views.previewMessages(s)).toEqual(['first']);
  });
});

describe('corpus lines', () => {
  it('codex: an image prompt is searchable by its text; a failed turn by its banner', async () => {
    const p = newFile(
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '<image name=[Image #1] path="/tmp/a.png">' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: '</image>' },
        { type: 'input_text', text: 'why does the tree not scroll' },
      ] } }) +
        line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'because' }] } }) +
        line({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'usage limit hit' } } })
    );
    const s = (await snap(p, 'codex'))!;
    expect(s.corpus.map((l) => [l.role, l.text])).toEqual([
      ['user', 'why does the tree not scroll'],
      ['assistant', 'because'],
      ['assistant', '⚠️ usage limit hit'],
    ]);
  });

  it('claude: prompts and reply text, not meta lines or tool output', async () => {
    const p = newFile(
      user('find the leak') +
        user('Caveat: injected', { isMeta: true }) +
        user([{ type: 'tool_result', content: 'huge tool output' }]) +
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'found it' }, { type: 'tool_use', name: 'Bash' }] } })
    );
    expect((await snap(p))!.corpus.map((l) => [l.role, l.text])).toEqual([
      ['user', 'find the leak'],
      ['assistant', 'found it'],
    ]);
  });
});

describe('codex adapter + views', () => {
  const rollout = (content: unknown[]) =>
    line({ type: 'response_item', payload: { type: 'message', role: 'user', content } });

  it('drops system text, keeps image-only turns for the list', async () => {
    const p = newFile(
      line({ type: 'session_meta', payload: { id: 'x', cwd: '/w' } }) +
        rollout([{ type: 'input_text', text: '<environment_context>…' }]) +
        rollout([{ type: 'input_text', text: 'fix the bug' }]) +
        rollout([{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }])
    );
    const s = (await snap(p, 'codex'))!;
    expect(views.previewMessages(s)).toEqual(['fix the bug']);
    expect(views.codexTitle(s)).toBe('fix the bug');
    expect(views.listMessages(s)).toEqual(['fix the bug', '[Image]']);
  });
});
