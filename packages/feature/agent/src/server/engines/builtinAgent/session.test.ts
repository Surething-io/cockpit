import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendSessionLine, readSessionMessages, type ClaudeTranscriptLine } from './session';

const CWD = '/tmp/project';
const SID = 'sess-1';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-session-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (...lines: ClaudeTranscriptLine[]) => {
  for (const line of lines) appendSessionLine(root, CWD, SID, line);
};

const userText = (text: string): ClaudeTranscriptLine => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistantText = (text: string): ClaudeTranscriptLine => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const assistantToolUse = (id: string, name = 'Bash'): ClaudeTranscriptLine => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }] },
});
const toolResult = (id: string, content = 'ok'): ClaudeTranscriptLine => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

/** An assistant message the OpenAI-compatible wire format accepts: non-empty content,
 *  or tool calls. `content: ''` is what DeepSeek rejects with
 *  "Invalid assistant message: content or tool_calls must be set". */
const isSendableAssistant = (m: { role: string; content: unknown }): boolean => {
  if (m.role !== 'assistant') return true;
  if (typeof m.content === 'string') return m.content.length > 0;
  return Array.isArray(m.content) && m.content.length > 0;
};

describe('readSessionMessages', () => {
  it('replays a plain text turn', () => {
    write(userText('hi'), assistantText('hello'));
    expect(readSessionMessages(root, CWD, SID)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('never emits an empty assistant message for a tool call that got no result', () => {
    // The exact bricked-session shape: a tool call whose tool-error was never written,
    // so the call is dropped on replay and its assistant message has nothing left.
    write(userText('go'), assistantToolUse('call_a'), assistantToolUse('call_b'), toolResult('call_b'));

    const messages = readSessionMessages(root, CWD, SID);
    expect(messages.every(isSendableAssistant)).toBe(true);
    expect(messages).toEqual([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_b', toolName: 'Bash', input: { command: 'ls' } }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call_b', toolName: 'Bash', output: { type: 'text', value: 'ok' } },
        ],
      },
    ]);
  });

  it('drops the trailing empty-content assistant line written to carry usage', () => {
    write(userText('go'), assistantText('done'), {
      type: 'assistant',
      message: { role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 2 } },
    });

    const messages = readSessionMessages(root, CWD, SID);
    expect(messages.every(isSendableAssistant)).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it('keeps parallel tool calls in one assistant message, ahead of their results', () => {
    // The writer appends one line per tool_use, so a parallel step lands as
    // assistant/assistant/tool/tool — an order the wire format rejects.
    write(
      userText('go'),
      assistantText('working'),
      assistantToolUse('call_a'),
      assistantToolUse('call_b'),
      toolResult('call_a'),
      toolResult('call_b'),
    );

    const messages = readSessionMessages(root, CWD, SID);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'working' },
      { type: 'tool-call', toolCallId: 'call_a', toolName: 'Bash', input: { command: 'ls' } },
      { type: 'tool-call', toolCallId: 'call_b', toolName: 'Bash', input: { command: 'ls' } },
    ]);
  });

  it('starts a fresh assistant message after each tool result', () => {
    write(
      userText('go'),
      assistantToolUse('call_a'),
      toolResult('call_a'),
      assistantText('finished'),
    );
    expect(readSessionMessages(root, CWD, SID).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('skips empty text on both sides rather than emitting blank messages', () => {
    write(userText(''), assistantText(''), userText('real'), assistantText('reply'));
    expect(readSessionMessages(root, CWD, SID)).toEqual([
      { role: 'user', content: 'real' },
      { role: 'assistant', content: 'reply' },
    ]);
  });

  it('returns no messages for a session with no transcript', () => {
    expect(readSessionMessages(root, CWD, 'missing')).toEqual([]);
  });
});
