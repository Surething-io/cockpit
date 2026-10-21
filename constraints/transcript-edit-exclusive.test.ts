/**
 * Constraint: TranscriptEditExclusive (invariant, L2).
 *
 * While an edit of a session's transcript is in flight (deleting a turn reads
 * the whole jsonl, filters it and writes it back), no new turn can start on
 * that session: startRun refuses and waitForWriter keeps waiting until the
 * edit is done. Once the edit finishes, the next turn starts normally.
 *
 * Why: deleteTurn checked isSessionBusy once and then awaited the file lock
 * and the read. A turn starting in that window (a scheduled task firing,
 * another tab sending) had its engine append to the jsonl — the engine's CLI
 * does not take Cockpit's file lock — and the delete's write-back overwrote
 * those lines, losing the turn.
 *
 * The edit is held mid-flight by taking the transcript's file lock first, so
 * the request has passed its busy check and is waiting on the lock.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'cockpit-transcript-edit-'));
process.env.COCKPIT_HOME = dir;
const transcript = join(dir, 'session-1.jsonl');

vi.mock('../packages/feature/agent/src/server/api/session/sessionStore', () => ({
  // async: the resolver probes the stores with fs/promises and the codex catalog.
  resolveSessionPath: async () => ({ sessionPath: transcript, engine: 'claude' }),
}));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const turn = (n: number, parent: string | null) => [
  line({ type: 'user', uuid: `u${n}`, parentUuid: parent, message: { role: 'user', content: [{ type: 'text', text: `q${n}` }] } }),
  line({ type: 'assistant', uuid: `a${n}`, parentUuid: `u${n}`, message: { role: 'assistant', content: [{ type: 'text', text: `a${n}` }] } }),
];

describe('TranscriptEditExclusive', () => {
  it('no turn can start on a session while its transcript is being edited', async () => {
    writeFileSync(transcript, [...turn(1, null), ...turn(2, 'a1')].join('\n') + '\n');
    const { withFileLock } = await import('../packages/shared/utils/src/index');
    const hub = await import('../packages/feature/agent/src/server/sessionRunHub');
    const { DELETE } = await import('../packages/feature/agent/src/server/api/session/deleteTurn');

    // Hold the transcript's lock so the delete stops after its busy check.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });
    const held = withFileLock(transcript, () => gate);

    const pending = (DELETE as (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => Promise<Response>)(
      new Request('http://localhost/api/session/session-1/turn', {
        method: 'DELETE',
        body: JSON.stringify({ cwd: dir, messageUuid: 'a1' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ sessionId: 'session-1' }) },
    );
    await new Promise((r) => setTimeout(r, 50)); // let it reach the lock

    // Mid-edit: a new turn must not start.
    expect(hub.isSessionBusy('session-1'), 'busy while the edit is in flight').toBe(true);
    expect(await hub.waitForWriter('session-1', 50), 'waitForWriter waits out the edit').toBe(false);
    expect(hub.startRun('session-1', dir), 'startRun refused mid-edit').toBe(false);

    openGate();
    await held;
    const res = await pending;
    expect(res.status).toBe(200);
    expect(readFileSync(transcript, 'utf8')).not.toContain('"q1"');

    // After the edit: the next turn starts normally.
    expect(await hub.waitForWriter('session-1', 50)).toBe(true);
    expect(hub.startRun('session-1', dir)).toBe(true);
    hub.markRunIdle('session-1');
    hub.releaseRun('session-1');
  });

  it('an edit is refused while a turn holds the session', async () => {
    writeFileSync(transcript, turn(1, null).join('\n') + '\n');
    const hub = await import('../packages/feature/agent/src/server/sessionRunHub');
    const { DELETE } = await import('../packages/feature/agent/src/server/api/session/deleteTurn');
    expect(hub.startRun('session-2', dir)).toBe(true);
    const res = await (DELETE as (req: Request, ctx: { params: Promise<{ sessionId: string }> }) => Promise<Response>)(
      new Request('http://localhost/api/session/session-2/turn', {
        method: 'DELETE',
        body: JSON.stringify({ cwd: dir, messageUuid: 'a1' }),
        headers: { 'content-type': 'application/json' },
      }),
      { params: Promise.resolve({ sessionId: 'session-2' }) },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(readFileSync(transcript, 'utf8')).toContain('"q1"');
    hub.markRunIdle('session-2');
    hub.releaseRun('session-2');
  });
});
