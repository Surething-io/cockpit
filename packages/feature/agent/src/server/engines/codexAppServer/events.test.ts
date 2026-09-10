import { describe, it, expect } from 'vitest';
import { CodexEventShim } from './events';

const shim = () => new CodexEventShim();

describe('CodexEventShim', () => {
  it('turns assistant deltas into text, not events', () => {
    const s = shim();
    expect(s.handle({ method: 'item/agentMessage/delta', params: { delta: 'Wa' } }))
      .toEqual([{ kind: 'text-delta', text: 'Wa' }]);
    expect(s.handle({ method: 'item/agentMessage/delta', params: { delta: '' } })).toEqual([]);
  });

  /** Real payload captured from codex-cli 0.153.2. */
  it('rewrites a commandExecution item into the exec spelling', () => {
    const out = shim().handle({
      method: 'item/completed',
      params: {
        threadId: 'th-1',
        item: {
          type: 'commandExecution',
          id: 'exec-6979b7d9',
          command: "/bin/zsh -lc 'cat note.txt'",
          aggregatedOutput: 'hello\n',
          exitCode: 0,
          status: 'completed',
          commandActions: [{ type: 'read', path: '/tmp/note.txt' }],
        },
      },
    });
    expect(out).toEqual([
      {
        kind: 'event',
        event: {
          type: 'item.completed',
          thread_id: 'th-1',
          item: {
            type: 'command_execution',
            id: 'exec-6979b7d9',
            command: "/bin/zsh -lc 'cat note.txt'",
            aggregated_output: 'hello\n',
            exit_code: 0,
            status: 'completed',
            command_actions: [{ type: 'read', path: '/tmp/note.txt' }],
          },
        },
      },
    ]);
  });

  it('renames keys inside nested arrays and objects', () => {
    const out = shim().handle({
      method: 'item/started',
      params: {
        item: {
          type: 'fileChange',
          id: 'exec-4cc591fe',
          changes: [{ path: '/tmp/note.txt', kind: { type: 'update', movePath: null }, diff: '@@' }],
        },
      },
    });
    const item = (out[0] as { event: { item: Record<string, unknown> } }).event.item;
    expect(item.type).toBe('file_change');
    // Flattened: exec spells this as a bare string, and the patch bubble and its
    // tool result both interpolate it directly.
    expect(item.changes).toEqual([{ path: '/tmp/note.txt', kind: 'update', diff: '@@' }]);
  });

  it('leaves an already-flat change kind alone', () => {
    const out = shim().handle({
      method: 'item/completed',
      params: { item: { type: 'fileChange', changes: [{ path: '/a', kind: 'add' }] } },
    });
    const item = (out[0] as { event: { item: Record<string, unknown> } }).event.item;
    expect(item.changes).toEqual([{ path: '/a', kind: 'add' }]);
  });

  /**
   * Both of these would otherwise render a second time: the user bubble was
   * already inserted optimistically, and the assistant prose already streamed.
   */
  it('drops the items whose content has another owner', () => {
    const s = shim();
    expect(s.handle({ method: 'item/completed', params: { item: { type: 'userMessage' } } })).toEqual([]);
    expect(s.handle({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'hi' } } })).toEqual([]);
  });

  it('carries the last token usage onto turn.completed', () => {
    const s = shim();
    expect(
      s.handle({
        method: 'thread/tokenUsage/updated',
        params: { tokenUsage: { total: { inputTokens: 19140, outputTokens: 69, cachedInputTokens: 11136, cacheWriteInputTokens: 0 } } },
      }),
    ).toEqual([]);
    expect(s.handle({ method: 'turn/completed', params: {} })).toEqual([
      {
        kind: 'event',
        event: {
          type: 'turn.completed',
          usage: { input_tokens: 19140, output_tokens: 69, cached_input_tokens: 11136, cache_write_input_tokens: 0 },
        },
      },
    ]);
  });

  /**
   * There is no `turn/failed` notification in this protocol. Failure rides on
   * `turn/completed` as `turn.status`, so reading the method name alone reports
   * a failed turn as a clean success.
   */
  describe('turn terminals', () => {
    const completed = (turn: Record<string, unknown>) =>
      shim().handle({ method: 'turn/completed', params: { turn } });

    it('treats a completed turn as success', () => {
      expect(completed({ id: 't1', status: 'completed' })).toEqual([
        { kind: 'event', event: { type: 'turn.completed' } },
      ]);
    });

    it('treats a failed turn as a failure, carrying its reason', () => {
      expect(completed({ id: 't1', status: 'failed', error: { message: 'boom' } })).toEqual([
        { kind: 'event', event: { type: 'turn.failed', error: { message: 'boom' } } },
      ]);
    });

    it('joins the error detail when there is one', () => {
      const out = completed({ id: 't1', status: 'failed', error: { message: 'boom', additionalDetails: 'ctx' } });
      expect(out).toEqual([{ kind: 'event', event: { type: 'turn.failed', error: { message: 'boom — ctx' } } }]);
    });

    /**
     * A stop is not a failure. `interrupted` is the terminal a turn gets when
     * someone asked it to stop, which in this client is always the user.
     */
    it('treats an interrupted turn as an ordinary end, not a failure', () => {
      expect(completed({ id: 't1', status: 'interrupted' })).toEqual([
        { kind: 'event', event: { type: 'turn.completed' } },
      ]);
    });
  });

  describe('error notifications', () => {
    it('reads the NESTED message, not a top-level one', () => {
      expect(shim().handle({
        method: 'error',
        params: { error: { message: 'bad', additionalDetails: 'why' }, willRetry: false },
      })).toEqual([{ kind: 'event', event: { type: 'error', message: 'bad — why' } }]);
    });

    /**
     * The server is about to try again. Surfacing this would both lie and —
     * because the adapter latches `terminated` on an error — go deaf to the
     * retry, hanging the turn until it is aborted by hand.
     */
    it('stays silent when the server says it will retry', () => {
      expect(shim().handle({
        method: 'error',
        params: { error: { message: 'rate limited' }, willRetry: true },
      })).toEqual([]);
    });
  });

  /**
   * Regression: a sub-agent thread finishing used to be read as the parent's
   * terminal, which ended the run and killed the process while the parent was
   * still inside `wait_agent` — taking any sibling sub-agent down with it.
   */
  describe('sub-agent threads share the connection', () => {
    const bound = () => {
      const s = new CodexEventShim();
      s.bindThread('parent-1');
      return s;
    };

    it("ignores a child thread's turn terminal", () => {
      const s = bound();
      expect(s.handle({ method: 'turn/completed', params: { threadId: 'child-9' } })).toEqual([]);
      expect(s.handle({ method: 'turn/failed', params: { threadId: 'child-9', error: { message: 'x' } } })).toEqual([]);
      // The parent's own terminal still lands.
      expect(s.handle({ method: 'turn/completed', params: { threadId: 'parent-1' } })).toEqual([
        { kind: 'event', event: { type: 'turn.completed' } },
      ]);
    });

    it("does not stream a child's prose into the parent bubble", () => {
      const s = bound();
      expect(s.handle({ method: 'item/agentMessage/delta', params: { threadId: 'child-9', delta: 'child talk' } })).toEqual([]);
      expect(s.handle({ method: 'item/agentMessage/delta', params: { threadId: 'parent-1', delta: 'mine' } })).toEqual([
        { kind: 'text-delta', text: 'mine' },
      ]);
    });

    it("does not raise bubbles for a child's items", () => {
      const s = bound();
      expect(s.handle({
        method: 'item/completed',
        params: { threadId: 'child-9', item: { type: 'commandExecution', id: 'exec-1', command: 'ls' } },
      })).toEqual([]);
    });

    it('passes everything through before a thread is bound', () => {
      const s = new CodexEventShim();
      expect(s.handle({ method: 'turn/completed', params: { threadId: 'whatever' } })).toHaveLength(1);
    });

    it('keeps notifications that carry no thread at all', () => {
      const s = bound();
      expect(s.handle({ method: 'error', params: { error: { message: 'bad' }, willRetry: false } })).toEqual([
        { kind: 'event', event: { type: 'error', message: 'bad' } },
      ]);
    });
  });

  /**
   * `collabAgentToolCall` snake-cases to `collab_agent_tool_call`, but the name
   * the adapter switches on is the exec one. Unaliased, every sub-agent bubble's
   * live path is dead code.
   */
  it('aliases the collab item onto the name the adapter knows, tool value included', () => {
    const out = shim().handle({
      method: 'item/completed',
      params: { item: { type: 'collabAgentToolCall', id: 'call_s1', tool: 'spawnAgent', receiverThreadIds: ['a1'] } },
    });
    const item = (out[0] as { event: { item: Record<string, unknown> } }).event.item;
    expect(item.type).toBe('collab_tool_call');
    expect(item.tool).toBe('spawn_agent');
    expect(item.receiver_thread_ids).toEqual(['a1']);
  });

  /** No `todoList` item type exists; the plan arrives as a notification. */
  it('turns a plan update into the todo item the adapter draws', () => {
    const s = shim();
    const out = s.handle({
      method: 'turn/plan/updated',
      params: {
        turnId: 'turn-1',
        plan: [
          { step: 'read the code', status: 'completed' },
          { step: 'write the fix', status: 'inProgress' },
        ],
      },
    });
    const event = (out[0] as { event: { type: string; item: Record<string, unknown> } }).event;
    expect(event.type).toBe('item.completed');
    expect(event.item.type).toBe('todo_list');
    // Three states, not a boolean: an in-progress step must not read as pending.
    expect(event.item.items).toEqual([
      { text: 'read the code', status: 'completed' },
      { text: 'write the fix', status: 'in_progress' },
    ]);
    // A fresh id per revision, so a re-plan draws its own bubble.
    const second = s.handle({ method: 'turn/plan/updated', params: { turnId: 'turn-1', plan: [{ step: 'x', status: 'pending' }] } });
    expect((second[0] as unknown as { event: { item: { id: string } } }).event.item.id)
      .not.toBe((event.item as { id: string }).id);
  });

  it('ignores an empty plan', () => {
    expect(shim().handle({ method: 'turn/plan/updated', params: { turnId: 't', plan: [] } })).toEqual([]);
  });

  /**
   * The rewrite is a spelling change for PROTOCOL fields. Applied to a tool's
   * own arguments it corrupts them: a call made with `{ filePath }` would be
   * shown, and re-sent, as `{ file_path }`.
   */
  it('does not rewrite keys inside somebody else\'s payload', () => {
    const out = shim().handle({
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 'call_m1',
          server: 's',
          tool: 't',
          arguments: { filePath: '/a', maxTokens: 10 },
          structuredContent: { rowCount: 2 },
        },
      },
    });
    const item = (out[0] as { event: { item: Record<string, unknown> } }).event.item;
    // The protocol's own key is respelled…
    expect(item.structured_content).toEqual({ rowCount: 2 });
    // …but never what it wraps.
    expect(item.arguments).toEqual({ filePath: '/a', maxTokens: 10 });
  });

  it('survives an unknown notification rather than throwing', () => {
    expect(shim().handle({ method: 'remoteControl/status/changed', params: { x: 1 } })).toEqual([]);
    expect(shim().handle({ method: 'item/completed', params: {} })).toEqual([]);
  });

  /** An item type this shim has never heard of must still reach the adapter. */
  it('passes through unrecognised item types generically', () => {
    const out = shim().handle({
      method: 'item/completed',
      params: { item: { type: 'mcpToolCall', server: 's', tool: 't', structuredContent: { a: 1 } } },
    });
    const item = (out[0] as { event: { item: Record<string, unknown> } }).event.item;
    expect(item.type).toBe('mcp_tool_call');
    expect(item.structured_content).toEqual({ a: 1 });
  });
});

