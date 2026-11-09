import { describe, expect, it } from 'vitest';
import { deleteClaudeTurnLines } from './deleteTurnLines';
import { parseTranscriptFile, parseUserMessageIndex } from './transcriptParsers';
import { removeRecoveryTurns } from '../../../shared/recoveryCopy';

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
  for (const queued of [false, true]) it(`deletes an image-only input at its rendered boundary, queued=${queued}`, async () => {
    const prompt = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }];
    const image = queued
      ? { type: 'attachment', uuid: 'image-wrapper', parentUuid: 'a1', attachment: { type: 'queued_command', commandMode: 'prompt', source_uuid: 'image-input', prompt } }
      : { type: 'user', uuid: 'image-wrapper', parentUuid: 'a1', message: { role: 'user', content: prompt } };
    const lines = [user('u1', null, 'One'), assistant('a1', 'u1', 'Answer one'), line(image),
      assistant('image-answer', 'image-wrapper', 'Image answer'), user('u3', 'image-answer', 'Three')];
    const parsed = await parseTranscriptFile({ text: lines.join('\n') });
    expect(parsed.messages.find(row => row.id === 'image-wrapper')?.images).toHaveLength(1);
    const deleted = deleteClaudeTurnLines(lines, 'image-wrapper');
    expect(deleted.newLines.map(row => JSON.parse(row).uuid)).toEqual(['u1', 'a1', 'u3']);
    expect(JSON.parse(deleted.newLines[2]).parentUuid).toBe('a1');
    expect(deleted.recoveryDeletion!.sourceIds).toContain(queued ? 'image-input' : 'image-wrapper');
  });

  it('keeps queued input identity across projection, navigation, deletion and replay', async () => {
    const lines = [user('first', null, 'First'), assistant('answer-first', 'first', 'First answer'),
      line({ type: 'attachment', uuid: 'wrapper', parentUuid: 'answer-first', attachment: {
        type: 'queued_command', commandMode: 'prompt', prompt: 'Queued', source_uuid: 'input-id',
      } }), assistant('answer-queued', 'wrapper', 'Queued answer'), user('next', 'answer-queued', 'Next')];
    const source = { text: lines.join('\n') };
    const parsed = await parseTranscriptFile(source);
    const queued = parsed.messages.find(row => row.content === 'Queued');
    expect(queued).toMatchObject({ id: 'wrapper', sourceId: 'input-id' });
    const index = await parseUserMessageIndex(source, 'claude');
    expect(index.entries.find(row => row.content === 'Queued')).toMatchObject({ id: 'wrapper', sourceRef: { sourceId: 'input-id' }, turnIndex: 1 });
    const deletion = deleteClaudeTurnLines(lines, queued!.id);
    expect(deletion.newLines.map(row => JSON.parse(row).uuid)).toEqual(['first', 'answer-first', 'next']);
    expect(JSON.parse(deletion.newLines[2]).parentUuid).toBe('answer-first');
    expect(deletion.recoveryDeletion!.sourceIds).toEqual(expect.arrayContaining(['wrapper', 'input-id', 'answer-queued']));
    const recovery = [{ id: 'live-queued', role: 'user' as const, sourceId: 'input-id', content: 'Queued' },
      { id: 'live-answer', role: 'assistant' as const, content: 'Unsaved output' },
      { id: 'not-consumed', role: 'user' as const, content: 'Next queued input' }];
    expect(removeRecoveryTurns(recovery, deletion.recoveryDeletion!)).toEqual([recovery[2]]);
    expect(removeRecoveryTurns(removeRecoveryTurns(recovery, deletion.recoveryDeletion!), deletion.recoveryDeletion!)).toEqual([recovery[2]]);
    expect(deleteClaudeTurnLines(lines, 'first').newLines.map(row => JSON.parse(row).uuid)).toEqual(['wrapper', 'answer-queued', 'next']);
  });

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
    expect(result.recoveryDeletion).toEqual({ sourceIds: ['u2', 'a2'], taskIds: [] });
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
