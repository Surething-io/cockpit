/**
 * Constraint: RunExclusiveUntilExit (concurrency protocol, L3 — model-based).
 *
 * At most one engine writes a session at a time. A stopped run stops streaming
 * to the UI at once, but it keeps the session's writer lease until its engine
 * has really exited; a new turn waits for that, and anything that rewrites the
 * transcript (deleteTurn) sees the session as busy meanwhile.
 *
 * Checked against the real orchestrator + run registry, driven by random
 * command sequences (fast-check model-based testing). The fake engine does not
 * finish when aborted — it finishes only on an explicit `exit` command, which
 * models a child process still flushing after Stop.
 *
 * Why: requestStop marked the run idle immediately, so "Stop, then send again"
 * started a second engine on the same session while the first was still
 * writing the transcript (and, for Codex no-history runs, merging its stash).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dispatchChat } from '../packages/feature/agent/src/server/engines/orchestrator';
import * as hub from '../packages/feature/agent/src/server/sessionRunHub';
import type { EngineSpec, RunCtx } from '../packages/feature/agent/src/server/engines/types';

/** isSessionBusy after the fix; isRunActive is all the old registry had. */
const isBusy: (key: string) => boolean =
  (hub as { isSessionBusy?: (k: string) => boolean }).isSessionBusy ?? hub.isRunActive;

interface FakeRun {
  aborted: boolean;
  finish: () => void;
}

/** System under test, one session per property run. */
class Sut {
  readonly session = `session-${Math.random().toString(36).slice(2)}`;
  readonly live: FakeRun[] = []; // runners whose run() has started and not returned
  readonly pending: Promise<unknown>[] = [];
  maxConcurrentWriters = 0;

  readonly spec: EngineSpec = {
    name: 'fake',
    runner: {
      run: (ctx: RunCtx) =>
        new Promise<void>((resolve) => {
          const run: FakeRun = {
            aborted: false,
            finish: () => {
              this.live.splice(this.live.indexOf(run), 1);
              resolve();
            },
          };
          ctx.signal.addEventListener('abort', () => { run.aborted = true; }, { once: true });
          this.live.push(run);
          this.maxConcurrentWriters = Math.max(this.maxConcurrentWriters, this.live.length);
        }),
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

class Send implements fc.AsyncCommand<object, Sut> {
  check = () => true;
  async run(_: object, sut: Sut) {
    // Not awaited: after the fix a send may wait for a stopping run to exit.
    sut.pending.push(dispatchChat(sut.spec, { prompt: 'p', sessionId: sut.session }));
    await tick();
  }
  toString = () => 'send';
}

class Stop implements fc.AsyncCommand<object, Sut> {
  check = () => true;
  async run(_: object, sut: Sut) {
    hub.requestStop(sut.session);
    await tick();
  }
  toString = () => 'stop';
}

/** A stopped engine's child finally exits. */
class Exit implements fc.AsyncCommand<object, Sut> {
  check = () => true;
  async run(_: object, sut: Sut) {
    sut.live.find((r) => r.aborted)?.finish();
    await tick();
  }
  toString = () => 'exit';
}

/** A running turn completes on its own. */
class Complete implements fc.AsyncCommand<object, Sut> {
  check = () => true;
  async run(_: object, sut: Sut) {
    sut.live.find((r) => !r.aborted)?.finish();
    await tick();
  }
  toString = () => 'complete';
}

const commands = [
  fc.constant(new Send()),
  fc.constant(new Stop()),
  fc.constant(new Exit()),
  fc.constant(new Complete()),
];

describe('RunExclusiveUntilExit', () => {
  it('one writer per session, and busy until that writer has exited', async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 12 }), async (cmds) => {
        const sut = new Sut();
        const checked = cmds as Iterable<fc.AsyncCommand<object, Sut>>;
        try {
          for (const cmd of checked) {
            await cmd.run({}, sut);
            expect(sut.live.length, 'concurrent writers').toBeLessThanOrEqual(1);
            if (sut.live.length > 0) expect(isBusy(sut.session), 'busy while a writer lives').toBe(true);
          }
        } finally {
          // Drain: let every engine exit, so queued sends start and finish too.
          for (let i = 0; i < 50 && (sut.live.length || sut.pending.length); i++) {
            while (sut.live.length) sut.live[0].finish();
            await tick();
            if (!sut.live.length) {
              await Promise.race([Promise.all(sut.pending), tick()]);
              if (!sut.live.length) break;
            }
          }
        }
        expect(sut.maxConcurrentWriters, 'max concurrent writers').toBeLessThanOrEqual(1);
      }),
      { numRuns: 150 },
    );
  }, 60_000);
});
