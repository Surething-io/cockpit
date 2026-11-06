import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Deferred, Effect, Queue, Stream } from 'effect';
import type { WSConnection } from '@cockpit/effect-services';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('child_process', () => ({ spawn }));
vi.mock('../shell', () => ({ resolveBashShell: () => '/bin/sh', killProcessTree: vi.fn() }));
vi.mock('@cockpit/effect-runtime/server', () => ({ fromWebSocket: vi.fn() }));
import { handleBash } from './bashStreamHandler';

interface Output { type: string; data?: string }

describe('bash SDK UTF-8 transport', () => {
  it('decodes split stdout/stderr characters and flushes an incomplete suffix before exit', async () => {
    const messages = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const output = yield* Queue.unbounded<Output>();
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(),
      });
      spawn.mockImplementationOnce(() => {
        Effect.runFork(Deferred.succeed(ready, undefined));
        return child;
      });
      const conn: WSConnection = {
        messages: Stream.concat(Stream.make({ type: 'exec', id: 'utf8', command: 'fixture' }), Stream.never),
        send: (message) => Queue.offer(output, message as Output).pipe(Effect.asVoid),
        close: Effect.void,
      };
      yield* Effect.forkScoped(handleBash(conn, '/tmp'));
      yield* Deferred.await(ready);
      yield* Effect.sync(() => {
        let ended = 0;
        const end = () => { if (++ended === 2) child.emit('close', 0); };
        child.stdout.once('end', end);
        child.stderr.once('end', end);
        const stdout = Buffer.from('中文😀');
        const stderr = Buffer.from('错误€');
        for (const byte of stdout) child.stdout.write(Buffer.from([byte]));
        for (const byte of stderr) child.stderr.write(Buffer.from([byte]));
        child.stdout.end(Buffer.from([0xe4]));
        child.stderr.end();
      });
      return yield* Stream.fromQueue(output).pipe(Stream.takeUntil((message) => message.type === 'exit'), Stream.runCollect);
    })).pipe(Effect.timeout('5 seconds')));
    const stdout = [...messages].filter((m) => m.type === 'stdout').map((m) => m.data).join('');
    const stderr = [...messages].filter((m) => m.type === 'stderr').map((m) => m.data).join('');
    expect(stdout).toBe('中文😀\ufffd');
    expect(stderr).toBe('错误€');
    expect([...messages].at(-1)?.type).toBe('exit');
  });
});
