import { describe, expect, it } from 'vitest';
import { deleteClaudeTurnLines } from './deleteTurnLines';

const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
const user = (uuid: string, parentUuid: string | null, text: string) => line({
  type: 'user',
  uuid,
  parentUuid,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistant = (uuid: string, parentUuid: string, text: string) => line({
  type: 'assistant',
  uuid,
  parentUuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

describe('deleteClaudeTurnLines', () => {
  it('deletes the target turn and reconnects the following parent chain', () => {
    const lines = [
      user('u1', null, 'one'),
      assistant('a1', 'u1', 'answer one'),
      user('u2', 'a1', 'two'),
      assistant('a2', 'u2', 'answer two'),
      user('u3', 'a2', 'three'),
      assistant('a3', 'u3', 'answer three'),
    ];

    const result = deleteClaudeTurnLines(lines, 'a2');

    expect(result.targetMissed).toBe(false);
    expect(result.deletedLineCount).toBe(2);
    expect(result.newLines.join('\n')).not.toContain('answer two');
    expect(JSON.parse(result.newLines[2]).parentUuid).toBe('a1');
    expect(JSON.parse(result.newLines[3]).parentUuid).toBe('u3');
  });

  it('keeps harness-injected user records inside the surrounding turn', () => {
    const injected = line({
      type: 'user',
      uuid: 'notification',
      parentUuid: 'a1',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'background update' }] },
    });
    const result = deleteClaudeTurnLines([
      user('u1', null, 'one'),
      assistant('a1', 'u1', 'answer one'),
      injected,
      user('u2', 'notification', 'two'),
    ], 'u1');

    expect(result.deletedLineCount).toBe(3);
    expect(result.newLines).toHaveLength(1);
    expect(JSON.parse(result.newLines[0]).parentUuid).toBe(null);
  });

  it('does not produce replacement content when the target is missing', () => {
    const result = deleteClaudeTurnLines([user('u1', null, 'one')], 'missing');
    expect(result).toEqual({ newLines: [], deletedLineCount: 0, targetMissed: true });
  });
});
