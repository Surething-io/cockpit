import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseCodexTranscriptFile } from './transcriptParsers';

/**
 * Tool bubbles are drawn from `event_msg/item_completed` — one record carrying a
 * call's id, its input and its result — through the same `codexItemBubble` the
 * live engine uses. These pin that, and the one exception: a call that never
 * produces an item.
 */

const line = (o: unknown) => JSON.stringify(o) + '\n';
const meta = line({ type: 'session_meta', payload: { id: 't1', cwd: '/repo', originator: 'cockpit' } });

/** A gpt-5.6 `exec` script body, which is what the freeform tool actually carries. */
const execScript = (cmd: string) => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}});text(r.output)`;
const otherScript = (tool: string) => `const r = await tools.${tool}({session_id:1,chars:""});text(r.output)`;

const call = (callId: string, input: string, name = 'exec') =>
  line({ type: 'response_item', payload: { type: 'custom_tool_call', name, call_id: callId, input } });
const out = (callId: string, output: string) =>
  line({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
const item = (it: Record<string, unknown>) =>
  line({ type: 'event_msg', payload: { type: 'item_completed', item: it } });

const write = (body: string) => {
  const p = join(mkdtempSync(join(tmpdir(), 'codex-toolid-')), 'r.jsonl');
  writeFileSync(p, meta + body);
  return p;
};
const toolsOf = async (p: string) => {
  const { messages } = await parseCodexTranscriptFile(p);
  return messages.flatMap((m) => m.toolCalls ?? []);
};
const partsOf = async (p: string) => {
  const { messages } = await parseCodexTranscriptFile(p);
  return messages.flatMap((m) => (m.parts ?? []).filter((x) => x.type === 'tool').map((x) => x.id));
};

describe('codex tool bubbles come from the completed item', () => {
  it('draws a command from its item alone — id, input and result together', async () => {
    const p = write(
      call('call_1', execScript('cat a.txt')) +
      item({ type: 'command_execution', id: 'exec-aaa', command: 'cat a.txt', aggregated_output: 'one\n', exit_code: 0 }) +
      out('call_1', 'one\n')
    );
    const tools = await toolsOf(p);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: 'exec-aaa', name: 'Bash', input: { command: 'cat a.txt' }, result: 'one\n' });
    // parts carry the bubble's slot; a mismatch renders it in the wrong place.
    expect(await partsOf(p)).toEqual(['exec-aaa']);
  });

  it('substitutes the exit code when a command printed nothing', async () => {
    const p = write(item({ type: 'command_execution', id: 'exec-aaa', command: 'true', aggregated_output: '', exit_code: 0 }));
    expect((await toolsOf(p))[0].result).toBe('(exit code: 0)');
  });

  it('draws a patch from its item, changes included', async () => {
    const p = write(
      item({ type: 'file_change', id: 'exec-bbb', changes: [{ path: '/repo/a.ts', kind: 'update' }], status: 'completed' })
    );
    const tools = await toolsOf(p);
    expect(tools[0]).toMatchObject({
      id: 'exec-bbb',
      name: 'ApplyPatch',
      input: { changes: [{ path: '/repo/a.ts', kind: 'update' }] },
      result: 'update /repo/a.ts',
    });
  });

  /** The call line must NOT draw its own bubble, or the turn shows it twice. */
  it('does not draw a call that will get an item', async () => {
    const p = write(
      call('call_1', execScript('ls')) +
      item({ type: 'command_execution', id: 'exec-aaa', command: 'ls', aggregated_output: 'a\n', exit_code: 0 }) +
      out('call_1', 'a\n')
    );
    expect((await toolsOf(p)).map((t) => t.id)).toEqual(['exec-aaa']);
  });

  describe('the exception: calls that never produce an item', () => {
    it('draws an exec script that runs no command line, and pairs its output', async () => {
      const p = write(call('call_w', otherScript('write_stdin')) + out('call_w', 'still running'));
      const tools = await toolsOf(p);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe('call_w');
      expect(tools[0].result).toBe('still running');
    });

    it('draws a script it cannot read statically', async () => {
      const p = write(call('call_x', 'const n = compute(); await run(n);') + out('call_x', 'done'));
      expect((await toolsOf(p)).map((t) => t.id)).toEqual(['call_x']);
    });

    it('draws a custom tool it has never heard of, under its raw name', async () => {
      const p = write(call('call_y', 'body', 'some_future_tool') + out('call_y', 'ok'));
      const tools = await toolsOf(p);
      expect(tools[0]).toMatchObject({ id: 'call_y', name: 'some_future_tool', result: 'ok' });
    });
  });

  /**
   * A rollout from the old `exec` transport carries no `item_completed` lines at
   * all, so its command bubbles are gone. Deliberate: carrying a second,
   * contradictory path is what this replaced.
   */
  it('draws no command bubble for a rollout with no item lines', async () => {
    const p = write(call('call_1', execScript('ls')) + out('call_1', 'a\n'));
    expect(await toolsOf(p)).toEqual([]);
  });

  it('ignores items that are not tool calls', async () => {
    const p = write(
      item({ type: 'reasoning', id: 'rs_1', text: 'thinking' }) +
      item({ type: 'agent_message', id: 'msg_1', text: 'hi' }) +
      item({ type: 'user_message', id: 'u_1' })
    );
    expect(await toolsOf(p)).toEqual([]);
  });
});
