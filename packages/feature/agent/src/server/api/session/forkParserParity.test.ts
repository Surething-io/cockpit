import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCodexTranscriptFile } from './transcriptParsers';
import { buildCodexForkLines } from './codexFork';

/**
 * The fork walker and the transcript parser mint the SAME message ids from the
 * same file, each with its own counter. The client asks to fork at an id the
 * parser produced; the walker has to resolve it to the same message. They drift
 * the moment one changes which lines open an assistant bubble — which is
 * exactly what moving tool bubbles onto `item_completed` did.
 *
 * So rather than assert the rules twice, this asserts the property: every id
 * the parser produces is an id the walker can find.
 */

const line = (o: unknown) => JSON.stringify(o) + '\n';
const meta = line({ type: 'session_meta', payload: { id: 't1', cwd: '/repo', originator: 'cockpit' } });
const started = line({ type: 'event_msg', payload: { type: 'task_started' } });
const complete = line({ type: 'event_msg', payload: { type: 'task_complete' } });
const user = (text: string) =>
  line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const say = (text: string) =>
  line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const call = (callId: string, input: string, name = 'exec') =>
  line({ type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, input } });
const out = (callId: string, output: string) =>
  line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
const item = (it: Record<string, unknown>) =>
  line({ type: 'event_msg', payload: { type: 'item_completed', item: it } });
const spawn = (callId: string) =>
  line({ type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: callId, arguments: '{}' } });

const execScript = (cmd: string) => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}});text(r.output)`;
const stdinScript = 'const r = await tools.write_stdin({session_id:1,chars:""});text(r.output)';

/** A turn exercising every branch that opens an assistant bubble. */
const body =
  started +
  user('do it') +
  say('on it') +
  call('call_1', execScript('ls')) +
  item({ type: 'command_execution', id: 'exec-aaa', command: 'ls', aggregated_output: 'a\n', exit_code: 0 }) +
  out('call_1', 'a\n') +
  call('call_2', stdinScript) +            // no item — the exception path
  out('call_2', 'still running') +
  item({ type: 'file_change', id: 'exec-bbb', changes: [{ path: '/repo/a.ts', kind: 'update' }] }) +
  spawn('call_s1') +
  say('done') +
  complete;

describe('fork walker and transcript parser agree on message ids', () => {
  it('resolves every id the parser produced', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'codex-parity-')), 'r.jsonl');
    writeFileSync(p, meta + body);

    const { messages } = await parseCodexTranscriptFile(p);
    expect(messages.length).toBeGreaterThan(1);

    const lines = (meta + body).split('\n').filter(Boolean);
    for (const message of messages) {
      const built = buildCodexForkLines(lines, 't1', 'new-id', message.id, 'prefix');
      expect(built.targetMissed, `walker could not find ${message.id} (${message.role})`).toBe(false);
    }
  });

  it('cuts a prefix at the right turn', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'codex-parity2-')), 'r.jsonl');
    // Two turns; forking at the first user message must keep only turn one.
    writeFileSync(p, meta + body + started + user('second') + say('ok') + complete);
    const { messages } = await parseCodexTranscriptFile(p);
    const firstUser = messages.find((m) => m.role === 'user')!;
    const lines = (meta + body + started + user('second') + say('ok') + complete).split('\n').filter(Boolean);

    const built = buildCodexForkLines(lines, 't1', 'new-id', firstUser.id, 'prefix');
    expect(built.targetMissed).toBe(false);
    expect(built.newLines.join('\n')).not.toContain('second');
  });
});
