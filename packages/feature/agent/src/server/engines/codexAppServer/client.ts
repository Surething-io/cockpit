import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import type { SpawnEnv } from '@cockpit/shared-utils';
import { resolveCodexBinary, applyCodexPathDirs } from './binary';

/**
 * A minimal client for `codex app-server`.
 *
 * The wire format is newline-delimited JSON over stdio and is JSON-RPC SHAPED
 * but is not JSON-RPC: there is no `"jsonrpc": "2.0"` member in either
 * direction, and sending one is not part of the handshake. Verified against
 * codex-cli 0.153.2.
 *
 * One process per turn, deliberately. A long-lived server caches each thread's
 * history in memory, and Cockpit's independent-task feature works by swapping
 * the rollout file on disk underneath Codex — measured, a warm process does not
 * notice, so the feature degrades to a normal history-carrying turn with no
 * error anywhere. A cold process reads the rollout every time. The cost of that
 * choice is ~150ms of startup per turn, against a first token that is seconds
 * away; the exec transport this replaces also spawned per turn, so this is not
 * a regression but the status quo.
 */

/** Server → client push. `params` is left untyped; each call site narrows. */
export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerOptions {
  /** Built by `sanitizedSpawnEnv` — the host Next server's fingerprint stripped. */
  env: SpawnEnv;
  cwd?: string;
  onNotification: (n: CodexNotification) => void;
  /** Real stderr lines, already split. Codex is chatty here even when healthy. */
  onStderr?: (line: string) => void;
  /**
   * The transport died. Fires once, for a spawn failure, a crash, or a kill —
   * and it is the ONLY signal after `turn/start` has resolved, because by then
   * there is no pending request left for a rejection to travel on. Without it a
   * dead child leaves the turn waiting on a notification that can never arrive.
   */
  onClosed?: (error: Error) => void;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

/** Thrown when the transport is torn down on purpose — an abort or a normal close. */
export class CodexAppServerAborted extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAppServerAborted';
  }
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private exitReason: Error | null = null;

  private constructor(child: ChildProcessWithoutNullStreams, private readonly opts: CodexAppServerOptions) {
    this.child = child;

    readLines(child.stdout, (line) => this.onLine(line));
    readLines(child.stderr, (line) => {
      if (line.trim()) opts.onStderr?.(line);
    });

    child.on('error', (err) => this.fail(err));
    // A pipe raises 'error' in its own right (EPIPE/EIO once the child is gone),
    // and an unhandled one on a stream is a process-level crash — it would take
    // the whole Next server down instead of this one turn.
    for (const pipe of [child.stdin, child.stdout, child.stderr]) {
      pipe.on('error', (err: Error) => this.fail(err));
    }
    child.on('exit', (code, signal) => {
      this.fail(
        new CodexAppServerError(
          `codex app-server exited (${signal ? `signal ${signal}` : `code ${code ?? 'null'}`})`,
        ),
      );
    });

    /**
     * Abort is NOT wired to teardown here, deliberately.
     *
     * Stopping a run well means asking the server to interrupt each turn first
     * — which is a request, on this connection, made after the abort. Tearing
     * the transport down the moment the signal fires makes that impossible, so
     * the lifecycle belongs to the caller (see `interruptTurns` in the runner)
     * and the signal is only carried for the spawn itself.
     */
  }

  static start(opts: CodexAppServerOptions): CodexAppServerClient {
    const bin = resolveCodexBinary();
    const env: SpawnEnv = { ...opts.env };
    applyCodexPathDirs(env, bin.pathDirs);
    const child = spawn(bin.executablePath, ['app-server'], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    return new CodexAppServerClient(child, opts);
  }

  /**
   * Settle every in-flight request when the transport dies. Without this a
   * crashed child leaves the turn awaiting a reply that can never arrive, and
   * the run hangs rather than reporting an error.
   */
  private fail(err: Error): void {
    if (this.exitReason) return;
    this.exitReason = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.opts.onClosed?.(err);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A non-JSON line on stdout is a protocol violation, not our business to
      // repair; dropping it keeps one bad line from killing a live turn.
      return;
    }

    const id = msg.id;
    // A message carrying BOTH id and method is a server→client REQUEST. Cockpit
    // runs with approvalPolicy 'never', under which none are ever sent
    // (verified end-to-end), so the only correct answer is "method not found" —
    // silence would block the agent forever waiting on a reply.
    if (typeof id === 'number' && typeof msg.method === 'string') {
      this.write({ id, error: { code: -32601, message: `Unhandled server request: ${msg.method}` } });
      return;
    }
    if (typeof id === 'number') {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (err) p.reject(new CodexAppServerError(err.message ?? 'codex app-server error', err.code, err.data));
      else p.resolve((msg.result as Record<string, unknown>) ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      // Guarded because this runs inside a stream 'data' handler: anything the
      // shim or the adapter throws would escape as an unhandled stream error
      // and take the host process with it, rather than failing this turn.
      try {
        this.opts.onNotification({
          method: msg.method,
          params: (msg.params as Record<string, unknown>) ?? {},
        });
      } catch (cause) {
        this.fail(cause instanceof Error ? cause : new CodexAppServerError(String(cause)));
      }
    }
  }

  private write(payload: Record<string, unknown>): void {
    if (this.closed) return;
    // LF only. The reader tolerates CRLF coming back, but nothing on either
    // platform asks us to send it.
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    if (this.exitReason) return Promise.reject(this.exitReason);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) });
  }

  dispose(aborted = false): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new CodexAppServerAborted(aborted ? 'codex run aborted' : 'codex app-server client disposed'));
    killTree(this.child);
  }
}

/**
 * Split a stream into lines, tolerating both framings and multi-byte
 * characters split across chunk boundaries.
 *
 * `\r` is stripped from every line including the final unterminated one. JSON
 * parsing would survive a trailing CR either way; doing it uniformly means the
 * two paths cannot disagree, which is the bug shape this class of code
 * actually produces.
 */
function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  stream.on('data', (chunk: Buffer) => {
    carry += decoder.write(chunk);
    let index = carry.indexOf('\n');
    while (index !== -1) {
      onLine(carry.slice(0, index).replace(/\r$/, ''));
      carry = carry.slice(index + 1);
      index = carry.indexOf('\n');
    }
  });
  stream.on('end', () => {
    carry += decoder.end();
    if (carry) onLine(carry.replace(/\r$/, ''));
    carry = '';
  });
}

/**
 * `child.kill()` on Windows terminates only the named pid, leaving the shells
 * Codex spawned for tool calls orphaned and still holding the workspace. The
 * tree kill is what the platform offers instead of a process group.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to the generic kill
    }
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
}
