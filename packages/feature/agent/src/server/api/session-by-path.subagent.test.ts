/**
 * Drill-in at any spawn depth.
 *
 * A sub-agent can spawn sub-agents of its own, several levels down. Every one of them writes
 * its meta sidecar into the SAME flat `<sessionId>/subagents/` directory of the session that
 * started the whole thing, and findSubagentTranscript resolves purely by the spawning
 * `tool_use` id — so one request shape reaches depth 1, 2 and 3 alike, with the MAIN session id
 * throughout. Verified against a real transcript: a depth-3 agent's sidecar names a tool_use id
 * that lives in the depth-2 agent's jsonl, and so on up the chain.
 *
 * That was already true before the UI could use it: SubagentTranscriptModal rendered its rows
 * without `sessionId`, and ToolCallModal gates the drill-in entry on `cwd && sessionId`, so a
 * nested Agent row simply had no entry to click. These tests pin the server half of the
 * contract the fix leans on, so the entry cannot be re-added against a lookup that has silently
 * become depth-1-only.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join, dirname } from 'path';

let projectDir: string;
const SESSION = 'main-session';

vi.mock('@cockpit/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cockpit/shared-utils')>();
  return {
    ...actual,
    getClaudeSessionPath: (_cwd: string, sessionId: string) => join(projectDir, `${sessionId}.jsonl`),
  };
});

const write = (p: string, body: string) => {
  fs.mkdirSync(dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

/** An agent's transcript + the sidecar naming the tool call that spawned it. */
const writeAgent = (agentId: string, toolUseId: string, spawnDepth: number, answer: string) => {
  const base = join(projectDir, SESSION, 'subagents', `agent-${agentId}`);
  write(`${base}.meta.json`, JSON.stringify({ agentType: 'general-purpose', description: `d${spawnDepth}`, toolUseId, spawnDepth }));
  write(
    `${base}.jsonl`,
    [
      JSON.stringify({ type: 'user', uuid: `u-${agentId}`, message: { role: 'user', content: 'go' } }),
      JSON.stringify({
        type: 'assistant',
        uuid: `a-${agentId}`,
        message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
      }),
    ].join('\n') + '\n'
  );
};

const drillIn = async (toolUseId: string) => {
  const { POST } = await import('./session-by-path');
  const response = await POST(
    new Request('http://test.local/api/session-by-path', {
      method: 'POST',
      body: JSON.stringify({ cwd: '/tmp/proj', sessionId: SESSION, toolUseId }),
    })
  );
  return { status: response.status, body: await response.json() };
};

beforeEach(() => {
  projectDir = fs.mkdtempSync(join(os.tmpdir(), 'subagent-depth-'));
  // The main session only has to exist — resolveSessionPath keys the engine off it.
  write(join(projectDir, `${SESSION}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'research' } }) + '\n');
  // A 3-level chain. Note every sidecar lands in the SAME directory regardless of depth,
  // and each names a tool_use id belonging to the transcript one level up.
  writeAgent('d1', 'toolu_1', 1, 'depth one done');
  writeAgent('d2', 'toolu_2', 2, 'depth two done');
  writeAgent('d3', 'toolu_3', 3, 'depth three done');
});
afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

describe('session-by-path subagent drill-in depth', () => {
  it('resolves depth 1, 2 and 3 from the same main session id', async () => {
    for (const [toolUseId, answer] of [
      ['toolu_1', 'depth one done'],
      ['toolu_2', 'depth two done'],
      ['toolu_3', 'depth three done'],
    ]) {
      const { body } = await drillIn(toolUseId);
      expect(body.messages.at(-1)).toMatchObject({ role: 'assistant', content: answer });
    }
  });

  it('carries the sidecar meta for a nested agent, not just a top-level one', async () => {
    // The modal titles itself from this; a nested drill-in that resolved the transcript but
    // lost the meta would open an unlabelled window.
    const { body } = await drillIn('toolu_3');
    expect(body.subagent).toMatchObject({ agentType: 'general-purpose', description: 'd3' });
  });

  it('404s a tool_use id no agent was spawned from, at any depth', async () => {
    const { status } = await drillIn('toolu_nosuch');
    expect(status).toBe(404);
  });
});
