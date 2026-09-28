// Client side of bin/pty-host.mjs — the separate process that owns every
// terminal bubble's process.
//
// The server never spawns a terminal command itself any more: a PTY dies with
// the process holding its master fd, and the server kills its children on
// exit, so every cockpit update/restart used to kill the dev servers users had
// running in terminal bubbles. The host outlives us; this module talks to it
// over a local socket and hands the rest of the server stand-ins shaped like
// what it used before — node-pty's IPty (`PtyHandle`) for PTY mode, a
// ChildProcess (`PipeProcess`) for pipe mode — so the registry and the WS
// handler keep their existing listener/dispose logic.
//
// State lives on globalThis (like the registry itself): in dev the Next route
// bundle and server.mjs load separate copies of this module, and two
// connections would each receive — and each ack — the same exit events.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { EventEmitter } from 'events';
import { connect, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { COCKPIT_DIR, isWindows } from '@cockpit/shared-utils';

/** Must match PROTOCOL in bin/pty-host.mjs. Bump both on any incompatible change. */
export const PTY_HOST_PROTOCOL = 1;

/** How long a freshly launched host gets to start listening. */
const LAUNCH_TIMEOUT_MS = 8_000;
const LAUNCH_POLL_MS = 50;
/** Exit code reported for sessions lost because the host itself went away. */
const HOST_LOST_EXIT_CODE = -1;

export interface Disposable {
  dispose(): void;
}

/** The subset of node-pty's IPty the server uses. */
export interface PtyHandle {
  readonly pid: number;
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** The subset of ChildProcess a pipe-mode command uses (RemotePipe mimics it). */
export interface PipeProcess {
  readonly pid?: number;
  readonly stdout: EventEmitter | null;
  readonly stderr: EventEmitter | null;
  readonly stdin: { readonly writable: boolean; write(data: string): unknown; end(): unknown } | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ChildProcess's catch-all overload
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors ChildProcess's catch-all overload
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/** What the server needs to re-register a session after a restart. */
export interface PtySessionMeta {
  commandId: string;
  command: string;
  cwd: string;
  projectCwd: string;
  tabId: string;
  timestamp: string;
  sourceId?: string;
}

interface AdoptedBase {
  meta: PtySessionMeta | null;
  /** Everything the host still buffers, including what we missed while down. */
  output: string;
  /** Set when the session ended while no server was connected. */
  exitCode?: number;
}

/** A session the host already had when we connected. */
export type AdoptedHostSession =
  | (AdoptedBase & { kind: 'pty'; handle: PtyHandle })
  | (AdoptedBase & { kind: 'pipe'; handle: PipeProcess });

export interface PtySpawnOptions {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  meta: PtySessionMeta;
}

export type PipeSpawnOptions = Omit<PtySpawnOptions, 'cols' | 'rows'>;

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────

function homeHash(): string {
  return createHash('sha1').update(COCKPIT_DIR).digest('hex').slice(0, 12);
}

/**
 * One host per data dir and protocol version. Unix socket paths are capped
 * around 104 bytes (macOS), so a deep COCKPIT_HOME falls back to tmpdir.
 */
export function ptyHostSocketPath(): string {
  const name = `cockpit-pty-v${PTY_HOST_PROTOCOL}-${homeHash()}`;
  if (isWindows) return `\\\\.\\pipe\\${name}`;
  const preferred = join(COCKPIT_DIR, 'pty-host', `v${PTY_HOST_PROTOCOL}.sock`);
  return preferred.length <= 100 ? preferred : join(tmpdir(), `${name}.sock`);
}

// ─────────────────────────────────────────────────────────
// Remote sessions
// ─────────────────────────────────────────────────────────

type ExitEvent = { exitCode: number | null; signal?: number | string | null };

/** What the connection needs from either kind of remote session. */
interface RemoteSession {
  emitData(data: string, stream?: 'stdout' | 'stderr'): void;
  emitExit(e: ExitEvent): void;
}

class RemotePty implements PtyHandle, RemoteSession {
  pid: number;
  private dataCbs = new Set<(data: string) => void>();
  private exitCbs = new Set<(e: { exitCode: number; signal?: number }) => void>();
  /** Output that arrived before anyone listened (see onData). */
  private pending: string[] = [];
  private exitEvent: { exitCode: number; signal?: number } | null = null;
  private exitDelivered = false;

  constructor(
    readonly id: string,
    private readonly conn: HostConnection,
    pid: number,
  ) {
    this.pid = pid;
  }

  /**
   * The spawn reply and the first output can arrive in the same socket chunk,
   * i.e. before the caller's `await` resumes and attaches listeners. Buffer
   * until the first listener, then flush on a microtask so every listener the
   * caller attaches in that same synchronous block sees the same bytes —
   * matching node-pty, whose events never fire synchronously after spawn().
   */
  onData(cb: (data: string) => void): Disposable {
    this.dataCbs.add(cb);
    if (this.pending.length > 0) {
      queueMicrotask(() => {
        const chunks = this.pending;
        this.pending = [];
        for (const c of chunks) this.emitData(c);
      });
    }
    return { dispose: () => { this.dataCbs.delete(cb); } };
  }

  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable {
    this.exitCbs.add(cb);
    if (this.exitEvent && !this.exitDelivered) queueMicrotask(() => this.deliverExit());
    return { dispose: () => { this.exitCbs.delete(cb); } };
  }

  write(data: string): void {
    this.conn.send({ op: 'write', id: this.id, data });
  }

  resize(cols: number, rows: number): void {
    this.conn.send({ op: 'resize', id: this.id, cols, rows });
  }

  kill(signal?: string): void {
    this.conn.send({ op: 'kill', id: this.id, ...(signal ? { signal } : {}) });
  }

  /** @internal */
  emitData(data: string): void {
    if (this.dataCbs.size === 0 || this.pending.length > 0) {
      this.pending.push(data);
      return;
    }
    for (const cb of [...this.dataCbs]) cb(data);
  }

  /** @internal */
  emitExit(e: ExitEvent): void {
    if (this.exitEvent) return;
    this.exitEvent = { exitCode: e.exitCode ?? 0, signal: typeof e.signal === 'number' ? e.signal : undefined };
    // Data still waiting for a listener goes first, as it would have in-process.
    queueMicrotask(() => this.deliverExit());
  }

  private deliverExit(): void {
    if (this.exitDelivered || !this.exitEvent || this.exitCbs.size === 0) return;
    if (this.pending.length > 0) {
      const chunks = this.pending;
      this.pending = [];
      for (const cb of [...this.dataCbs]) for (const c of chunks) cb(c);
    }
    this.exitDelivered = true;
    for (const cb of [...this.exitCbs]) cb(this.exitEvent);
    // Only now may the host forget it: once the exit listeners (which persist
    // the finished bubble) have run. A server dying before this point leaves
    // the session in the host for the next server to pick up.
    this.conn.send({ op: 'ack', id: this.id });
    this.conn.sessions.delete(this.id);
  }
}

/**
 * Pipe-mode stand-in for a ChildProcess. Same buffering contract as
 * RemotePty: output and the exit are held until someone listens, then
 * delivered on a microtask, and the host is acked only after 'close' ran.
 * It never emits 'error' — the host reports a failed child as exit code 1.
 */
class RemotePipe extends EventEmitter implements PipeProcess, RemoteSession {
  pid: number;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: { writable: boolean; write(data: string): boolean; end(): void };
  private pending: Array<{ stream: 'stdout' | 'stderr'; data: string }> = [];
  private exitEvent: ExitEvent | null = null;
  private exitDelivered = false;

  constructor(
    readonly id: string,
    private readonly conn: HostConnection,
    pid: number,
  ) {
    super();
    this.pid = pid;
    this.stdin = {
      writable: true,
      write: (data: string) => {
        conn.send({ op: 'write', id, data });
        return true;
      },
      end: () => {
        this.stdin.writable = false;
        conn.send({ op: 'eof', id });
      },
    };
    const onNewListener = (event: string | symbol) => {
      if (event === 'data' && this.pending.length > 0) queueMicrotask(() => this.flush());
    };
    this.stdout.on('newListener', onNewListener);
    this.stderr.on('newListener', onNewListener);
    this.on('newListener', (event: string | symbol) => {
      if (event === 'close' && this.exitEvent && !this.exitDelivered) queueMicrotask(() => this.deliverExit());
    });
  }

  /** @internal */
  emitData(data: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    const listening = this.stdout.listenerCount('data') + this.stderr.listenerCount('data') > 0;
    if (!listening || this.pending.length > 0) {
      this.pending.push({ stream, data });
      return;
    }
    this[stream].emit('data', data);
  }

  /** @internal */
  emitExit(e: ExitEvent): void {
    if (this.exitEvent) return;
    this.exitEvent = e;
    queueMicrotask(() => this.deliverExit());
  }

  private flush(): void {
    const chunks = this.pending;
    this.pending = [];
    for (const c of chunks) this[c.stream].emit('data', c.data);
  }

  private deliverExit(): void {
    if (this.exitDelivered || !this.exitEvent || this.listenerCount('close') === 0) return;
    this.flush();
    this.exitDelivered = true;
    this.stdin.writable = false;
    this.emit('close', this.exitEvent.exitCode, this.exitEvent.signal ?? null);
    this.conn.send({ op: 'ack', id: this.id });
    this.conn.sessions.delete(this.id);
  }
}

// ─────────────────────────────────────────────────────────
// Connection
// ─────────────────────────────────────────────────────────

interface HostSessionWire {
  id: string;
  kind: 'pty' | 'pipe';
  pid: number;
  meta: PtySessionMeta | null;
  output: string;
  exited?: boolean;
  exitCode?: number | null;
  signal?: number | string | null;
}

interface HelloWire {
  /** Hash of the host's own code; absent from hosts that predate the check. */
  build?: string;
  sessions?: HostSessionWire[];
}

type AdoptHandler = (sessions: AdoptedHostSession[]) => Promise<void>;

class HostConnection {
  readonly sessions = new Map<string, RemoteSession>();
  private spawnWaiters = new Map<string, { resolve: (pid: number) => void; reject: (e: Error) => void }>();
  private buf = '';
  closed = false;

  constructor(private readonly sock: Socket, private readonly onClose: () => void) {
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => this.onChunk(chunk));
    sock.on('close', () => this.handleClose());
    sock.on('error', () => this.handleClose());
  }

  send(msg: Record<string, unknown>): void {
    if (this.closed) return;
    try { this.sock.write(JSON.stringify(msg) + '\n'); } catch { /* closing */ }
  }

  /** Resolves with the host's build and existing sessions. */
  hello(): Promise<HelloWire> {
    return new Promise((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
      this.send({ op: 'hello', proto: PTY_HOST_PROTOCOL });
    });
  }

  private helloWaiter: { resolve: (h: HelloWire) => void; reject: (e: Error) => void } | null = null;

  spawn<T extends RemotePty | RemotePipe>(kind: 'pty' | 'pipe', remote: T, opts: PipeSpawnOptions): Promise<T> {
    // Registered before the request goes out so no output can slip past.
    this.sessions.set(opts.id, remote);
    return new Promise<number>((resolve, reject) => {
      this.spawnWaiters.set(opts.id, { resolve, reject });
      this.send({ op: 'spawn', kind, ...opts });
    }).then(
      (pid) => {
        remote.pid = pid;
        return remote;
      },
      (e) => {
        if (this.sessions.get(opts.id) === remote) this.sessions.delete(opts.id);
        throw e;
      },
    );
  }

  shutdownHost(): void {
    this.send({ op: 'shutdown' });
  }

  /** Resolves once the socket is gone. */
  whenClosed(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => this.sock.once('close', () => resolve()));
  }

  destroy(): void {
    this.sock.destroy();
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id as string;
    switch (msg.ev) {
      case 'hello': {
        const waiter = this.helloWaiter;
        this.helloWaiter = null;
        if (msg.proto !== PTY_HOST_PROTOCOL) {
          waiter?.reject(new Error(`pty-host protocol mismatch: host ${String(msg.proto)}, server ${PTY_HOST_PROTOCOL}`));
          return;
        }
        waiter?.resolve(msg as HelloWire);
        return;
      }
      case 'spawned':
        this.spawnWaiters.get(id)?.resolve(msg.pid as number);
        this.spawnWaiters.delete(id);
        return;
      case 'spawnError':
        this.spawnWaiters.get(id)?.reject(new Error(String(msg.error)));
        this.spawnWaiters.delete(id);
        return;
      case 'data':
        this.sessions.get(id)?.emitData(msg.data as string, msg.stream as 'stdout' | 'stderr' | undefined);
        return;
      case 'exit':
        this.sessions.get(id)?.emitExit({ exitCode: msg.exitCode as number | null, signal: msg.signal as number | string | null });
        return;
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.helloWaiter?.reject(new Error('pty-host connection closed'));
    this.helloWaiter = null;
    for (const w of this.spawnWaiters.values()) w.reject(new Error('pty-host connection closed'));
    this.spawnWaiters.clear();
    // The host is gone (a live host never drops a connection), and its
    // sessions went with it. Finish every bubble instead of leaving it
    // spinning forever.
    if (this.sessions.size > 0) {
      console.error(`[pty-host] connection lost with ${this.sessions.size} live session(s)`);
    }
    for (const session of this.sessions.values()) session.emitExit({ exitCode: HOST_LOST_EXIT_CODE });
    this.onClose();
  }
}

// ─────────────────────────────────────────────────────────
// Singleton + public API
// ─────────────────────────────────────────────────────────

interface ClientState {
  conn?: HostConnection;
  connecting?: Promise<HostConnection | null>;
  launching?: Promise<HostConnection | null>;
  adopt?: AdoptHandler;
}

const STATE_KEY = Symbol.for('cockpit_pty_host_client');

function state(): ClientState {
  const g = globalThis as unknown as Record<symbol, ClientState | undefined>;
  return (g[STATE_KEY] ??= {});
}

/** Called by the registry: what to do with sessions found on (re)connect. */
export function setPtyHostAdoptHandler(fn: AdoptHandler): void {
  state().adopt = fn;
}

/**
 * Hash of the host code this server ships — what a host must report in
 * `hello` to be kept. Same algorithm as BUILD in bin/pty-host.mjs. Null when
 * the install dir is unknown (tests), which disables the check.
 */
function hostBuildId(): string | null {
  const root = process.env.COCKPIT_ROOT;
  if (!root) return null;
  try {
    return createHash('sha1').update(readFileSync(join(root, 'bin', 'pty-host.mjs'))).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/**
 * One connect attempt. Null when no host is listening — or when the one that
 * is runs different host code and `replaceOutdated` is set: it is shut down
 * (its sessions end with it, by design — no compatibility is kept across host
 * changes) and the caller launches the current one. Their bubbles come back
 * as interrupted, with the scrollback the previous server flushed on exit.
 */
function tryConnect(replaceOutdated = true): Promise<HostConnection | null> {
  return new Promise((resolve) => {
    const sock = connect(ptyHostSocketPath());
    const onError = () => resolve(null);
    sock.once('error', onError);
    sock.once('connect', async () => {
      sock.off('error', onError);
      const s = state();
      const conn = new HostConnection(sock, () => {
        if (s.conn === conn) s.conn = undefined;
      });
      let hello: HelloWire;
      try {
        hello = await conn.hello();
      } catch (e) {
        console.error(`[pty-host] handshake failed: ${(e as Error).message}`);
        conn.destroy();
        resolve(null);
        return;
      }
      const expected = hostBuildId();
      if (replaceOutdated && expected && hello.build !== expected) {
        console.log(`[pty-host] host runs build ${hello.build ?? 'unknown'}, expected ${expected}; replacing it (${hello.sessions?.length ?? 0} session(s) end)`);
        conn.shutdownHost();
        await conn.whenClosed();
        resolve(null);
        return;
      }
      s.conn = conn;
      const adopted: AdoptedHostSession[] = (hello.sessions ?? []).map((w) => {
        const base = { meta: w.meta, output: w.output, ...(w.exited ? { exitCode: w.exitCode ?? 0 } : {}) };
        const remote = w.kind === 'pipe' ? new RemotePipe(w.id, conn, w.pid) : new RemotePty(w.id, conn, w.pid);
        conn.sessions.set(w.id, remote);
        if (w.exited) remote.emitExit({ exitCode: w.exitCode ?? 0, signal: w.signal });
        return remote instanceof RemotePipe
          ? { ...base, kind: 'pipe' as const, handle: remote }
          : { ...base, kind: 'pty' as const, handle: remote };
      });
      if (adopted.length > 0) {
        console.log(`[pty-host] connected, adopting ${adopted.length} session(s)`);
      }
      // Awaited: callers of ensurePtyHostConnected() go on to decide which
      // history entries are orphaned, and must not race the persistence of
      // sessions that finished while we were down.
      try { await s.adopt?.(adopted); } catch (e) { console.error('[pty-host] adopt failed:', e); }
      resolve(conn);
    });
  });
}

function launchHost(): void {
  const root = process.env.COCKPIT_ROOT;
  if (!root) throw new Error('COCKPIT_ROOT is not set; cannot locate bin/pty-host.mjs');
  const dev = process.env.COCKPIT_ENV === 'dev';
  const child = spawn(
    process.execPath,
    [
      join(root, 'bin', 'pty-host.mjs'),
      '--launch',
      '--socket', ptyHostSocketPath(),
      '--dir', join(COCKPIT_DIR, 'pty-host', `v${PTY_HOST_PROTOCOL}`),
      '--title', dev ? 'cockpit-pty-dev' : 'cockpit-pty',
      '--log', join(COCKPIT_DIR, 'logs', 'pty-host.log'),
    ],
    { cwd: COCKPIT_DIR, detached: true, windowsHide: true, stdio: 'ignore' },
  );
  child.on('error', (e) => console.error(`[pty-host] launcher failed: ${e.message}`));
  child.unref();
}

/**
 * The live connection, if any. With `launch`, start a host when none is
 * listening and wait for it.
 */
async function getConnection(launch: boolean): Promise<HostConnection | null> {
  const s = state();
  if (s.conn) return s.conn;
  if (!s.connecting) s.connecting = tryConnect().finally(() => { s.connecting = undefined; });
  const existing = await s.connecting;
  if (existing || !launch) return existing;

  if (!s.launching) {
    s.launching = (async () => {
      console.log('[pty-host] no host running, launching one');
      launchHost();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, LAUNCH_POLL_MS));
        // Whatever answers now is the host we just launched; never replace it,
        // or a failed restage (which reruns the previous copy) would loop.
        const conn = s.conn ?? (await tryConnect(false));
        if (conn) return conn;
      }
      return null;
    })().finally(() => { s.launching = undefined; });
  }
  return s.launching;
}

async function requireConnection(): Promise<HostConnection> {
  const conn = await getConnection(true);
  if (!conn) {
    throw new Error(`PTY host did not start — see ${join(COCKPIT_DIR, 'logs', 'pty-host.log')}`);
  }
  return conn;
}

/** Spawn a PTY inside the host, launching the host if needed. */
export async function spawnPtyInHost(opts: PtySpawnOptions): Promise<PtyHandle> {
  const conn = await requireConnection();
  return conn.spawn('pty', new RemotePty(opts.id, conn, 0), opts);
}

/** Spawn a pipe-mode command inside the host, launching the host if needed. */
export async function spawnPipeInHost(opts: PipeSpawnOptions): Promise<PipeProcess> {
  const conn = await requireConnection();
  return conn.spawn('pipe', new RemotePipe(opts.id, conn, 0), opts);
}

/**
 * Connect to an already-running host (never launches one) so sessions from a
 * previous server are adopted. Memoized per process.
 */
const ADOPT_KEY = Symbol.for('cockpit_pty_host_adopted');
export function ensurePtyHostConnected(): Promise<void> {
  const g = globalThis as unknown as Record<symbol, Promise<void> | undefined>;
  return (g[ADOPT_KEY] ??= getConnection(false).then(
    () => undefined,
    () => undefined,
  ));
}

/**
 * `cockpit stop`: take the terminals down too. Update/restart deliberately do
 * not call this — surviving those is the reason the host exists.
 */
export function shutdownPtyHost(): void {
  state().conn?.shutdownHost();
}
