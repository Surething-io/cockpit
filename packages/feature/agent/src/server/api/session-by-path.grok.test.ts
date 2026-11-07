import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let home: string;
let POST: typeof import('./session-by-path').POST;
let nativePath: typeof import('../../effect/grokNativeSessionLive').grokNativeSessionPath;
const cwd = '/project with spaces/用户';
const sessionId = 'grok-root';
const childId = 'grok-child';
const toolUseId = 'call-spawn-8';
const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';
const frame = (id: string, update: Record<string, unknown>) => ({
  timestamp: 1794019495, method: 'session/update', params: { sessionId: id, update },
});
const receipt = (parent: string, call: string, child: string) => frame(parent, {
  sessionUpdate: 'tool_call_update', toolCallId: call, status: 'completed',
  rawOutput: { type: 'Text', text: `Subagent started in background.\nsubagent_id: ${child}\ndescription: Review` },
});
const childReplay = () => [
  frame(childId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Review the history lifecycle' } }),
  frame(childId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect the code' } }),
  frame(childId, { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'Reading code.' } }),
  frame(childId, { sessionUpdate: 'agent_message', messageId: 'message-1', content: { type: 'text', text: 'Reading code.' } }),
  frame(childId, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'read_file',
    rawInput: { path: '/project/file.ts' }, _meta: { 'x.ai/tool': { name: 'read_file', kind: 'read' } } }),
  frame(childId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed',
    rawOutput: { type: 'Text', text: 'File contents' } }),
  frame(childId, { sessionUpdate: 'plan', entries: [{ content: 'Verify the history', status: 'completed' }] }),
  frame(childId, { sessionUpdate: 'auto_compact_completed' }),
  frame(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Review ' } }),
  frame(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'complete.' } }),
];

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function registerChild(parent: string, child: string) {
  await write(join(nativePath(cwd, parent), 'subagents', child, 'meta.json'), JSON.stringify({
    parent_session_id: parent, child_session_id: child, subagent_type: 'general-purpose',
    description: 'Dynamic history lifecycle review', prompt: 'Review the history lifecycle', status: 'completed',
  }));
}
async function drill(call = toolUseId, fingerprint?: string) {
  const response = await POST(new Request('http://test.local/api/session-by-path', {
    method: 'POST', body: JSON.stringify({ cwd, sessionId, toolUseId: call, ifFingerprint: fingerprint }),
  }));
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'grok-subagent-transcript-'));
  vi.stubEnv('COCKPIT_HOME', join(home, 'cockpit'));
  vi.stubEnv('GROK_HOME', join(home, 'native'));
  vi.resetModules();
  ({ POST } = await import('./session-by-path'));
  ({ grokNativeSessionPath: nativePath } = await import('../../effect/grokNativeSessionLive'));
  const { grokSessionPath } = await import('../../effect/grokSessionLive');
  await write(grokSessionPath(cwd, sessionId), jsonl([
    { type: 'user', message: { role: 'user', content: 'Review' } },
  ]));
}, 30_000);

beforeEach(async () => {
  await rm(join(home, 'native'), { recursive: true, force: true });
  await registerChild(sessionId, childId);
  await write(join(nativePath(cwd, sessionId), 'updates.jsonl'), jsonl([receipt(sessionId, toolUseId, childId)]));
  await write(join(nativePath(cwd, childId), 'updates.jsonl'), jsonl(childReplay()));
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });

describe('Grok subagent transcript drill-in', () => {
  it('replays the native child dialogue, tools and final answer across compaction', async () => {
    // The compacted model context is deliberately insufficient to display the full dialogue.
    await write(join(nativePath(cwd, childId), 'chat_history.jsonl'), jsonl([{ type: 'system', content: 'Compacted context' }]));
    const { status, body } = await drill();
    expect(status).toBe(200);
    expect(body.subagent).toEqual({ agentType: 'general-purpose', description: 'Dynamic history lifecycle review' });
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual([
      'Review the history lifecycle', 'Reading code.\n\nReview complete.',
    ]);
    expect(body.messages[1].toolCalls[0]).toMatchObject({ id: 'read-1', name: 'Read', result: 'File contents' });
    const again = await drill();
    expect(again.body).toEqual(body);
    expect(await readFile(join(nativePath(cwd, childId), 'chat_history.jsonl'), 'utf8')).toContain('Compacted context');
  });

  it('supports conditional polling and refreshes when child output advances', async () => {
    const first = await drill();
    expect((await drill(toolUseId, first.body.fingerprint)).body).toEqual({ notModified: true, fingerprint: first.body.fingerprint });
    await appendFile(join(nativePath(cwd, childId), 'updates.jsonl'), jsonl([
      frame(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' More detail.' } }),
    ]));
    const next = await drill(toolUseId, first.body.fingerprint);
    expect(next.body.fingerprint).not.toBe(first.body.fingerprint);
    expect(next.body.messages[1].id).toBe(first.body.messages[1].id);
    expect(next.body.messages[1].content).toContain('More detail.');
  });

  it('ignores an incomplete trailing record during a live write', async () => {
    await appendFile(join(nativePath(cwd, childId), 'updates.jsonl'), '{"timestamp":');
    expect((await drill()).body.messages[1].content).toContain('Review complete.');
  });

  it('uses retained prompt and output when the child replay is absent', async () => {
    await rm(join(nativePath(cwd, childId), 'updates.jsonl'));
    await write(join(nativePath(cwd, sessionId), 'subagents', childId, 'output.json'), JSON.stringify({ schema_version: 1, output: 'Saved review' }));
    const { body } = await drill();
    expect(body.messages.map((message: { content: string }) => message.content)).toEqual(['Review the history lifecycle', 'Saved review']);
  });

  it('resolves a nested spawn while retaining the root session coordinates', async () => {
    const nestedId = 'grok-grandchild';
    await registerChild(childId, nestedId);
    await appendFile(join(nativePath(cwd, childId), 'updates.jsonl'), jsonl([receipt(childId, 'nested-call', nestedId)]));
    await write(join(nativePath(cwd, nestedId), 'updates.jsonl'), jsonl([
      frame(nestedId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Nested answer' } }),
    ]));
    expect((await drill('nested-call')).body.messages.at(-1).content).toBe('Nested answer');
  });

  it('returns 404 for an unknown tool call or mismatched parent metadata', async () => {
    expect((await drill('missing-call')).status).toBe(404);
    await registerChild('other-parent', childId);
    await write(join(nativePath(cwd, sessionId), 'subagents', childId, 'meta.json'), JSON.stringify({ parent_session_id: 'other-parent' }));
    expect((await drill()).status).toBe(404);
  });

  it('rejects traversal in the spawning tool id', async () => {
    expect((await drill('../other-session')).status).toBe(400);
  });
});
