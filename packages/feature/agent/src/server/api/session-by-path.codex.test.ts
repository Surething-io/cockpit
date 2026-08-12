import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

const sessionPaths = new Map<string, string>();
const sessionEntries = new Map<string, { path: string; agentRole?: string; agentNickname?: string }>();

vi.mock('@cockpit/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cockpit/shared-utils')>();
  return {
    ...actual,
    findCodexSessionPath: (sessionId: string) => sessionPaths.get(sessionId) || null,
    findCodexSessionEntry: (id: string) => sessionEntries.get(id) || null,
  };
});

function writeCodexTranscript(sessionId: string, lines: unknown[]): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'codex-session-by-path-'));
  const filePath = join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  sessionPaths.set(sessionId, filePath);
  return filePath;
}

describe('session-by-path codex history', () => {
  it('loads exec_command calls as Bash tool calls', async () => {
    const sessionId = 'codex-exec-command';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'run tests' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"npm test"}',
          call_id: 'call_1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.messages[1].toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'Bash',
      input: { command: 'npm test' },
      result: 'ok',
      isLoading: false,
    });
  });

  // gpt-5.6 dropped the per-tool function_calls for one freeform `exec` script tool
  // whose output is a content-block array — a session recorded this way used to
  // render with no tool calls at all.
  it('loads 5.6 exec scripts as Bash and ApplyPatch tool calls', async () => {
    const sessionId = 'codex-exec-script';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'swap the icon' }] },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_1',
          input: 'const r = await tools.exec_command({"cmd":"npm test","workdir":"/repo"}); text(r.output);\n',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: 'ok' },
          ],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_2',
          input: 'const patch = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n@@\\n-a\\n+b\\n*** End Patch";\ntext(await tools.apply_patch(patch));',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_2',
          output: [{ type: 'input_text', text: '{}' }],
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.messages[1].toolCalls).toMatchObject([
      {
        id: 'call_1',
        name: 'Bash',
        input: { command: 'npm test', workdir: '/repo' },
        result: 'Script completed\nok',
        isLoading: false,
      },
      {
        id: 'call_2',
        name: 'ApplyPatch',
        input: { changes: [{ path: '/repo/a.ts', kind: 'update' }] },
        result: '{}',
        isLoading: false,
      },
    ]);
  });

  it('loads Codex user images from input_image blocks', async () => {
    const sessionId = 'codex-input-image';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        timestamp: '2026-08-06T08:40:49.243Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
            { type: 'input_text', text: 'explain this screenshot' },
          ],
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.title).toBe('explain this screenshot');
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: 'explain this screenshot',
      images: [{ type: 'base64', media_type: 'image/png', data: 'AAA' }],
      timestamp: '2026-08-06T08:40:49.243Z',
    });
  });

  it('keeps image-only Codex user turns', async () => {
    const sessionId = 'codex-image-only';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
          ],
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.title).toBe('[Image]');
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: '',
      images: [{ type: 'base64', media_type: 'image/jpeg', data: 'BBB' }],
    });
  });
});

// Real shapes, captured from codex 0.141 (`codex exec --json` + its rollout).
const userLine = (text: string) => ({
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const spawnCall = (callId: string, agentType: string, message: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'spawn_agent',
    namespace: 'multi_agent_v1',
    arguments: JSON.stringify({ agent_type: agentType, message }),
    call_id: callId,
  },
});
const spawnOutput = (callId: string, agentId: string, nickname: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({ agent_id: agentId, nickname }),
  },
});
const waitCall = (callId: string, targets: string[]) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'wait_agent',
    namespace: 'multi_agent_v1',
    arguments: JSON.stringify({ targets, timeout_ms: 600000 }),
    call_id: callId,
  },
});
// Externally tagged, unlike the live stream's agents_states.
const waitOutput = (callId: string, status: Record<string, Record<string, string>>) => ({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({ status, timed_out: false }),
  },
});

