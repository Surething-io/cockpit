import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import {
  codexNoHistoryStashPath,
  stashCodexRollout,
  mergeStashedCodexRollout,
  recoverStashedCodexRollouts,
} from './noHistoryRollout';

const SID = '11111111-2222-3333-4444-555555555555';
let root: string;
let sessionPath: string;

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const readEntries = (p: string) =>
  fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const META = line({
  timestamp: '2026-08-08T00:00:00.000Z',
  type: 'session_meta',
  payload: { id: SID, cwd: '/repo', source: 'exec', thread_source: 'user' },
});
const HISTORY = [
  META,
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'old' }] } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
];
const TURN = [
  META,
  line({ type: 'turn_context', payload: { turn_id: 'turn-2' } }),
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new' }] } }),
];

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'codex-nohistory-'));
  sessionPath = join(root, 'rollout-2026-08-08T00-00-00-11111111-2222-3333-4444-555555555555.jsonl');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('stashCodexRollout', () => {
  it('replaces the rollout with a session_meta-only stub', () => {
    fs.writeFileSync(sessionPath, HISTORY.join('\n') + '\n');

    expect(stashCodexRollout(sessionPath)).toBe(true);

    expect(readEntries(sessionPath)).toEqual([JSON.parse(META)]);
    expect(readEntries(codexNoHistoryStashPath(sessionPath))).toHaveLength(3);
  });

  it('is a no-op when the rollout does not exist', () => {
    expect(stashCodexRollout(sessionPath)).toBe(false);
    expect(fs.existsSync(sessionPath)).toBe(false);
  });

  it('fails closed when the rollout has no session_meta', () => {
    fs.writeFileSync(sessionPath, line({ type: 'response_item', payload: {} }) + '\n');

    expect(() => stashCodexRollout(sessionPath)).toThrow('has no session_meta');
  });

  it('folds in an older stash before creating a new stub', () => {
    fs.writeFileSync(codexNoHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, TURN.join('\n') + '\n');

    expect(stashCodexRollout(sessionPath)).toBe(true);

    const stashed = readEntries(codexNoHistoryStashPath(sessionPath));
    expect(stashed.filter((entry) => entry.type === 'session_meta')).toHaveLength(1);
    expect(stashed.map((entry) => entry.type)).toEqual([
      'session_meta',
      'response_item',
      'response_item',
      'turn_context',
      'response_item',
    ]);
  });
});

describe('mergeStashedCodexRollout', () => {
  it('appends the independent turn without duplicating session_meta', () => {
    fs.writeFileSync(codexNoHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, TURN.join('\n') + '\n');

    expect(mergeStashedCodexRollout(sessionPath)).toBe('merged');

    const entries = readEntries(sessionPath);
    expect(entries.filter((entry) => entry.type === 'session_meta')).toHaveLength(1);
    expect(entries.map((entry) => entry.type)).toEqual([
      'session_meta',
      'response_item',
      'response_item',
      'turn_context',
      'response_item',
    ]);
    expect(fs.existsSync(codexNoHistoryStashPath(sessionPath))).toBe(false);
  });

  it('restores the original rollout when the turn produced no lines', () => {
    fs.writeFileSync(codexNoHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, META + '\n');

    expect(mergeStashedCodexRollout(sessionPath)).toBe('restored');
    expect(readEntries(sessionPath).map((entry) => entry.type)).toEqual([
      'session_meta',
      'response_item',
      'response_item',
    ]);
  });

  it('restores the original rollout when the isolated turn has an incomplete JSON line', () => {
    fs.writeFileSync(codexNoHistoryStashPath(sessionPath), HISTORY.join('\n') + '\n');
    fs.writeFileSync(sessionPath, `${META}\n${TURN[1]}\n{"type":"response_item"\n`);

    expect(mergeStashedCodexRollout(sessionPath)).toBe('restored');
    expect(readEntries(sessionPath).map((entry) => entry.type)).toEqual([
      'session_meta',
      'response_item',
      'response_item',
    ]);
    expect(fs.existsSync(codexNoHistoryStashPath(sessionPath))).toBe(false);
  });

  it('does nothing when there is no stash', () => {
    fs.writeFileSync(sessionPath, HISTORY.join('\n') + '\n');
    expect(mergeStashedCodexRollout(sessionPath)).toBe('none');
  });
});

describe('recoverStashedCodexRollouts', () => {
  it('repairs a rollout left stashed by a crash', () => {
    const nested = join(root, '2026', '08', '08');
    fs.mkdirSync(nested, { recursive: true });
    const path = join(nested, 'rollout-2026-08-08T00-00-00-11111111-2222-3333-4444-555555555555.jsonl');
    fs.writeFileSync(codexNoHistoryStashPath(path), HISTORY.join('\n') + '\n');
    fs.writeFileSync(path, TURN.join('\n') + '\n');

    expect(recoverStashedCodexRollouts(root)).toBe(1);
    expect(recoverStashedCodexRollouts(root)).toBe(0);
  });
});
