import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [scenario, trace] = process.argv.slice(2);
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const reply = (id, result) => send({ id, result });
let authenticated = false;
let activePromptId;
let sessionId = 'grok-test-session';
let sessionDir;
const update = (value) => send({ method: 'session/update', params: { sessionId, update: value } });
const extension = (value) => send({ method: '_x.ai/session_notification', params: { sessionId, update: value } });

for await (const line of createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  appendFileSync(trace, `${JSON.stringify({ ...frame, pid: process.pid, apiKeyPresent: !!process.env.XAI_API_KEY })}\n`);
  const { id, method, params = {} } = frame;
  if (!method && id === 'reverse-unknown') {
    send({ id: 'reverse-permission', method: 'session/request_permission', params: { sessionId, options: [{ optionId: 'allow-project', kind: 'allow_always' }] } });
    continue;
  }
  if (!method && id === 'reverse-permission') {
    send({ id: 'reverse-question', method: '_x.ai/ask_user_question', params: { sessionId, questions: [{ question: 'Which file should I edit?' }] } });
    continue;
  }
  if (!method && id === 'reverse-question') {
    extension({ sessionUpdate: 'turn_completed', prompt_id: activePromptId, stop_reason: 'end_turn' });
    continue;
  }
  if (method === 'initialize') {
    if (scenario === 'startup-hang') continue;
    reply(id, scenario === 'v2'
      ? { protocolVersion: 2, info: { name: 'mock-grok' }, capabilities: { session: { resume: {} } } }
      : { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } });
  } else if (method === 'authenticate' || method === 'auth/login') {
    authenticated = true;
    reply(id, {});
  } else if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
    if (scenario === 'native-context') {
      sessionId = params.sessionId;
      sessionDir = join(process.env.GROK_HOME, 'sessions', encodeURIComponent(params.cwd), sessionId);
      const history = readFileSync(join(sessionDir, 'chat_history.jsonl'), 'utf8');
      appendFileSync(trace, JSON.stringify({ loadedContext: history }) + '\n');
    }
    if (!authenticated && scenario === 'auth') { send({ id, error: { code: -32000, message: 'Authentication required' } }); continue; }
    if (method !== 'session/new') update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay must be ignored' } });
    reply(id, { sessionId, models: { currentModelId: 'grok-native', availableModels: [] }, configOptions: [{ id: 'effort', category: 'thought_level', currentValue: 'high', options: [] }] });
  } else if (method === 'session/set_model' || method === 'session/set_config_option') {
    reply(id, {});
  } else if (method === 'session/prompt') {
    activePromptId = params._meta.promptId;
    if (scenario === 'native-context') {
      appendFileSync(join(sessionDir, 'chat_history.jsonl'), [
        { type: 'user', prompt_index: 0, content: [{ type: 'text', text: params.prompt[0].text }] },
        { type: 'assistant', content: 'Independent response' },
      ].map((item) => JSON.stringify(item)).join('\n') + '\n');
      writeFileSync(join(sessionDir, 'updates.jsonl'), JSON.stringify({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'user_message_chunk', _meta: { promptIndex: 0 } } } }) + '\n');
    }
    if (scenario === 'reverse') {
      send({ id: 'reverse-unknown', method: 'fs/write_text_file', params: { path: '/must-not-write', content: 'no' } });
      continue;
    }
    if (scenario === 'disconnect') process.exit(7);
    if (scenario === 'hang') { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } }); continue; }
    if (scenario === 'error') {
      extension({ sessionUpdate: 'turn_completed', prompt_id: params._meta.promptId, stop_reason: 'error', agent_result: 'Subscription quota exhausted' });
      continue;
    }
    if (scenario === 'v2') reply(id, {});
    send({ method: 'session/update', params: { sessionId: 'foreign-child', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'foreign text' } } } });
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello 世界' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', kind: 'read', title: 'Read file', rawInput: { path: 'hello.ts' }, status: 'pending' });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file contents' } }] });
    extension({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-unrelated', stop_reason: 'end_turn' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' done' } });
    if (scenario === 'background') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'bg-tool', title: 'spawn_subagent', rawInput: { background: true }, _meta: { 'x.ai/tool': { name: 'spawn_subagent' } } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'bg-tool', status: 'completed', rawOutput: { type: 'Text', text: 'Subagent started in background.\nsubagent_id: background-child' } });
      extension({ sessionUpdate: 'turn_completed', prompt_id: activePromptId, stop_reason: 'end_turn' });
      extension({ sessionUpdate: 'subagent_finished', child_session_id: 'background-child', status: 'completed', output: 'Child report', will_wake: true });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Wake continuation' } });
      extension({ sessionUpdate: 'turn_completed', prompt_id: 'task-completed-background-child', stop_reason: 'end_turn' });
      continue;
    }
    if (scenario === 'v2') update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    else if (scenario === 'rpc-complete') reply(id, { stopReason: 'end_turn' });
    else extension({ sessionUpdate: 'turn_completed', prompt_id: params._meta.promptId, stop_reason: 'end_turn' });
  } else if (method === 'session/cancel') {
    process.exit(0);
  }
}
