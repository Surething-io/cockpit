// ============================================
// Pyright Adapter
// Pyright uses the standard LSP protocol (JSON-RPC 2.0 over stdio)
//
// Protocol format:
//   request/response → Content-Length: N\r\n\r\n{JSON-RPC 2.0}
// ============================================

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import type { LanguageServerAdapter, Location, HoverInfo } from './types';

const REQUEST_TIMEOUT = 10_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PyrightAdapter implements LanguageServerAdapter {
  readonly language = 'python';

  private process: ChildProcess | null = null;
  private seq = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private buffer = '';
  private openedFiles = new Set<string>();
  private initialized = false;

  /** Check whether pyright-langserver is available */
  static isAvailable(): boolean {
    try {
      execSync('which pyright-langserver', { stdio: 'ignore' });
      return true;
    } catch {
      // Try basedpyright
      try {
        execSync('which basedpyright-langserver', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Get the available command name */
  private static getCommand(): string {
    try {
      execSync('which pyright-langserver', { stdio: 'ignore' });
      return 'pyright-langserver';
    } catch {
      return 'basedpyright-langserver';
    }
  }

  /** Spawn the pyright process */
  spawn(): ChildProcess {
    const command = PyrightAdapter.getCommand();
    console.log(`[pyright] spawning: ${command} --stdio`);

    const child = spawn(command, ['--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (data: string) => this.onData(data));
    child.stderr!.on('data', () => {
      // pyright stderr log; ignore
    });

    child.on('error', (err) => {
      console.error('[pyright] process error:', err);
      this.rejectAll(new Error('pyright process error'));
    });

    child.on('exit', (code) => {
      console.log(`[pyright] exited with code ${code}`);
      this.rejectAll(new Error(`pyright exited with code ${code}`));
    });

    this.process = child;
    return child;
  }

  /** LSP initialize handshake */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const response = await this.sendLSPRequest('initialize', {
      processId: process.pid,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['plaintext'] },
          definition: {},
          references: {},
        },
      },
      rootUri: null,
    });

    if (response) {
      // Send the initialized notification
      this.sendLSPNotification('initialized', {});
      this.initialized = true;
      console.log('[pyright] initialized');
    }
  }

  /** Notify pyright that a file was opened */
  openFile(filePath: string, content: string): void {
    const absPath = resolve(filePath);
    const uri = pathToFileURL(absPath).href;

    if (this.openedFiles.has(absPath)) {
      // Already open — send didChange
      this.sendLSPNotification('textDocument/didChange', {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text: content }],
      });
      return;
    }

    this.openedFiles.add(absPath);
    this.sendLSPNotification('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: 'python',
        version: 1,
        text: content,
      },
    });
  }

  /** Notify pyright that a file was closed */
  closeFile(filePath: string): void {
    const absPath = resolve(filePath);
    if (!this.openedFiles.has(absPath)) return;
    this.openedFiles.delete(absPath);

    const uri = pathToFileURL(absPath).href;
    this.sendLSPNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  /** Go to definition */
  async definition(filePath: string, line: number, column: number): Promise<Location[]> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    const uri = pathToFileURL(absPath).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.sendLSPRequest('textDocument/definition', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 }, // LSP is 0-based
    });

    if (!response) return [];

    const results = Array.isArray(response) ? response : [response];
    return Promise.all(results.map(async (loc: { uri: string; range: { start: { line: number; character: number } } }) => {
      const file = new URL(loc.uri).pathname;
      const lineNum = loc.range.start.line + 1;
      const lineText = await this.readLineFromFile(file, lineNum);
      return {
        file,
        line: lineNum,
        column: loc.range.start.character + 1,
        lineText,
      };
    }));
  }

  /** Hover type info */
  async hover(filePath: string, line: number, column: number): Promise<HoverInfo | null> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    const uri = pathToFileURL(absPath).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.sendLSPRequest('textDocument/hover', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    });

    if (!response?.contents) return null;

    const contents = response.contents;
    let displayString = '';

    if (typeof contents === 'string') {
      displayString = contents;
    } else if (contents.value) {
      displayString = contents.value;
    } else if (Array.isArray(contents)) {
      displayString = contents.map((c: string | { value: string }) =>
        typeof c === 'string' ? c : c.value
      ).join('\n');
    }

    return {
      displayString,
      documentation: '',
      kind: '',
    };
  }

  /** Find references */
  async references(filePath: string, line: number, column: number): Promise<Location[]> {
    const absPath = resolve(filePath);
    await this.ensureFileOpen(absPath);

    const uri = pathToFileURL(absPath).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await this.sendLSPRequest('textDocument/references', {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
      context: { includeDeclaration: true },
    });

    if (!Array.isArray(response)) return [];

    return Promise.all(response.map(async (ref: { uri: string; range: { start: { line: number; character: number } } }) => {
      const file = new URL(ref.uri).pathname;
      const lineNum = ref.range.start.line + 1;
      const lineText = await this.readLineFromFile(file, lineNum);
      return {
        file,
        line: lineNum,
        column: ref.range.start.character + 1,
        lineText,
      };
    }));
  }

  /** Graceful shutdown */
  shutdown(): void {
    if (!this.process) return;
    console.log('[pyright] shutting down');
    this.rejectAll(new Error('pyright shutting down'));
    this.openedFiles.clear();

    try {
      this.sendLSPRequest('shutdown', {}).then(() => {
        this.sendLSPNotification('exit', {});
      }).catch(() => {});
    } catch {
      // ignore
    }

    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill('SIGTERM');
      }
    }, 1000);

    this.process = null;
  }

  // ============================================
  // Private methods
  // ============================================

  private async ensureFileOpen(absPath: string): Promise<void> {
    if (this.openedFiles.has(absPath)) return;
    try {
      const content = await readFile(absPath, 'utf-8');
      this.openFile(absPath, content);
    } catch {
      // ignore
    }
  }

  /** Send a JSON-RPC request (waits for a response) */
  private sendLSPRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('pyright not running'));
        return;
      }

      this.seq++;
      const id = this.seq;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`pyright request timeout: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
      this.process.stdin.write(header + message);
    });
  }

  /** Send a JSON-RPC notification (no response expected) */
  private sendLSPNotification(method: string, params: unknown): void {
    if (!this.process?.stdin?.writable) return;

    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;
    this.process.stdin.write(header + message);
  }

  /** Handle stdout data */
  private onData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  /** Parse Content-Length framing */
  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // ignore
      }
    }
  }

  /** Handle a JSON-RPC response */
  private handleMessage(message: { id?: number; result?: unknown; error?: { message: string } }): void {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(message.id);

        if (message.error) {
          pending.reject(new Error(`pyright error: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    // Notification messages (no id) are not handled for now
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
