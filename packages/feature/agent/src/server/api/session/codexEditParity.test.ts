import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeMessageTurn } from '../../../shared/chatTurns';

const root = mkdtempSync(join(tmpdir(), 'cockpit-codex-edit-parity-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
let parser: typeof import('./transcriptParsers');
let edits: typeof import('./codexFork');
beforeAll(async () => { parser = await import('./transcriptParsers'); edits = await import('./codexFork'); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const encode = (value: unknown) => JSON.stringify(value);
const say = (role: string, text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

describe('Codex displayed IDs select the same edit turn', () => {
  it('uses the whole steered task for pagination, every input index, forks and deletion', async () => {
    const started = { type: 'event_msg', payload: { type: 'task_started' } };
    const tasks = [
      [started, say('user', 'Previous'), say('assistant', 'Previous answer')],
      [started, say('user', 'Original'), say('assistant', 'Working'),
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch', input: '*** Begin Patch\n*** End Patch' } },
        say('user', 'Additional steering'),
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'patch', output: 'Done' } },
        say('assistant', 'Continued answer'),
        { type: 'event_msg', payload: { type: 'task_complete' } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'commandExecution', id: 'late', command: 'pwd', aggregatedOutput: '/tmp', exitCode: 0 } } }],
      // No user: the next task must still close the preceding assistant bubble.
      [started, say('assistant', 'Autonomous follow-up')],
    ].map((task) => task.map(encode));
    const meta = encode({ type: 'session_meta', payload: { id: 'parent', cwd: root } });
    const lines = [meta, ...tasks.flat()];
    const source = { text: lines.join('\n') };
    const { messages } = await parser.parseCodexTranscriptFile(source);
    const turns = parser.splitTurns(messages);
    expect(turns).toHaveLength(3);
    expect(turns[1].filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['Original', 'Additional steering']);
    expect(turns[1].every((m) => m.turnUserCount === 2)).toBe(true);
    expect(turns[1].flatMap((m) => m.toolCalls ?? []).map((tool) => tool.id)).toContain('late');
    expect(parser.pageTurns(messages, { limit: 1, beforeTurnIndex: 2 }).messages).toEqual(turns[1]);
    const index = await parser.parseUserMessageIndex(source, 'codex');
    expect(index.totalTurns).toBe(3);
    expect(index.entries.map((entry) => [entry.content, entry.turnIndex])).toEqual([['Previous', 0], ['Original', 1], ['Additional steering', 1]]);
    for (const entry of index.entries) {
      expect(parser.pageTurns(messages, { fromTurnIndex: entry.turnIndex }).messages.some((m) => m.id === entry.id)).toBe(true);
    }
    for (const [turnIndex, turn] of turns.entries()) {
      for (const message of turn) {
        const fork = edits.buildCodexForkLines(lines, 'parent', 'child', message.id, 'single');
        expect(fork.targetMissed).toBe(false);
        expect(fork.newLines.slice(1)).toEqual(tasks[turnIndex]);
        const deleted = edits.deleteCodexTurnLines(lines, message.id);
        expect(deleted.targetMissed).toBe(false);
        expect(deleted.newLines).toEqual([meta, ...tasks.filter((_, i) => i !== turnIndex).flat()]);
        const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
        expect(removeMessageTurn(messages, message.id).map((m) => [m.role, m.content])).toEqual(remaining.messages.map((m) => [m.role, m.content]));
      }
    }
  });

  it('treats a rollout without task markers as one atomic edit unit', async () => {
    const lines = [{ type: 'session_meta', payload: { id: 'parent', cwd: root } },
      say('user', 'Original'), say('assistant', 'Working'), say('user', 'Steering'), say('assistant', 'Done')].map(encode);
    const source = { text: lines.join('\n') };
    const { messages } = await parser.parseCodexTranscriptFile(source);
    expect(parser.pageTurns(messages, { limit: 1 })).toMatchObject({ totalTurns: 1, hasMore: false, messages });
    expect((await parser.parseUserMessageIndex(source, 'codex')).entries.map((entry) => entry.turnIndex)).toEqual([0, 0]);
    for (const message of messages) {
      expect(removeMessageTurn(messages, message.id)).toEqual([]);
      expect(edits.deleteCodexTurnLines(lines, message.id).newLines).toEqual([lines[0]]);
    }
  });

  it('removes the only notice-first turn from the client and the transcript', async () => {
    const lines = [
      { type: 'session_meta', payload: { id: 'parent', cwd: root } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Unknown system content' }, { type: 'input_text', text: 'Question' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: [],
          content_item_metadata: [{ provenance: { type: 'harness', hook: false } }, { provenance: { type: 'user' } }],
        },
      } },
      say('assistant', 'Answer'),
    ].map(encode);
    const { messages } = await parser.parseCodexTranscriptFile({ text: lines.join('\n') });
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages[0].systemEvent?.kind).toBe('meta');
    expect(parser.splitTurns(messages)).toHaveLength(1);
    for (const message of messages) {
      expect(removeMessageTurn(messages, message.id)).toEqual([]);
      const deleted = edits.deleteCodexTurnLines(lines, message.id);
      expect(deleted.targetMissed).toBe(false);
      const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
      expect(remaining.messages).toEqual([]);
    }
    expect(removeMessageTurn(messages, 'missing')).toBe(messages);
  });
  it.each(['user-first', 'notice-first', 'interleaved'] as const)('keeps %s mixed input ordered and in one task', async (order) => {
    const note = '<subagent_notification>\n{"agent_path":"child","status":{"completed":"Second-task report"}}\n</subagent_notification>';
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AAAA' };
    const userBlocks = [{ type: 'input_text', text: 'second' }, image];
    const notification = { type: 'input_text', text: note };
    const content = order === 'notice-first' ? [notification, ...userBlocks]
      : order === 'interleaved' ? [userBlocks[0], notification, image, { type: 'input_text', text: ' continued' }]
        : [...userBlocks, notification];
    const kinds = content.map((block) => block === notification ? 'multi_agent.subagent_notification' : block.type === 'input_image' ? 'user.image' : 'user.text');
    const lines = [
      { type: 'session_meta', payload: { id: 'parent', cwd: root } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      say('user', 'first'), say('assistant', 'first reply'),
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content,
        internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } },
      say('assistant', 'second reply'),
    ].map(encode);
    const source = { text: lines.join('\n') };
    const { messages } = await parser.parseCodexTranscriptFile(source);
    const turns = parser.splitTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].map((m) => m.content)).toEqual(['first', 'first reply']);
    expect(turns[1].map((m) => m.role)).toEqual(order === 'notice-first' ? ['system', 'user', 'assistant'] : ['user', 'system', 'assistant']);
    const user = turns[1].find((m) => m.role === 'user')!;
    expect(user.content).toBe(order === 'interleaved' ? 'second continued' : 'second');
    expect(user.images).toHaveLength(1);
    expect(parser.pageTurns(messages, { limit: 1 }).messages).toEqual(turns[1]);
    const index = await parser.parseUserMessageIndex(source, 'codex');
    expect(index.entries.map((entry) => [entry.content, entry.turnIndex])).toEqual([['first', 0], [user.content, 1]]);

    for (const message of turns[1]) {
      const fork = edits.buildCodexForkLines(lines, 'parent', 'child', message.id, 'single');
      expect(fork.targetMissed).toBe(false);
      const copied = await parser.parseCodexTranscriptFile({ text: fork.newLines.join('\n') });
      expect(parser.splitTurns(copied.messages)).toHaveLength(1);
      expect(copied.messages.map((m) => [m.role, m.content])).toEqual(turns[1].map((m) => [m.role, m.content]));
      const deleted = edits.deleteCodexTurnLines(lines, message.id);
      expect(deleted.targetMissed).toBe(false);
      const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
      expect(remaining.messages.map((m) => m.content)).toEqual(['first', 'first reply']);
      expect(removeMessageTurn(messages, message.id).map((m) => [m.role, m.content])).toEqual(remaining.messages.map((m) => [m.role, m.content]));
    }
  });

  it('keeps source-classified prompts and notification segments in their actual task', async () => {
    const pasted = '<recommended_plugins>\nUser-pasted example\n</recommended_plugins>';
    const note = '<subagent_notification>\n{"agent_path":"child","status":{"completed":"Report ready\\n\\nEvidence"}}\n</subagent_notification>';
    const sourced = (texts: string[], kinds: string[]) => ({
      type: 'response_item', payload: { type: 'message', role: 'user',
        content: texts.map((text) => ({ type: 'input_text', text })),
        internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
      },
    });
    const lines = [
      { type: 'session_meta', payload: { id: 'parent', cwd: root } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      { type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '# AGENTS.md instructions for /example\n\n<INSTRUCTIONS>\nProject rules\n</INSTRUCTIONS>' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['agents_md.instructions'],
          content_item_metadata: [{ provenance: { type: 'agents_md' } }],
        },
      } },
      sourced([pasted, '<environment_context>context</environment_context>'], ['plugins.recommendations', 'environments.environment_context']),
      sourced([pasted], ['user.text']), say('assistant', 'Before notification'),
      sourced([note], ['multi_agent.subagent_notification']), say('assistant', 'After notification'),
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      say('user', 'Next request'), say('assistant', 'Next answer'),
    ].map(encode);
    const { messages, title } = await parser.parseCodexTranscriptFile({ text: lines.join('\n') });
    expect(title).toBe(pasted);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'system', 'assistant', 'user', 'assistant']);
    expect(parser.splitTurns(messages)).toHaveLength(2);
    expect(messages[2]).toMatchObject({ content: 'Report ready', systemEvent: { kind: 'task-notification', status: 'completed' } });
    expect(messages[2].systemEvent?.detail).toContain('Report ready\n\nEvidence');
    expect(messages[2].systemEvent?.detail).toContain(note);

    for (const [index, message] of messages.entries()) {
      const turn = index < 4 ? 0 : 1;
      const deleted = edits.deleteCodexTurnLines(lines, message.id);
      expect(deleted.targetMissed).toBe(false);
      const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
      expect(remaining.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(turn === 0 ? ['Next request'] : [pasted]);
      for (const scope of ['prefix', 'single'] as const) {
        const fork = edits.buildCodexForkLines(lines, 'parent', 'child', message.id, scope);
        expect(fork.targetMissed).toBe(false);
        const copied = await parser.parseCodexTranscriptFile({ text: fork.newLines.join('\n') });
        expect(copied.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(scope === 'prefix' && turn === 1 ? [pasted, 'Next request'] : [turn === 0 ? pasted : 'Next request']);
        expect(copied.messages.filter((m) => m.role === 'system')).toHaveLength(scope === 'prefix' || turn === 0 ? 1 : 0);
      }
    }
  });

  it.each(['# Check login', '<config>debug</config>'])('deletes and forks %s using actual parser IDs', async (prompt) => {
    const prompts = [prompt, `${prompt} again`, 'ordinary'];
    const lines = [
      { type: 'session_meta', payload: { id: 'parent', cwd: root } },
      say('user', '# AGENTS.md instructions for /example'),
      ...prompts.flatMap((text, i) => [
        { type: 'event_msg', payload: { type: 'task_started' } }, say('user', text),
        ...(i === 0 ? [] : [say('assistant', `reply ${i}`)]),
        { type: 'response_completed' },
      ]),
    ].map(encode);
    const parsed = await parser.parseCodexTranscriptFile({ text: lines.join('\n') + '\n' });
    expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(prompts);
    for (const message of parsed.messages) {
      const turn = message.role === 'user' ? prompts.indexOf(message.content) : Number(message.content.slice(-1));
      const deleted = edits.deleteCodexTurnLines(lines, message.id);
      expect(deleted.targetMissed).toBe(false);
      const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
      expect(remaining.messages.filter((item) => item.role === 'user').map((item) => item.content)).toEqual(prompts.filter((_, i) => i !== turn));
      for (const scope of ['prefix', 'single'] as const) {
        const fork = edits.buildCodexForkLines(lines, 'parent', 'child', message.id, scope);
        expect(fork.targetMissed).toBe(false);
        const copied = await parser.parseCodexTranscriptFile({ text: fork.newLines.join('\n') });
        expect(copied.messages.filter((item) => item.role === 'user').map((item) => item.content)).toEqual(scope === 'prefix' ? prompts.slice(0, turn + 1) : [prompts[turn]]);
      }
    }
  });
});
