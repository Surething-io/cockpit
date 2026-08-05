import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  noHistoryStashPath,
  stashTranscript,
  mergeStashedTranscript,
  recoverStashedTranscripts,
} from './noHistoryTranscript';

const SID = '11111111-2222-3333-4444-555555555555';
let projectDir: string;
let sessionPath: string;

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const readEntries = (p: string) =>
  fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

/** Two turns of history, chained the way the CLI writes them. */
const HISTORY = [
  line({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, message: { content: 'q1' } }),
  line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: SID, message: { content: 'r1' } }),
];
/** A turn written as if it were its own session — note parentUuid: null on the root. */
const TURN = [
  line({ type: 'user', uuid: 'u2', parentUuid: null, sessionId: SID, message: { content: 'q2' } }),
  line({ type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: SID, message: { content: 'r2' } }),
];

beforeEach(() => {
  projectDir = fs.mkdtempSync(join(os.tmpdir(), 'nohistory-'));
  sessionPath = join(projectDir, `${SID}.jsonl`);
});
afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('stashTranscript', () => {
  it('moves the transcript aside so the CLI starts with no context', () => {
    fs.writeFileSync(sessionPath, HISTORY.join('\n') + '\n');
    expect(stashTranscript(sessionPath)).toBe(true);
    // The whole point: the path the CLI would resume from is gone.
    expect(fs.existsSync(sessionPath)).toBe(false);
    expect(readEntries(noHistoryStashPath(sessionPath))).toHaveLength(2);
  });

  it('is a no-op for a session with no transcript yet', () => {
    expect(stashTranscript(sessionPath)).toBe(false);
    expect(fs.existsSync(noHistoryStashPath(sessionPath))).toBe(false);
  });

  it('folds in an older stash first so history is never buried', () => {
    // A previous independent turn died before merging; then a new one starts.
    fs.mkdirSync(join(projectDir, SID), { recursive: true });
    fs.writeFileSync(noHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, TURN.join('\n') + '\n');

    stashTranscript(sessionPath);

    // The stash now holds BOTH the old history and the orphaned turn, not just the turn.
    expect(readEntries(noHistoryStashPath(sessionPath)).map((e) => e.uuid)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);
  });
});

describe('mergeStashedTranscript', () => {
  it('re-links the seam so the parent chain stays continuous', () => {
    fs.mkdirSync(join(projectDir, SID), { recursive: true });
    fs.writeFileSync(noHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, TURN.join('\n') + '\n');

    expect(mergeStashedTranscript(sessionPath)).toBe('merged');

    const entries = readEntries(sessionPath);
    expect(entries.map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // The turn's root used to be parentUuid:null — a mid-file root would make the next
    // resumed turn stop walking there and silently lose the earlier half.
    expect(entries[2].parentUuid).toBe('a1');
    expect(entries[3].parentUuid).toBe('u2'); // intra-turn links untouched
    expect(entries.every((e) => e.parentUuid !== null || e === entries[0])).toBe(true);
    expect(fs.existsSync(noHistoryStashPath(sessionPath))).toBe(false);
  });

  it('restores verbatim when the turn produced nothing', () => {
    fs.mkdirSync(join(projectDir, SID), { recursive: true });
    fs.writeFileSync(noHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');

    expect(mergeStashedTranscript(sessionPath)).toBe('restored');
    expect(readEntries(sessionPath).map((e) => e.uuid)).toEqual(['u1', 'a1']);
    expect(fs.existsSync(noHistoryStashPath(sessionPath))).toBe(false);
  });

  it('does nothing when there is no stash', () => {
    fs.writeFileSync(sessionPath, HISTORY.join('\n') + '\n');
    expect(mergeStashedTranscript(sessionPath)).toBe('none');
    expect(readEntries(sessionPath)).toHaveLength(2);
  });
});

describe('recoverStashedTranscripts', () => {
  it('repairs a session left stashed by a crash', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'nohistory-root-'));
    const project = join(root, '-Users-someone-proj');
    fs.mkdirSync(join(project, SID), { recursive: true });
    const path = join(project, `${SID}.jsonl`);
    fs.writeFileSync(noHistoryStashPath(path), HISTORY.join('\n') + '\n');
    fs.writeFileSync(path, TURN.join('\n') + '\n');

    expect(recoverStashedTranscripts([root])).toBe(1);
    expect(readEntries(path).map((e) => e.uuid)).toEqual(['u1', 'a1', 'u2', 'a2']);
    // Idempotent: a second boot must not double-append.
    expect(recoverStashedTranscripts([root])).toBe(0);
    expect(readEntries(path)).toHaveLength(4);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is a no-op on a tree with nothing stashed', () => {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'nohistory-root-'));
    fs.mkdirSync(join(root, '-proj', SID), { recursive: true });
    expect(recoverStashedTranscripts([root])).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
