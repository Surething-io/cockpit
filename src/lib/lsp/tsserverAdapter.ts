// ============================================
// tsserver Adapter
// tsserver 使用自有协议（非标准 LSP），封装为统一接口
//
// 协议格式：
//   请求 → stdin: JSON + 换行
//   响应 ← stdout: Content-Length: N\r\n\r\n{JSON}
// ============================================

import { spawn, execSync, type ChildProcess } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, join } from 'path';
import type { LanguageServerAdapter, Location, HoverInfo } from './types';

const REQUEST_TIMEOUT = 10_000; // 10s (definition, references)
const HOVER_TIMEOUT = 3_000;   // 3s (hover 不需要太久，超时就不显示)
const COLD_START_TIMEOUT = 30_000; // 30s (新启动时等项目加载)

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
  private coldStart = true; // 新启动，项目尚未加载完成

  /** 启动 tsserver 进程 */
  spawn(): ChildProcess {
    const tsserverPath = this.findTsserver();
    console.log(`[tsserver] spawning: node ${tsserverPath}`);

    const setTitleScript = resolve(process.cwd(), 'src/lib/lsp/set-title.js');
    // 用 --require 预加载 set-title.js 设置进程名，不影响 tsserver 主模块加载
    const child = spawn('node', ['--require', setTitleScript, tsserverPath, '--disableAutomaticTypingAcquisition'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TSS_LOG: '', // 禁用日志文件
      },
    });

    child.stdout!.on('data', (data: Buffer) => this.onData(data));

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (data: string) => {
      console.log(`[tsserver stderr] ${data.trim()}`);
    });

    // 处理 stdin 写入错误（EPIPE），避免 uncaught exception
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

  /** 通知 tsserver 打开文件 */
  openFile(filePath: string, content: string): void {
    const absPath = resolve(filePath);
    if (this.openedFiles.has(absPath)) {
      // 已打开，发 reload 更新内容
      this.sendRequest('reload', { file: absPath, tmpfile: absPath });
      return;
    }
    this.openedFiles.add(absPath);
    this.sendRequest('open', { file: absPath, fileContent: content });
  }

  /** 通知 tsserver 关闭文件 */
  closeFile(filePath: string): void {
    const absPath = resolve(filePath);
    if (!this.openedFiles.has(absPath)) return;
    this.openedFiles.delete(absPath);
    this.sendRequest('close', { file: absPath });
  }

  /** 跳转定义 */
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

  /** 悬浮类型信息 */
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

  /** 引用查找 */
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

  /** 优雅关闭 */
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

    // 给 tsserver 1s 时间优雅退出
    const proc = this.process;
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      }
    }, 1000);

    this.process = null;
  }

  // ============================================
  // 私有方法
  // ============================================

  /** 查找 tsserver.js 路径 */
  private findTsserver(): string {
    // 方法 1: 用 require.resolve 解析（适用于 Next.js 打包环境）
    try {
      const tsPath = require.resolve('typescript/lib/tsserver.js');
      if (existsSync(tsPath)) {
        console.log(`[tsserver] found via require.resolve: ${tsPath}`);
        return tsPath;
      }
    } catch {
      // ignore
    }

    // 方法 2: 用 process.cwd() 查找（适用于 dev 环境）
    const cwdPath = join(process.cwd(), 'node_modules/typescript/lib/tsserver.js');
    if (existsSync(cwdPath)) {
      console.log(`[tsserver] found via cwd: ${cwdPath}`);
      return cwdPath;
    }

    // 方法 3: 用 which 查找全局安装的 tsserver
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

  /** 确保文件已在 tsserver 中打开 */
  private async ensureFileOpen(absPath: string): Promise<void> {
    if (this.openedFiles.has(absPath)) return;
    try {
      const content = await readFile(absPath, 'utf-8');
      this.openFile(absPath, content);
    } catch {
      // 文件不可读，忽略
    }
  }

  /** 发送请求（不等响应，如 open/close） */
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

  /** 发送请求并等待响应 */
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

  /** 处理 tsserver stdout 数据（原始字节） */
  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.processBuffer();
  }

  /** 解析 Content-Length 协议（字节级操作，正确处理非 ASCII） */
  private processBuffer(): void {
    const SEPARATOR = Buffer.from('\r\n\r\n');
    const CL_PREFIX = Buffer.from('Content-Length:');

    while (true) {
      // 查找 header 结束位置
      const headerEnd = this.buffer.indexOf(SEPARATOR);
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // 不是 Content-Length 格式，跳到下一个
        const nextCL = this.buffer.indexOf(CL_PREFIX, headerEnd + 4);
        if (nextCL === -1) {
          this.buffer = Buffer.alloc(0);
          break;
        }
        this.buffer = this.buffer.subarray(nextCL);
        continue;
      }

      const contentLength = parseInt(match[1], 10); // 字节数
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // 字节不够，等待更多数据

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf-8');
      this.buffer = this.buffer.subarray(bodyEnd);

      try {
        const message = JSON.parse(body);
        this.handleMessage(message);
      } catch {
        // JSON 解析失败，忽略
      }
    }
  }

  /** 处理 tsserver 响应 */
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
    // type === 'event' 的消息（如 projectLoadingFinish）暂不处理
  }

  /** 拒绝所有 pending 请求 */
  private rejectAll(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /** 读取文件的指定行 */
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
