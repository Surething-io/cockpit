import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SpawnEnv } from '@cockpit/shared-utils';
import { resolveGrokBinary } from './binary';

export type AcpObject = Record<string, unknown>;
export const object = (value: unknown): AcpObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpObject : {};

export interface AcpNotification { method: string; params: AcpObject }
export interface GrokAcpOptions {
  binary?: string;
  args?: string[];
  cwd: string;
  env: SpawnEnv;
  onNotification: (notification: AcpNotification) => void;
  onRequest: (method: string, params: AcpObject) => AcpObject;
  onClosed: (error: Error) => void;
}

export class GrokRpcError extends Error {
  constructor(message: string, readonly code?: number) { super(message); }
}

/** Subprocess IPC gateway; resource ownership belongs to the scoped Effect runner. */
export class GrokAcpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: AcpObject) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private failure: Error | undefined;
  readonly exited: Promise<void>;

  constructor(private readonly options: GrokAcpOptions) {
    this.child = spawn(options.binary ?? resolveGrokBinary(), options.args ?? ['--no-auto-update', 'agent', '--always-approve', 'stdio'], {
      cwd: options.cwd, env: options.env, stdio: 'pipe', detached: process.platform !== 'win32',
    });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve());
      this.child.once('error', () => resolve());
    });
    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    const stderr = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    let diagnostic = '';
    stderr.on('line', (line: string) => { diagnostic = `${diagnostic}\n${line}`.slice(-4096); });
    stdout.on('line', (line: string) => {
      try { this.receive(JSON.parse(line)); }
      catch (cause) {
        this.fail(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    this.child.on('error', (error) => this.fail(new Error(`Cannot start Grok CLI. Check the configured CLI path or reinstall Cockpit. ${error.message}`)));
    this.child.on('exit', (code, signal) => {
      stdout.close(); stderr.close();
      this.fail(new Error(`Grok CLI exited (${signal ?? code}).${diagnostic}`));
    });
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) pipe.on('error', (error: Error) => this.fail(error));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.options.onClosed(error);
  }

  private write(message: AcpObject): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private receive(value: unknown): void {
    const message = object(value);
    if (message.jsonrpc !== '2.0') throw new Error('Invalid Grok ACP JSON-RPC frame');
    if (typeof message.method === 'string') {
      const params = object(message.params);
      if (typeof message.id === 'string' || typeof message.id === 'number') {
        try {
          this.write({ id: message.id, result: this.options.onRequest(message.method, params) });
        } catch (cause) {
          this.write({ id: message.id, error: { code: -32601, message: String(cause) } });
        }
      } else this.options.onNotification({ method: message.method, params });
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      const error = object(message.error);
      pending.reject(new GrokRpcError(String(error.message ?? 'Grok ACP request failed'), typeof error.code === 'number' ? error.code : undefined));
    } else pending.resolve(object(message.result));
  }

  request(method: string, params: AcpObject): Promise<AcpObject> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); }
      catch (cause) { this.pending.delete(id); reject(cause); }
    });
  }

  notify(method: string, params: AcpObject): void { this.write({ method, params }); }

  dispose(force = false): void {
    this.fail(new Error('Grok ACP connection closed'));
    if (!this.child.pid) return;
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' });
        killer.on('error', () => this.child.kill());
      } else process.kill(-this.child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch { /* The process group has already exited. */ }
  }
}
