import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Effect } from 'effect';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-tw-'));
process.env.COCKPIT_HOME = path.join(root, 'cockpit');

type Index = import('@cockpit/effect-services').TranscriptIndex;
let live: typeof import('../effect/transcriptIndexLive');
let services: typeof import('@cockpit/effect-services');
let views: typeof import('./transcriptViews');
let write: typeof import('./transcriptWrite');

const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
const run = <A>(f: (i: Index) => Effect.Effect<A, never>) =>
  Effect.runPromise(Effect.flatMap(services.TranscriptIndex, f).pipe(Effect.provide(live.TranscriptIndexLive)));
// Windows has no POSIX permission bits: every file reports 0o666.
const ownerOnly = process.platform === 'win32' ? 0o666 : 0o600;
const messages = async (p: string) => views.previewMessages((await run((i) => i.snapshot(p, 'claude')))!);

beforeAll(async () => {
  services = await import('@cockpit/effect-services');
  live = await import('../effect/transcriptIndexLive');
  views = await import('./transcriptViews');
  write = await import('./transcriptWrite');
});

// A front edit that keeps the size and the indexed tail bytes is invisible to any
// read-side check; the rewrite contract is what makes the index rebuild.
const longTail = 'x'.repeat(200);
const original = user('old!') + user(longTail);
const edited = user('new!') + user(longTail);

describe('rewriteTranscript', () => {
  it('a same-size edit before the indexed tail is picked up (async)', async () => {
    const p = path.join(root, 'a.jsonl');
    fs.writeFileSync(p, original);
    expect(await messages(p)).toEqual(['old!', longTail]);
    await write.rewriteTranscript(p, edited);
    expect(await messages(p)).toEqual(['new!', longTail]);
  });

  it('a same-size edit before the indexed tail is picked up (sync)', async () => {
    const p = path.join(root, 'b.jsonl');
    fs.writeFileSync(p, original);
    expect(await messages(p)).toEqual(['old!', longTail]);
    write.rewriteTranscriptSync(p, edited);
    expect(await messages(p)).toEqual(['new!', longTail]);
  });

  it('replaces the file (new inode), keeps its mode, leaves no temp file', async () => {
    const p = path.join(root, 'c.jsonl');
    fs.writeFileSync(p, original, { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    const before = fs.statSync(p);
    await write.rewriteTranscript(p, edited);
    const after = fs.statSync(p);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(ownerOnly);
    expect(fs.readFileSync(p, 'utf8')).toBe(edited);
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('creates a missing transcript, owner-only, parents included', async () => {
    const p = path.join(root, 'new', 'dir', 'd.jsonl');
    write.rewriteTranscriptSync(p, user('hi'));
    expect(fs.statSync(p).mode & 0o777).toBe(ownerOnly);
    expect(await messages(p)).toEqual(['hi']);
  });
});