const loadSession = async (sessionId: string, extra: Record<string, unknown> = {}) => {
  const { POST } = await import('./session-by-path');
  const response = await POST(
    new Request('http://test.local/api/session-by-path', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/tmp', sessionId, ...extra }),
    })
  );
  return response.json();
};

describe('session-by-path codex subagents', () => {
  it('renders one Task bubble per sub-agent, completed by its wait_agent report', async () => {
    const sessionId = 'codex-spawn-wait';
    writeCodexTranscript(sessionId, [
      userLine('审查 PR 4155'),
      spawnCall('call_s1', 'explorer', '你是代码审查 subagent。\n请执行 Part A。'),
      spawnOutput('call_s1', 'agent-1', 'Turing'),
      waitCall('call_w1', ['agent-1']),
      waitOutput('call_w1', { 'agent-1': { completed: '2 条 findings' } }),
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    // wait_agent must NOT get a bubble of its own — it only completes the spawn's.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: 'call_s1',
      name: 'Task',
      input: {
        subagent_type: 'explorer',
        description: 'Turing (explorer)',
        prompt: '你是代码审查 subagent。\n请执行 Part A。',
        agent_id: 'agent-1',
      },
      result: '2 条 findings',
      isLoading: false,
    });
  });

  it('routes each report to the right bubble when several agents run at once', async () => {
    const sessionId = 'codex-spawn-two';
    writeCodexTranscript(sessionId, [
      userLine('并行审查'),
      spawnCall('call_s1', 'explorer', 'Part A'),
      spawnOutput('call_s1', 'agent-1', 'Turing'),
      spawnCall('call_s2', 'explorer', 'Part B'),
      spawnOutput('call_s2', 'agent-2', 'Franklin'),
      waitCall('call_w1', ['agent-1', 'agent-2']),
      waitOutput('call_w1', {
        // Deliberately reversed vs. spawn order: results are matched by agent id, not order.
        'agent-2': { completed: '动态：无 findings' },
        'agent-1': { errored: 'Selected model is at capacity.' },
      }),
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: 'call_s1', result: 'Selected model is at capacity.' });
    expect(toolCalls[1]).toMatchObject({ id: 'call_s2', result: '动态：无 findings' });
  });

  it('leaves an unwaited sub-agent without a result so the drill-in keeps polling', async () => {
    const sessionId = 'codex-spawn-no-wait';
    writeCodexTranscript(sessionId, [
      userLine('起一个 agent'),
      spawnCall('call_s1', 'explorer', 'go'),
      spawnOutput('call_s1', 'agent-1', 'Turing'),
    ]);

    const body = await loadSession(sessionId);
    const toolCall = body.messages[1].toolCalls[0];

    // spawn_agent's own output is bookkeeping; surfacing it as the result would mark the
    // bubble finished and stop SubagentTranscriptModal from polling the running agent.
    expect(toolCall.result).toBeUndefined();
    expect(toolCall.input).not.toHaveProperty('nickname');
  });

  it('drops close_agent instead of rendering it as a tool call', async () => {
    const sessionId = 'codex-close-agent';
    writeCodexTranscript(sessionId, [
      userLine('收尾'),
      spawnCall('call_s1', 'explorer', 'go'),
      spawnOutput('call_s1', 'agent-1', 'Turing'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'close_agent',
          namespace: 'multi_agent_v1',
          arguments: JSON.stringify({ target: 'agent-1' }),
          call_id: 'call_c1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_c1',
          output: 'agent with id agent-1 not found',
        },
      },
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe('call_s1');
    // The stale-agent error must not leak in as the sub-agent's report.
    expect(toolCalls[0].result).toBeUndefined();
  });

  it('drills into a sub-agent transcript by the spawning call_id', async () => {
    const sessionId = 'codex-drill-in';
    writeCodexTranscript(sessionId, [
      userLine('审查'),
      spawnCall('call_s1', 'explorer', 'go'),
      spawnOutput('call_s1', 'agent-77', 'Turing'),
    ]);
    // The sub-agent's transcript is a rollout of its own, not a sidecar of the parent.
    const childPath = writeCodexTranscript('agent-77', [
      userLine('go'),
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '看完了：2 条 findings' }],
        },
      },
    ]);
    sessionEntries.set('agent-77', {
      path: childPath,
      agentRole: 'explorer',
      agentNickname: 'Turing',
    });

    const body = await loadSession(sessionId, { toolUseId: 'call_s1' });

    expect(body.subagent).toEqual({ agentType: 'explorer', description: 'Turing' });
    expect(body.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '看完了：2 条 findings',
    });
    expect(body.fingerprint).toBeTruthy();
  });

  it('404s a drill-in whose spawn call never reported an agent id', async () => {
    const sessionId = 'codex-drill-in-missing';
    writeCodexTranscript(sessionId, [
      userLine('审查'),
      spawnCall('call_s1', 'explorer', 'go'),
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId, toolUseId: 'call_s1' }),
      })
    );

    expect(response.status).toBe(404);
  });
});

