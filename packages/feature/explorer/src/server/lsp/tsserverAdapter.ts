// ============================================
// tsserver Adapter
// tsserver uses its own protocol (not standard LSP), wrapped as a unified interface.
//
// Protocol format:
//   request → stdin: JSON + newline
//   response ← stdout: Content-Length: N\r\n\r\n{JSON}
// ============================================

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import type { LanguageServerAdapter, Location, HoverInfo } from './types';

const REQUEST_TIMEOUT = 10_000; // 10s (definition, references)
const HOVER_TIMEOUT = 3_000;   // 3s (hover doesn't need long; skip display on timeout)
const COLD_START_TIMEOUT = 30_000; // 30s (wait for project to load on cold start)

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TSServerAdapter implements LanguageServerAdapter {
  readonly language = 'typescript';

  private process: ChildProcess | null = null;
  private seq = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private openedFiles = new Set<string>();
  private coldStart = true; // newly started; project not yet fully loaded

  /** Spawn the tsserver process */
  spawn(): ChildProcess {
    const tsserverPath = this.findTsserver();
    console.log(`[tsserver] spawning: node ${tsserverPath}`);

    const setTitleScript = resolve(process.cwd(), 'bin/set-title.js');
    // Preload set-title.js via --require to set the process name without affecting tsserver's main module loading
    const child = spawn('node', ['--require', setTitleScript, tsserverPath, '--disableAutomaticTypingAcquisition'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TSS_LOG: '', // disable log file
      },
    });

    child.stdout!.on('data', (data: Buffer) => this.onData(data));

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (data: string) => {
      console.log(`[tsserver stderr] ${data.trim()}`);
    });

    // Handle stdin write errors (EPIPE) to avoid uncaught exceptions
    child.stdin!.on('error', (err) => {
      console.error('[tsserver] stdin error:', err.message);
    });

    child.on('error', (err) => {
      console.error('[tsserver] process error:', err);
      this.rejectAll(new Error('tsserver process error'));
    });

    child.on('exit', (code) => {
      console.log(`[tsserver] exited with code ${code}`);
      this.rejectAll(new Error(`tsserver exited with code ${code}`));
      this.process = null;
    });

    this.process = child;
    return child;
  }

  /** Notify tsserver that a file was opened */
  openFile(filePath: string, content: string): void {
    const absPath = resolve(filePath);
    if (this.openedFiles.has(absPath)) {
      // Already open — send reload to update content
      this.sendRequest('reload', { file: absPath, tmpfile: absPath });
      return;
    }
    this.openedFiles.add(absPath);
    this.sendRequest('open', { file: absPath, fileContent: content });
  }

  /** Notify tsserver that a file was closed */
  closeFile(filePath: string): void {
    const absPath = resolve(filePath);
    if (!this.openedFiles.has(absPath)) return;
    this.openedFiles.delete(absPath);
    this.sendRequest('close', { file: absPath });
  }

  /** Go to definition */
  async definition(filePath: string, line: number, column: number): Promise<Location[]> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    const response = await this.sendRequestWithResponse('definition', {
      file: absPath,
      line,
      offset: column,
    });

    if (!response?.body || !Array.isArray(response.body)) return [];

    return Promise.all(response.body.map(async (def: { file: string; start: { line: number; offset: number } }) => {
      const lineText = await this.readLineFromFile(def.file, def.start.line);
      return {
        file: def.file,
        line: def.start.line,
        column: def.start.offset,
        lineText,
      };
    }));
  }

  /** Hover type info */
  async hover(filePath: string, line: number, column: number): Promise<HoverInfo | null> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    let response;
    try {
      response = await this.sendRequestWithResponse('quickinfo', {
        file: absPath,
        line,
        offset: column,
      }, this.coldStart ? COLD_START_TIMEOUT : HOVER_TIMEOUT);
    } catch {
      return null;
    }

    if (!response?.body) return null;


    const body = response.body;
    return {
      displayString: body.displayString || '',
      documentation: body.documentation || '',
      kind: body.kind || '',
    };
  }

  /** Find references */
  async references(filePath: string, line: number, column: number): Promise<Location[]> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    const response = await this.sendRequestWithResponse('references', {
      file: absPath,
      line,
      offset: column,
    });

    if (!response?.body?.refs || !Array.isArray(response.body.refs)) return [];

    return response.body.refs.map((ref: { file: string; start: { line: number; offset: number }; lineText: string }) => ({
      file: ref.file,
      line: ref.start.line,
      column: ref.start.offset,
      lineText: ref.lineText || '',
    }));
  }

  /** Graceful shutdown */
  shutdown(): void {
    if (!this.process) return;
    console.log('[tsserver] shutting down');
    this.rejectAll(new Error('tsserver shutting down'));
    this.openedFiles.clear();

    try {
      this.sendRequest('exit', {});
    } catch {
      // ignore
    }

    // Give tsserver 1s to exit gracefully
    const proc = this.process;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      }
    }, 1000);

    this.process = null;
  }

  // ============================================
  // Private methods
  // ============================================

  /** Locate the tsserver.js path */
  private findTsserver(): string {
    // Method 1: resolve via require.resolve (works in Next.js bundled environments)
    try {
      const tsPath = require.resolve('typescript/lib/tsserver.js');
      if (existsSync(tsPath)) {
        console.log(`[tsserver] found via require.resolve: ${tsPath}`);
        return tsPath;
      }
    } catch {
      // ignore
    }

    // Method 2: search relative to process.cwd() (works in dev environments)
    const cwdPath = join(process.cwd(), 'node_modules/typescript/lib/tsserver.js');
    if (existsSync(cwdPath)) {
      console.log(`[tsserver] found via cwd: ${cwdPath}`);
      return cwdPath;
    }

    // Method 3: use which to find a globally installed tsserver
    try {
      const globalPath = execSync('which tsserver', { encoding: 'utf-8' }).trim();
      if (globalPath) {
        console.log(`[tsserver] found via which: ${globalPath}`);
        return globalPath;
      }
    } catch {
      // ignore
    }

    // fallback
    console.warn('[tsserver] using fallback path');
    return 'node_modules/typescript/lib/tsserver.js';
  }

  /** Ensure a file is open in tsserver */
  private async ensureFileOpen(absPath: string): Promise<void> {
    if (this.openedFiles.has(absPath)) return;
    try {
      const content = await readFile(absPath, 'utf-8');
      this.openFile(absPath, content);
    } catch {
      // File not readable; ignore
    }
  }

  /** Send a request without waiting for a response (e.g. open/close) */
  private sendRequest(command: string, args: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;

    this.seq++;
    const request = JSON.stringify({
      seq: this.seq,
      type: 'request',
      command,
      arguments: args,
    });

    try {
      this.process.stdin.write(request + '\n');
    } catch (err) {
      console.error(`[tsserver] write error for ${command}:`, err);
    }
  }

  /** Send a request and wait for the response */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sendRequestWithResponse(command: string, args: Record<string, unknown>, timeout = REQUEST_TIMEOUT): Promise<{ body: any; success: boolean }> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('tsserver not running'));
        return;
      }

      this.seq++;
      const seq = this.seq;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(seq);
        reject(new Error(`tsserver request timeout: ${command}`));
      }, timeout);

      this.pendingRequests.set(seq, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const request = JSON.stringify({
        seq,
        type: 'request',
        command,
        arguments: args,
      });

      try {
        this.process.stdin.write(request + '\n');
      } catch (err) {
        this.pendingRequests.delete(seq);
        clearTimeout(timer);
        reject(new Error(`tsserver write error: ${err}`));
      }
    });
  }

  /** Handle tsserver stdout data (raw bytes) */
  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.processBuffer();
  }

  /** Parse Content-Length framing (byte-level, handles non-ASCII correctly) */
  private processBuffer(): void {
    const SEPARATOR = Buffer.from('\r\n\r\n');
    const CL_PREFIX = Buffer.from('Content-Length:');

    while (true) {
      // Find header end position
      const headerEnd = this.buffer.indexOf(SEPARATOR);
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Not Content-Length format; skip to next
        const nextCL = this.buffer.indexOf(CL_PREFIX, headerEnd + 4);
        if (nextCL === -1) {
          this.buffer = Buffer.alloc(0);
          break;
        }
        this.buffer = this.buffer.subarray(nextCL);
        continue;
      }

      const contentLength = parseInt(match[1], 10); // byte count
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // not enough bytes yet; wait for more data

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf-8');
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // JSON parse failed; ignore
      }
    }
  }

  /** Handle a tsserver response */
  private handleMessage(message: { type: string; request_seq?: number; command?: string; body?: unknown; success?: boolean }): void {
    if (message.type === 'response' && message.request_seq !== undefined) {
      const pending = this.pendingRequests.get(message.request_seq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.request_seq);

        if (message.success === false) {
          pending.reject(new Error(`tsserver error: ${message.command}`));
        } else {
          if (this.coldStart) {
            this.coldStart = false;
            console.log('[tsserver] project loaded, switching to fast timeout');
          }
          pending.resolve(message);
        }
      }
    }
    // type === 'event' messages (e.g. projectLoadingFinish) are not handled for now
  }

  /** Reject all pending requests */
  private rejectAll(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /** Read a specific line from a file */
  private async readLineFromFile(filePath: string, lineNum: number): Promise<string> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      return lines[lineNum - 1]?.trim() || '';
    } catch {
      return '';
    }
  }
}
