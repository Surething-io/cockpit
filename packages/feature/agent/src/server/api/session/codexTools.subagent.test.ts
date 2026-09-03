/**
 * One VERBATIM sub-agent-activity line per codex era.
 *
 * This line carries the only binding from a spawning `spawn_agent` call_id to the thread it
 * created. Everything sub-agent-shaped hangs off it: the drill-in resolves the child rollout
 * by it, and the report routing completes the Task bubble by it. It has now moved three times
 * (0.14x → 0.147 → 0.153) and the 0.153 move shipped inside a routine SDK version bump —
 * every codex sub-agent in cockpit silently lost its transcript and its result, while every
 * other codex surface kept working, so nothing else failed loudly enough to notice.
 *
 * So: on every codex SDK bump, capture a real line here first. These are copied from rollouts
 * on disk with only the ids anonymised — do not "tidy" them into what the parser expects, the
 * whole value is that they are observed rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { parseCodexSubAgentActivity } from './codexTools';

const payloadOf = (line: string) => (JSON.parse(line) as { payload: Record<string, unknown> }).payload;

// cli_version 0.147.0 — flat event, call_id under `event_id`.
const V147 =
  '{"timestamp":"2026-08-18T10:14:22.593Z","type":"event_msg","payload":{"type":"sub_agent_activity",' +
  '"event_id":"call_TmNtSYWsGoRKVeWT4KFAtnbN","occurred_at_ms":1787048062593,' +
  '"agent_thread_id":"01a0145d-6e18-7883-a26c-d53f82594311","agent_path":"/root/anthropic_claude","kind":"started"}}';

// cli_version 0.153.0 — wrapped in item_completed, call_id under `item.id`.
const V153 =
  '{"timestamp":"2026-09-03T12:37:31.108Z","ordinal":30,"type":"event_msg","payload":{"type":"item_completed",' +
  '"thread_id":"01a06745-ee9e-7263-b27e-e20155b39f00","turn_id":"01a06745-ef52-7902-a777-79b320bae3e2",' +
  '"item":{"type":"SubAgentActivity","id":"call_IwdWkWj8DOphM0di7Cj8HdTF","kind":"started",' +
  '"agent_thread_id":"01a06746-3b15-7d70-a33c-e37e84e32805","agent_path":"/root/cr_static"},' +
  '"started_at_ms":1788439051108,"completed_at_ms":1788439051108}}';

// 0.153's completion line. Its `item.id` is synthetic, NOT a call_id.
const V153_COMPLETED =
  '{"timestamp":"2026-09-03T12:40:13.553Z","ordinal":46,"type":"event_msg","payload":{"type":"item_completed",' +
  '"thread_id":"01a06745-ee9e-7263-b27e-e20155b39f00","turn_id":"01a06745-ef52-7902-a777-79b320bae3e2",' +
  '"item":{"type":"SubAgentActivity","id":"subagent-completed-01a06746-4e01-7d30-bc6e-c91eb829ff56","kind":"completed",' +
  '"agent_thread_id":"01a06746-4da0-7e11-8285-5808b93d4b8a","agent_path":"/root/cr_dynamic"},' +
  '"started_at_ms":1788439213553,"completed_at_ms":1788439213553}}';

describe('parseCodexSubAgentActivity across codex eras', () => {
  it('0.147: call_id under event_id', () => {
    expect(parseCodexSubAgentActivity(payloadOf(V147))).toEqual({
      callId: 'call_TmNtSYWsGoRKVeWT4KFAtnbN',
      agentThreadId: '01a0145d-6e18-7883-a26c-d53f82594311',
      agentPath: '/root/anthropic_claude',
      kind: 'started',
    });
  });

  it('0.153: call_id under item.id, discriminator under item.type', () => {
    expect(parseCodexSubAgentActivity(payloadOf(V153))).toEqual({
      callId: 'call_IwdWkWj8DOphM0di7Cj8HdTF',
      agentThreadId: '01a06746-3b15-7d70-a33c-e37e84e32805',
      agentPath: '/root/cr_static',
      kind: 'started',
    });
  });

  it('both eras normalise to the same shape — call sites stay era-blind', () => {
    const a = parseCodexSubAgentActivity(payloadOf(V147))!;
    const b = parseCodexSubAgentActivity(payloadOf(V153))!;
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('a completion line parses but binds to no spawn (its id is synthetic)', () => {
    const done = parseCodexSubAgentActivity(payloadOf(V153_COMPLETED));
    expect(done).toMatchObject({ kind: 'completed', agentThreadId: '01a06746-4da0-7e11-8285-5808b93d4b8a' });
    // Callers bind by looking this id up among the spawn calls they have seen. Asserting the
    // shape rather than filtering on `kind` keeps the parser from assuming which kinds exist.
    expect(done!.callId.startsWith('call_')).toBe(false);
  });

  it('unrelated event_msg lines are not mistaken for activity', () => {
    expect(parseCodexSubAgentActivity({ type: 'token_count' })).toBeNull();
    // An item_completed carrying some OTHER item type is the near miss that matters.
    expect(parseCodexSubAgentActivity({ type: 'item_completed', item: { type: 'CommandExecution', id: 'call_x' } })).toBeNull();
    expect(parseCodexSubAgentActivity(undefined)).toBeNull();
  });

  it('an activity line with no thread id yields nothing to bind to', () => {
    expect(parseCodexSubAgentActivity({ type: 'sub_agent_activity', event_id: 'call_1' })).toBeNull();
    expect(parseCodexSubAgentActivity({ type: 'item_completed', item: { type: 'SubAgentActivity', id: 'call_1' } })).toBeNull();
  });
});
