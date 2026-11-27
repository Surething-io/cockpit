import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNativeSessionModel } from './sessionModel';

const dir = mkdtempSync(join(tmpdir(), 'cockpit-native-model-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, rows: unknown[]) => {
  const path = join(dir, name);
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
};

describe('readNativeSessionModel', () => {
  it('takes the latest real model a Claude transcript ran on', async () => {
    const path = file('claude.jsonl', [
      { type: 'assistant', message: { model: 'claude-sonnet-5-5' } },
      { type: 'user', message: { content: 'switch' } },
      { type: 'assistant', message: { model: 'claude-opus-5-5' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
    ]);
    expect(await readNativeSessionModel('claude', path)).toBe('claude-opus-5-5');
  });

  it('takes the latest turn_context model of a Codex rollout', async () => {
    const path = file('codex.jsonl', [
      { type: 'turn_context', payload: { model: 'gpt-old' } },
      { type: 'response_item', payload: { type: 'message' } },
      { type: 'turn_context', payload: { model: 'gpt-6.2-sol' } },
    ]);
    expect(await readNativeSessionModel('codex', path)).toBe('gpt-6.2-sol');
  });

  it('is undefined for other engines, missing files and transcripts without one', async () => {
    expect(await readNativeSessionModel('grok', file('g.jsonl', [{ type: 'assistant', message: { model: 'x' } }]))).toBeUndefined();
    expect(await readNativeSessionModel('claude', join(dir, 'missing.jsonl'))).toBeUndefined();
    expect(await readNativeSessionModel('claude', file('empty.jsonl', [{ type: 'user' }]))).toBeUndefined();
  });
});