describe('session-by-path codex tool types', () => {
  it('maps update_plan onto TodoWrite so the checklist renders', async () => {
    const sessionId = 'codex-update-plan';
    writeCodexTranscript(sessionId, [
      userLine('做个计划'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'update_plan',
          arguments: JSON.stringify({ plan: [{ step: '读文件', status: 'completed' }, { step: '分析', status: 'in_progress' }] }),
          call_id: 'call_p1',
        },
      },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_p1', output: 'Plan updated' } },
    ]);

    const body = await loadSession(sessionId);
    expect(body.messages[1].toolCalls[0]).toMatchObject({
      id: 'call_p1',
      name: 'TodoWrite',
      // MessageBubble's checklist counts status === 'completed'.
      input: { todos: [{ content: '读文件', status: 'completed' }, { content: '分析', status: 'in_progress' }] },
      result: 'Plan updated',
    });
  });

  it('qualifies an MCP call with its server, matching claude mcp__server__tool', async () => {
    const sessionId = 'codex-mcp';
    writeCodexTranscript(sessionId, [
      userLine('算 2+2'),
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'js',
          namespace: 'mcp__node_repl',
          arguments: JSON.stringify({ code: '2 + 2' }),
          call_id: 'call_m1',
        },
      },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_m1', output: '4' } },
    ]);

    const body = await loadSession(sessionId);
    // `js` alone is meaningless, and the qualified name also keeps the call classified
    // as possibly-mutating by READ_ONLY_TOOLS (a deny-list).
    expect(body.messages[1].toolCalls[0]).toMatchObject({
      id: 'call_m1',
      name: 'mcp__node_repl__js',
      input: { code: '2 + 2' },
      result: '4',
    });
  });

  it('rebuilds web searches from the web_search_end event_msg', async () => {
    const sessionId = 'codex-web-search';
    writeCodexTranscript(sessionId, [
      userLine('搜一下'),
      // The response_item/web_search_call twin carries no id at all, so this event_msg
      // is the only line a bubble can be rebuilt from.
      {
        type: 'event_msg',
        payload: {
          type: 'web_search_end',
          call_id: 'ws_abc',
          query: 'codex cli version',
          action: { type: 'search', query: 'codex cli version', queries: ['codex cli version', 'openai codex npm'] },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'web_search_end',
          call_id: 'ws_def',
          query: 'https://npmjs.com/package/@openai/codex',
          action: { type: 'open_page', url: 'https://npmjs.com/package/@openai/codex' },
        },
      },
      { type: 'response_item', payload: { type: 'web_search_call', status: 'completed', action: { type: 'search' } } },
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      id: 'ws_abc',
      name: 'WebSearch',
      input: { query: 'codex cli version' },
      result: 'codex cli version\nopenai codex npm',
    });
    // An opened page is a fetch, not a search.
    expect(toolCalls[1]).toMatchObject({
      id: 'ws_def',
      name: 'WebFetch',
      input: { url: 'https://npmjs.com/package/@openai/codex' },
    });
  });
});
