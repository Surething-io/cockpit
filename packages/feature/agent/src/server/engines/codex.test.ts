import { describe, expect, it } from 'vitest';
import { codexToolUseId } from './codex';

describe('codexToolUseId', () => {
  it('prefers call_id so live snapshots match persisted Codex history', () => {
    expect(codexToolUseId({ id: 'item_1', call_id: 'call_1' })).toBe('call_1');
  });

  it('falls back to item id', () => {
    expect(codexToolUseId({ id: 'item_1' })).toBe('item_1');
  });
});