describe('turns in flight, for stopping a run', () => {
  const shimAt = (threadId: string) => {
    const s = new CodexEventShim();
    s.bindThread(threadId);
    return s;
  };
  const started = (s: CodexEventShim, threadId: string, turnId: string) =>
    s.handle({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });

  it('records a turn even for a thread it filters out', () => {
    const s = shimAt('parent');
    started(s, 'child-1', 'turn-c1');
    // The notification itself is still dropped…
    expect(s.handle({ method: 'item/completed', params: { threadId: 'child-1', item: { type: 'commandExecution', id: 'x' } } })).toEqual([]);
    // …but its turn is known, which is what a stop needs.
    expect(s.activeTurns()).toEqual([{ threadId: 'child-1', turnId: 'turn-c1' }]);
  });

  /**
   * A parent's interrupt does not cascade — measured. Interrupting it first
   * would leave its children running with nobody waiting on them.
   */
  it('puts children before the parent', () => {
    const s = shimAt('parent');
    s.noteOwnTurn('parent', 'turn-p');
    started(s, 'child-1', 'turn-c1');
    started(s, 'child-2', 'turn-c2');
    expect(s.activeTurns().map((t) => t.threadId)).toEqual(['child-1', 'child-2', 'parent']);
  });

  it('forgets a turn once it ends', () => {
    const s = shimAt('parent');
    started(s, 'child-1', 'turn-c1');
    s.handle({ method: 'turn/completed', params: { threadId: 'child-1', turn: { status: 'completed' } } });
    expect(s.activeTurns()).toEqual([]);
  });

  it('knows its own turn before its turn/started arrives', () => {
    const s = shimAt('parent');
    s.noteOwnTurn('parent', 'turn-p');
    expect(s.activeTurns()).toEqual([{ threadId: 'parent', turnId: 'turn-p' }]);
  });
});
