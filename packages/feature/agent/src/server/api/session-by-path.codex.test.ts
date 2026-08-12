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

// Real shapes, captured from codex 0.147, which rewired every one of these lines:
// spawn arguments (task_name + an encrypted message), spawn output (names no thread),
// the call_id ↔ thread binding (now sub_agent_activity), and the report (now an
// agent_message). See the table in codexTools.ts.
const SPAWN_CIPHERTEXT =
  'gAAAAABqfKIsWwUUPVsP_GowpHVJWqXgTsChVbmfW_oqX090XyS7VjILKODsbTcjP_ZK9SFOHsNlrU7zotH51DsMdYMeZVdVaCuMcKkZ89msK93FgdRBsFPw';
const spawnCallV147 = (callId: string, taskName: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'spawn_agent',
    namespace: 'collaboration',
    arguments: JSON.stringify({ task_name: taskName, fork_turns: 'none', message: SPAWN_CIPHERTEXT }),
    call_id: callId,
  },
});
const spawnOutputV147 = (callId: string, agentPath: string) => ({
  type: 'response_item',
  payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ task_name: agentPath }) },
});
const subAgentStarted = (callId: string, agentThreadId: string, agentPath: string) => ({
  type: 'event_msg',
  payload: {
    type: 'sub_agent_activity',
    // The spawning call_id, under a different key than every other line uses.
    event_id: callId,
    occurred_at_ms: 1786552868549,
    agent_thread_id: agentThreadId,
    agent_path: agentPath,
    kind: 'started',
  },
});
const waitCallV147 = (callId: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call',
    name: 'wait_agent',
    namespace: 'collaboration',
    arguments: JSON.stringify({ timeout_ms: 360000 }),
    call_id: callId,
  },
});
/** No per-agent status any more — the report arrives separately. */
const waitOutputV147 = (callId: string) => ({
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: callId,
    output: JSON.stringify({ message: 'Wait completed.', timed_out: false }),
  },
});
const agentReport = (author: string, report: string) => ({
  type: 'response_item',
  payload: {
    type: 'agent_message',
    author,
    recipient: '/root',
    content: [{
      type: 'input_text',
      text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${author}\nPayload:\n${report}`,
    }],
  },
});

describe('session-by-path codex subagents (0.147 protocol)', () => {
  it('completes each Task bubble from the agent_message its sub-agent sent back', async () => {
    const sessionId = 'codex-v147-spawn-wait';
    writeCodexTranscript(sessionId, [
      userLine('审查 PR 4226'),
      spawnCallV147('call_s1', 'cr_static'),
      spawnOutputV147('call_s1', '/root/cr_static'),
      subAgentStarted('call_s1', 'agent-static', '/root/cr_static'),
      spawnCallV147('call_s2', 'cr_dynamic'),
      spawnOutputV147('call_s2', '/root/cr_dynamic'),
      subAgentStarted('call_s2', 'agent-dynamic', '/root/cr_dynamic'),
      waitCallV147('call_w1'),
      waitOutputV147('call_w1'),
      // Reversed vs. spawn order: reports are matched by author path, not order.
      agentReport('/root/cr_dynamic', '动态：无 findings'),
      agentReport('/root/cr_static', '静态：2 条 findings'),
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      id: 'call_s1',
      name: 'Task',
      // The encrypted spawn message must not become the bubble header; the task name does.
      input: {
        subagent_type: 'cr_static',
        description: 'cr_static',
        // Not an empty `prompt`: the plaintext is unrecoverable, not missing.
        message_encrypted: true,
        agent_id: 'agent-static',
      },
      result: '静态：2 条 findings',
    });
    expect(toolCalls[1]).toMatchObject({ id: 'call_s2', result: '动态：无 findings' });
  });

  it('drills into a sub-agent transcript via sub_agent_activity', async () => {
    const sessionId = 'codex-v147-drill-in';
    writeCodexTranscript(sessionId, [
      userLine('审查'),
      spawnCallV147('call_s1', 'cr_static'),
      // spawn_agent's own output no longer names a thread — this used to 404 the drill-in.
      spawnOutputV147('call_s1', '/root/cr_static'),
      subAgentStarted('call_s1', 'agent-static', '/root/cr_static'),
    ]);
    const childPath = writeCodexTranscript('agent-static', [
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
    // 0.147 publishes a nickname but no role on the child's session_meta.
    sessionEntries.set('agent-static', { path: childPath, agentNickname: 'Dirac' });

    const body = await loadSession(sessionId, { toolUseId: 'call_s1' });

    expect(body.subagent).toEqual({ agentType: 'cr_static', description: 'Dirac' });
    expect(body.messages.at(-1)).toMatchObject({ role: 'assistant', content: '看完了：2 条 findings' });
  });

  it('ignores interim agent chatter so a bubble is only completed by a final answer', async () => {
    const sessionId = 'codex-v147-interim';
    writeCodexTranscript(sessionId, [
      userLine('审查'),
      spawnCallV147('call_s1', 'cr_static'),
      subAgentStarted('call_s1', 'agent-static', '/root/cr_static'),
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root/cr_static',
          recipient: '/root',
          content: [{ type: 'input_text', text: 'Message Type: STATUS\nSender: /root/cr_static\nPayload:\n还在跑' }],
        },
      },
    ]);

    const body = await loadSession(sessionId);
    const toolCall = body.messages[1].toolCalls[0];

    // Marking it done would stop SubagentTranscriptModal polling an agent still working.
    expect(toolCall.result).toBeUndefined();
    expect(toolCall.input).toMatchObject({ agent_id: 'agent-static' });
  });

  it('keeps the parent message stream free of sub-agent reports', async () => {
    const sessionId = 'codex-v147-no-leak';
    writeCodexTranscript(sessionId, [
      userLine('审查'),
      spawnCallV147('call_s1', 'cr_static'),
      subAgentStarted('call_s1', 'agent-static', '/root/cr_static'),
      agentReport('/root/cr_static', '静态：2 条 findings'),
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '审查完成，共 2 个问题。' }],
        },
      },
    ]);

    const body = await loadSession(sessionId);
    const assistant = body.messages[1];

    // The report belongs to the Task bubble; repeating it as assistant text would
    // duplicate the whole review in the transcript.
    expect(assistant.content).toBe('审查完成，共 2 个问题。');
    expect(assistant.toolCalls[0].result).toBe('静态：2 条 findings');
  });
});

describe('session-by-path codex format drift', () => {
  it('renders an unknown tool call under its raw type instead of dropping it', async () => {
    const sessionId = 'codex-tool-search';
    writeCodexTranscript(sessionId, [
      userLine('查一下有什么工具'),
      // Real shape: codex has written these since 0.141 and nothing rendered them.
      // Note `arguments` is an object here, not the JSON string a function_call uses.
      {
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          call_id: 'call_ts1',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'spawn subagent', limit: 5 },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'call_ts1',
          status: 'completed',
          tools: [{ type: 'namespace', name: 'multi_agent_v1' }],
        },
      },
    ]);

    const body = await loadSession(sessionId);
    const toolCalls = body.messages[1].toolCalls;

    // One bubble, not two: the output shares the call's id, so it is its result.
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      id: 'call_ts1',
      name: 'tool_search_call',
      input: { query: 'spawn subagent', limit: 5 },
    });
    expect(toolCalls[0].result).toContain('multi_agent_v1');
  });

  it('renders a custom tool call whose name we do not recognize', async () => {
    const sessionId = 'codex-unknown-custom';
    writeCodexTranscript(sessionId, [
      userLine('跑个新工具'),
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'brand_new_tool', call_id: 'call_c1', input: 'raw body' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_c1', output: 'done' } },
    ]);

    const body = await loadSession(sessionId);
    expect(body.messages[1].toolCalls[0]).toMatchObject({
      id: 'call_c1',
      name: 'brand_new_tool',
      input: { input: 'raw body' },
      result: 'done',
    });
  });

  it('keeps a returned image out of the bubble text', async () => {
    const sessionId = 'codex-view-image';
    const dataUrl = `data:image/png;base64,${'A'.repeat(20000)}`;
    writeCodexTranscript(sessionId, [
      userLine('看图'),
      { type: 'response_item', payload: { type: 'function_call', name: 'view_image', call_id: 'call_v1', arguments: '{"path":"/tmp/a.png"}' } },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_v1',
          output: [{ type: 'input_image', image_url: dataUrl }],
        },
      },
    ]);

    const body = await loadSession(sessionId);
    const toolCall = body.messages[1].toolCalls[0];

    // Inlining the data URL put ~586 KB of base64 through the API, React state and
    // the DOM for a single screenshot.
    expect(toolCall.result).toBe('[Image]');
    expect(JSON.stringify(body).length).toBeLessThan(dataUrl.length);
    // Opening a file is claude's Read: an icon, the path in the header, and
    // READ_ONLY_TOOLS classification instead of "unknown name → assume mutating".
    expect(toolCall).toMatchObject({ name: 'Read', input: { file_path: '/tmp/a.png' } });
  });

  it('reads token usage from token_count, which is the only line that carries it', async () => {
    const sessionId = 'codex-token-count';
    writeCodexTranscript(sessionId, [
      userLine('数一下'),
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 175620, output_tokens: 1910 },
            last_token_usage: {
              input_tokens: 33051,
              cached_input_tokens: 30464,
              cache_write_input_tokens: 128,
              output_tokens: 1269,
            },
          },
        },
      },
    ]);

    const body = await loadSession(sessionId);

    // last_token_usage (this request's context), matching claude's per-message usage.
    expect(body.usage).toEqual({
      input_tokens: 33051,
      output_tokens: 1269,
      cache_read_input_tokens: 30464,
      cache_creation_input_tokens: 128,
    });
  });

  it('counts unknown tool calls the same way the fork walker does', async () => {
    // Drift only shows when an unknown call is a turn's ONLY visible content: if the
    // fork walker skips it, every later message id shifts by one and a fork silently
    // cuts at the wrong turn.
    const lines = [
      { type: 'session_meta', payload: { id: 'codex-walker-sync', cwd: '/tmp' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      userLine('第一轮'),
      { type: 'response_item', payload: { type: 'tool_search_call', call_id: 'call_ts1', arguments: { query: 'x' } } },
      { type: 'response_item', payload: { type: 'tool_search_output', call_id: 'call_ts1', tools: [] } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      userLine('第二轮'),
      {
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二轮回答' }] },
      },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ];
    writeCodexTranscript('codex-walker-sync', lines);

    const body = await loadSession('codex-walker-sync');
    const secondUserId = body.messages[2].id;
    expect(secondUserId).toBe('codex-user-2');

    const { buildCodexForkLines } = await import('./session/codexFork');
    const forked = buildCodexForkLines(
      lines.map((l) => JSON.stringify(l)),
      'codex-walker-sync',
      'forked-id',
      secondUserId,
      'single'
    );

    expect(forked.targetMissed).toBe(false);
    const text = forked.newLines.join('\n');
    expect(text).toContain('第二轮');
    expect(text).not.toContain('第一轮');
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
