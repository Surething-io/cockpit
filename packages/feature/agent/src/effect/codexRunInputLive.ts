import { Deferred, Effect, Queue } from 'effect';
import { AgentError } from '@cockpit/effect-core';
import type { InjectedInput, RunCtx } from '../server/engines/types';

export interface CodexRunInput {
  readonly open: (send: (input: InjectedInput) => Promise<void>) => void;
  readonly close: () => void;
}

/** Own admission before startup, FIFO steering and failure feedback for one subprocess. */
export const withCodexRunInput = (
  ctx: RunCtx,
  run: (input: CodexRunInput) => Promise<void>,
): Effect.Effect<void, AgentError> => Effect.scoped(Effect.gen(function* () {
  const queue = yield* Queue.unbounded<InjectedInput>();
  const ready = yield* Deferred.make<(input: InjectedInput) => Promise<void>>();
  const pending = new Set<InjectedInput>();
  let accepting = true;
  let current: InjectedInput | undefined;
  const notice = (input: InjectedInput, state: 'queued' | 'accepted' | 'failed', error?: string): void => {
    if (state === 'failed') {
      ctx.emit({ type: 'error', error: error ?? 'Input delivery was not confirmed.', undeliveredInputs: [input] });
      return;
    }
    ctx.emit({
      type: 'system', subtype: 'notice', notice: `codex_input_${state}`,
      input_text: input.text ?? '', input_images: input.images?.length ?? 0, error,
    });
  };
  const close = (): void => {
    if (!accepting) return;
    accepting = false;
    ctx.acceptInput(null);
    for (const input of pending) {
      notice(input, 'failed', input === current
        ? 'Delivery was not confirmed before the run closed. Check the conversation before retrying.'
        : 'The run closed before this message was sent. Send it again in the next turn.');
    }
    pending.clear();
  };
  yield* Effect.acquireRelease(Effect.sync(() => {
    ctx.acceptInput((input) => {
      if (!accepting || ctx.signal.aborted) return false;
      pending.add(input);
      queue.unsafeOffer(input);
      notice(input, 'queued');
      return true;
    });
    ctx.signal.addEventListener('abort', close, { once: true });
    if (ctx.signal.aborted) close();
  }), () => Effect.sync(() => {
    close();
    ctx.signal.removeEventListener('abort', close);
  }));
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  yield* Effect.forkScoped(Effect.gen(function* () {
    const send = yield* Deferred.await(ready);
    while (true) {
      const input = yield* Queue.take(queue);
      if (!accepting) return;
      current = input;
      yield* Effect.tryPromise({
        try: () => send(input),
        catch: (cause) => new AgentError({ provider: 'codex', kind: 'protocol', cause }),
      }).pipe(Effect.match({
        onFailure: (error) => {
          if (pending.delete(input)) notice(input, 'failed', String(error.cause));
        },
        onSuccess: () => {
          if (pending.delete(input)) notice(input, 'accepted');
        },
      }));
      current = undefined;
    }
  }));
  yield* Effect.tryPromise({
    try: () => run({
      open: (send) => { Effect.runSync(Deferred.succeed(ready, send)); },
      close,
    }),
    catch: (cause) => new AgentError({ provider: 'codex', kind: 'protocol', cause }),
  });
})).pipe(Effect.withSpan('agent.codex.input'));
