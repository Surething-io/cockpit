// Regression net for the engine-agnostic stream reducer (#10). Run with `npm test`
// (vitest) or `npx vitest run <this file>`.
import { describe, it, expect } from 'vitest';
import { applyStreamEvent, isSubagentFrame, settleRunningTasks, type StreamEvent } from './applyStreamEvent';
import { deriveContent } from '../shared/assistantText';
import type { ChatMessage } from './types';

const ID = 'asst-1';
const seed = (): ChatMessage[] => [{ id: ID, role: 'assistant', content: '', isStreaming: true }];
const reduce = (msgs: ChatMessage[], evs: StreamEvent[], engine?: string) =>
  evs.reduce((acc, ev) => applyStreamEvent(acc, ev, { engine, assistantId: ID }), msgs);

const delta = (text: string): StreamEvent => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
});

describe('applyStreamEvent (#10 engine-agnostic reducer)', () => {
  it('claude deltas accumulate into the assistant bubble', () => {
    const out = reduce(seed(), [delta('Hel'), delta('lo'), delta(' world')]);
    expect(out[0].content).toBe('Hello world');
  });

  it('claude complete-text assistant is skipped (deltas own text; no dup)', () => {
    const out = reduce(seed(), [
      delta('Hi'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } },
    ]);
    expect(out[0].content).toBe('Hi');
  });

  it('codex/kimi/ollama complete-text assistant is rendered (no deltas for them)', () => {
    const out = reduce(seed(), [{ type: 'assistant', message: { content: [{ type: 'text', text: 'from codex' }] } }], 'codex');
    expect(out[0].content).toBe('from codex');
  });

  it('synthetic message text is read regardless of engine', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: '/x unavailable' }] } },
    ]);
    expect(out[0].content).toBe('/x unavailable');
  });

  it('tool_use deduped by id + tool_result merged', () => {
    const out = reduce(seed(), [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { p: 'x' } }] } }, // dup
      { type: 'user', message: { content: [{ tool_use_id: 't1', content: 'data' }] } },
    ]);
    expect(out[0].toolCalls?.length).toBe(1);
    expect(out[0].toolCalls?.[0].name).toBe('Read');
    expect(out[0].toolCalls?.[0].result).toBe('data');
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result finalize: clears isStreaming + toolCall isLoading', () => {
    const out = reduce(seed(), [
      delta('done'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read' }] } },
      { type: 'result' },
    ]);
    expect(out[0].isStreaming).toBe(false);
    expect(out[0].toolCalls?.[0].isLoading).toBe(false);
  });

  it('result.result fills an empty bubble (trimmed)', () => {
    const out = reduce(seed(), [{ type: 'result', result: '  error text  ' }]);
    expect(out[0].content).toBe('error text');
  });

  it('result does NOT overwrite existing content', () => {
    const out = reduce(seed(), [delta('real'), { type: 'result', result: 'fallback' }]);
    expect(out[0].content).toBe('real');
  });

  it('events are scoped to assistantId — other messages untouched', () => {
    const msgs: ChatMessage[] = [{ id: 'user-1', role: 'user', content: 'q' }, ...seed()];
    const out = reduce(msgs, [delta('x')]);
    expect(out[0].content).toBe('q');
    expect(out[1].content).toBe('x');
  });

  // #paragraph-break: two narration segments separated by a tool_use must render
  // as separate paragraphs (blank line), not glue into `**a****b**`. Must match
  // the history parsers byte-for-byte so a page refresh does not reflow the turn.
  const toolUse = (id: string): StreamEvent => ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Read', input: {} }] },
  });

  it('text segments separated by a tool_use break into paragraphs', () => {
    const out = reduce(seed(), [delta('**1/5**'), toolUse('t1'), delta('**2/5**'), toolUse('t2'), delta('**3/5**')]);
    expect(out[0].content).toBe('**1/5**\n\n**2/5**\n\n**3/5**');
  });

  it('consecutive deltas within one segment glue (no spurious break)', () => {
    const out = reduce(seed(), [toolUse('t1'), delta('Now '), delta('insert '), delta('the fn')]);
    // first delta after the tool breaks off the (empty) prior content → no leading blank line;
    // the rest of the same block glue verbatim.
    expect(out[0].content).toBe('Now insert the fn');
  });

  it('adjacent text with NO tool between stays glued (matches live streaming)', () => {
    const out = reduce(seed(), [delta('a'), delta('b')]);
    expect(out[0].content).toBe('ab');
  });

  it('codex complete-text segments separated by a tool_use also break', () => {
    const out = reduce(
      seed(),
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step one' }] } },
        toolUse('t1'),
        { type: 'assistant', message: { content: [{ type: 'text', text: 'step two' }] } },
      ],
      'codex'
    );
    expect(out[0].content).toBe('step one\n\nstep two');
  });

  // Frames the SDK forwards from a NESTED run (`parent_tool_use_id` = the spawning
  // Agent/Task tool_use). They are absent from the parent transcript on disk, so counting
  // them live breaks live/reload parity — and, because every tool_use flips
  // pendingTextBreak, a background subagent ticking while the parent narrates used to chop
  // that narration into a new part per tick (arbitrary mid-word line breaks + markdown
  // parsed per fragment).
  describe('subagent frames are not this turn', () => {
    const subToolUse = (id: string): StreamEvent => ({
      ...toolUse(id),
      parent_tool_use_id: 'parent-agent-1',
    });

    it('a subagent tool_use adds no tool call to the parent bubble', () => {
      const out = reduce(seed(), [toolUse('t1'), subToolUse('sub-1'), subToolUse('sub-2')]);
      expect(out[0].toolCalls?.map((tc) => tc.id)).toEqual(['t1']);
    });

    it('a subagent tick mid-narration does NOT split the parent text (the reported bug)', () => {
      const out = reduce(seed(), [
        delta('四路已经在'),
        subToolUse('sub-1'),
        delta('跑: **一手**'),
        subToolUse('sub-2'),
        delta('还是二手'),
      ]);
      expect(out[0].content).toBe('四路已经在跑: **一手**还是二手');
      expect(out[0].parts).toEqual([{ type: 'text', text: '四路已经在跑: **一手**还是二手' }]);
    });

    it('subagent text (forwardSubagentText) never lands in the parent bubble', () => {
      const out = reduce(
        seed(),
        [
          { type: 'assistant', message: { content: [{ type: 'text', text: 'mine' }] } },
          { type: 'assistant', parent_tool_use_id: 'parent-agent-1', message: { content: [{ type: 'text', text: 'theirs' }] } },
        ],
        'codex'
      );
      expect(out[0].content).toBe('mine');
    });

    it('a subagent tool_result does not resolve the parent spawning call', () => {
      const out = reduce(seed(), [
        toolUse('t1'),
        { type: 'user', parent_tool_use_id: 'parent-agent-1', message: { content: [{ tool_use_id: 't1', content: 'leaked' }] } },
      ]);
      expect(out[0].toolCalls?.[0].result).toBeUndefined();
      expect(out[0].toolCalls?.[0].isLoading).toBe(true);
    });

    it('parent frames (null / absent parent_tool_use_id) are unaffected', () => {
      expect(isSubagentFrame({})).toBe(false);
      expect(isSubagentFrame({ parent_tool_use_id: null })).toBe(false);
      expect(isSubagentFrame({ parent_tool_use_id: 'toolu_1' })).toBe(true);
    });
  });

  // system/task_* — the spawned work's OWN lifecycle, joined to the launching call by
  // `tool_use_id`. Separate from `isLoading` because a backgrounded launch resolves its tool
  // call in ~30ms and then runs for minutes (shared/subagentTask.ts).
  describe('spawned background tasks', () => {
    const agentCall = (id: string): StreamEvent => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: 'Agent', input: {} }] },
    });
    const taskEv = (subtype: string, extra: Partial<StreamEvent>): StreamEvent => ({
      type: 'system',
      subtype,
      task_id: 'a1',
      tool_use_id: 't1',
      ...extra,
    });
    const task = (m: ChatMessage) => m.toolCalls?.[0].task;

    it('task_started marks the launching call running WITHOUT touching isLoading', () => {
      const out = reduce(seed(), [
        agentCall('t1'),
        { type: 'user', message: { content: [{ tool_use_id: 't1', content: 'Async agent launched' }] } },
        taskEv('task_started', {}),
      ]);
      // The tool call itself is settled — the launch receipt came back — but the task is not.
      expect(out[0].toolCalls?.[0].isLoading).toBe(false);
      expect(out[0].toolCalls?.[0].result).toBe('Async agent launched');
      expect(task(out[0])).toEqual({ status: 'running', id: 'a1' });
    });

    it('task_progress carries what the agent is doing right now', () => {
      const out = reduce(seed(), [
        agentCall('t1'),
        taskEv('task_started', {}),
        taskEv('task_progress', { last_tool_name: 'WebFetch', usage: { tool_uses: 37, duration_ms: 9000 } }),
      ]);
      expect(task(out[0])).toMatchObject({ status: 'running', lastToolName: 'WebFetch', toolUses: 37, durationMs: 9000 });
    });

    it('task_notification settles it, and a failure is not laundered into completed', () => {
      const done = reduce(seed(), [agentCall('t1'), taskEv('task_started', {}), taskEv('task_notification', { status: 'completed' })]);
      expect(task(done[0])?.status).toBe('completed');
      const failed = reduce(seed(), [agentCall('t1'), taskEv('task_started', {}), taskEv('task_notification', { status: 'failed' })]);
      expect(task(failed[0])?.status).toBe('failed');
    });

    it('lands on the launching bubble even after the turn moved on', () => {
      // The real background case: the agent reports back long after its launch turn ended, by
      // which point live events are filling a DIFFERENT bubble. Keying on tool_use_id is what
      // makes that work — scoping to `assistantId` would drop it on the floor.
      const msgs: ChatMessage[] = [
        { id: ID, role: 'assistant', content: 'launched', toolCalls: [{ id: 't1', name: 'Agent', input: {}, isLoading: false }] },
        { id: 'asst-2', role: 'assistant', content: '', isStreaming: true },
      ];
      const out = applyStreamEvent(msgs, taskEv('task_notification', { status: 'completed' }), { assistantId: 'asst-2' });
      expect(out[0].toolCalls?.[0].task?.status).toBe('completed');
      expect(out[1].toolCalls).toBeUndefined();
    });

    it('a task with no matching call (nested subagent work) changes nothing, by identity', () => {
      const msgs = reduce(seed(), [agentCall('t1')]);
      const out = applyStreamEvent(msgs, taskEv('task_progress', { tool_use_id: 'nested-9' }), { assistantId: ID });
      expect(out).toBe(msgs);
    });

    it('ambient housekeeping tasks are ignored', () => {
      const out = reduce(seed(), [agentCall('t1'), taskEv('task_started', { ambient: true })]);
      expect(task(out[0])).toBeUndefined();
    });

    // A stale `running` is how a dead task comes back to life. sdkLoop keeps the CLI process
    // resident until every task reports, so a run that ENDS with one still running was stopped
    // or crashed — the task died with it. Cleared here rather than qualified at render time
    // with "is any run active", which is true again on the user's next unrelated message.
    it('a run that ends with a task still running settles it to unknown', () => {
      const live = reduce(seed(), [agentCall('t1'), taskEv('task_started', {})]);
      expect(task(live[0])?.status).toBe('running');
      const settled = settleRunningTasks(live);
      expect(task(settled[0])).toEqual({ status: 'unknown', id: 'a1' });
    });

    it('settling preserves terminal outcomes and array identity when there is nothing to settle', () => {
      const done = reduce(seed(), [agentCall('t1'), taskEv('task_started', {}), taskEv('task_notification', { status: 'failed' })]);
      const settled = settleRunningTasks(done);
      expect(settled).toBe(done); // no running task ⇒ same reference, no re-render
      expect(task(settled[0])?.status).toBe('failed');
    });

    it('a later unrelated run cannot revive a settled task', () => {
      // The adversarial cross-run timeline: run A leaves a stale task, run B starts. Nothing
      // run B emits mentions t1, so t1 must stay settled — no session-wide flag can flip it.
      const stale = settleRunningTasks(reduce(seed(), [agentCall('t1'), taskEv('task_started', {})]));
      const afterRunB = reduce(stale, [
        { type: 'system', subtype: 'init' },
        agentCall('t2'),
        { type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 't2' },
        { type: 'result' },
      ]);
      expect(task(afterRunB[0])?.status).toBe('unknown');
      expect(afterRunB[0].toolCalls?.find((tc) => tc.id === 't2')?.task?.status).toBe('running');
    });
  });


  // #parts: the ordered text/tool skeleton the renderer needs to tell a mid-turn
  // narration segment from the turn's answer. It is built alongside `content`;
  // these tests pin BOTH the ordering and the fact that it stays a lossless
  // re-description of the same string (deriveContent === content).
  describe('#parts ordered skeleton', () => {
    const kinds = (m: ChatMessage) => (m.parts || []).map((p) => (p.type === 'text' ? `t:${p.text}` : `x:${p.id}`));

    it('interleaves text and tool parts in emission order', () => {
      const out = reduce(seed(), [delta('one'), toolUse('t1'), delta('two'), toolUse('t2'), delta('three')]);
      expect(kinds(out[0])).toEqual(['t:one', 'x:t1', 't:two', 'x:t2', 't:three']);
    });

    it('adjacent deltas with no tool between them stay ONE part', () => {
      const out = reduce(seed(), [delta('a'), delta('b'), delta('c')]);
      expect(kinds(out[0])).toEqual(['t:abc']);
    });

    it('a re-delivered tool_use adds no part (would forge a segment boundary)', () => {
      const out = reduce(seed(), [delta('a'), toolUse('t1'), toolUse('t1'), delta('b')]);
      expect(kinds(out[0])).toEqual(['t:a', 'x:t1', 't:b']);
    });

    it('the error banner is its own part, never folded into the narration', () => {
      const out = reduce(seed(), [delta('working'), { type: 'error', error: 'boom' }]);
      expect(kinds(out[0])).toEqual(['t:working', 't:⚠️ boom']);
    });

    it('result-filled fallback content produces a part too', () => {
      const out = reduce(seed(), [{ type: 'result', result: ' fallback ' }]);
      expect(kinds(out[0])).toEqual(['t:fallback']);
    });

    // The contract that lets step 2 drop `content` from the render path without
    // changing a pixel: parts carry everything the joined string carried.
    it('deriveContent(parts) reproduces content byte for byte', () => {
      const cases: StreamEvent[][] = [
        [delta('**1/5**'), toolUse('t1'), delta('**2/5**'), toolUse('t2'), delta('**3/5**')],
        [toolUse('t1'), delta('Now '), delta('insert '), delta('the fn')],
        [delta('a'), delta('b')],
        [delta('trailing\n\n'), toolUse('t1'), delta('after')],
        [delta('text'), toolUse('t1'), { type: 'error', error: 'boom' }],
        [delta('x'), toolUse('t1'), { type: 'result', result: 'ignored' }],
      ];
      for (const evs of cases) {
        const out = reduce(seed(), evs);
        expect(deriveContent(out[0].parts)).toBe(out[0].content);
      }
    });

    // Guards the repo's memo convention: MessageBubble hangs ~40 useMemo/useCallback
    // on [message.toolCalls]. If a text delta ever re-created that array, every tool
    // card would re-render on every token.
    it('a text delta leaves the toolCalls array identity untouched', () => {
      const withTool = reduce(seed(), [toolUse('t1')]);
      const before = withTool[0].toolCalls;
      const after = reduce(withTool, [delta('a'), delta('b')]);
      expect(after[0].toolCalls).toBe(before);
    });
  });
});
