// 运行中命令注册表
// 使用 globalThis 确保 Turbopack 模块隔离下共享同一实例
// 职责：
// 1. 跟踪所有运行中的子进程（缓冲 stdout/stderr）
// 2. 子进程 exit 时写入 JSONL 历史文件

import { ChildProcess } from 'child_process';
import type { IPty } from 'node-pty';
import fs from 'fs/promises';
import { getTerminalHistoryPath, getTerminalOutputPath, ensureParentDir } from '@/lib/paths';

const MAX_OUTPUT_LINES = 5000;
const OUTPUT_FILE_THRESHOLD = 4096;
/** outputPartial 最大字节数，防止无换行的大输出（如 base64）堆满内存 */
const MAX_PARTIAL_BYTES = 64 * 1024; // 64KB

export interface RunningCommand {
  commandId: string;
  command: string;
  cwd: string;
  projectCwd: string;
  tabId: string;
  pid: number;
  process: ChildProcess;
  /** PTY 进程实例（PTY 模式下设置） */
  ptyProcess?: IPty;
  /** 是否使用 PTY 模式 */
  usePty?: boolean;
  outputLines: string[];
  outputPartial: string;
  timestamp: string;
}

const GLOBAL_KEY = Symbol.for('terminal_running_commands');
const SERVER_ID_KEY = Symbol.for('terminal_server_id');

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, RunningCommand> | string | undefined;
};

/** 服务启动唯一 ID，用于判断是否发生了重启 */
function getServerId(): string {
  const g = globalThis as GlobalWithRegistry;
  if (!g[SERVER_ID_KEY]) {
    g[SERVER_ID_KEY] = `srv_${Date.now()}_${process.pid}`;
    console.log(`[registry] server started, id=${g[SERVER_ID_KEY]}, pid=${process.pid}`);
  }
  return g[SERVER_ID_KEY] as string;
}

// 初始化时打印 server id
getServerId();

function getRegistry(): Map<string, RunningCommand> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, RunningCommand>();
  }
  return g[GLOBAL_KEY] as Map<string, RunningCommand>;
}

/**
 * 注册一个运行中的命令
 * 自动挂载 close/error 监听确保 finalizeCommand 一定执行
 */
export function registerCommand(cmd: Omit<RunningCommand, 'outputLines' | 'outputPartial'>): void {
  console.log(`[registry] register: id=${cmd.commandId}, cmd="${cmd.command}", pid=${cmd.pid}, pty=${!!cmd.ptyProcess}, server=${getServerId()}`);
  getRegistry().set(cmd.commandId, {
    ...cmd,
    outputLines: [],
    outputPartial: '',
  });

  if (cmd.ptyProcess) {
    // PTY 模式：单一 data 事件（stdout + stderr 混合，与真实终端一致）
    const pty = cmd.ptyProcess;

    pty.onData((data: string) => {
      appendCommandOutput(cmd.commandId, data);
    });

    const ptyPid = cmd.pid;
    pty.onExit(async ({ exitCode }) => {
      try { await finalizeCommand(cmd.commandId, exitCode, ptyPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
  } else {
    // Pipe 模式：分离的 stdout/stderr
    const child = cmd.process;

    child.stdout?.on('data', (data: Buffer) => {
      appendCommandOutput(cmd.commandId, data.toString());
    });
    child.stderr?.on('data', (data: Buffer) => {
      appendCommandOutput(cmd.commandId, data.toString());
    });

    const childPid = cmd.pid;
    child.on('close', async (code: number | null) => {
      try { await finalizeCommand(cmd.commandId, code ?? 0, childPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
    child.on('error', async () => {
      try { await finalizeCommand(cmd.commandId, 1, childPid); } catch (e) { console.error('[registry] finalize error:', e); }
    });
  }
}

/**
 * 追加输出到缓冲区（保留最多 MAX_OUTPUT_LINES 行）
 */
export function appendCommandOutput(commandId: string, data: string): void {
  const cmd = getRegistry().get(commandId);
  if (!cmd) return;

  const text = cmd.outputPartial + data;
  const parts = text.split('\n');
  cmd.outputPartial = parts.pop() || '';

  // 防止无换行的超大行（如 base64）堆满内存
  if (cmd.outputPartial.length > MAX_PARTIAL_BYTES) {
    cmd.outputPartial = cmd.outputPartial.slice(-MAX_PARTIAL_BYTES);
  }

  if (parts.length > 0) {
    cmd.outputLines.push(...parts);
    if (cmd.outputLines.length > MAX_OUTPUT_LINES) {
      // splice 原地删除，避免 slice 每次创建新数组对象造成 GC 压力
      cmd.outputLines.splice(0, cmd.outputLines.length - MAX_OUTPUT_LINES);
    }
  }
}

function getBufferedOutput(cmd: RunningCommand): string {
  const lines = cmd.outputLines.join('\n');
  if (cmd.outputPartial) {
    return lines ? lines + '\n' + cmd.outputPartial : cmd.outputPartial;
  }
  return lines;
}

/**
 * 查询某个项目下正在运行的命令
 */
export function getRunningCommands(projectCwd: string): Array<{
  commandId: string;
  command: string;
  cwd: string;
  tabId: string;
  pid: number;
  timestamp: string;
  usePty?: boolean;
}> {
  const results: ReturnType<typeof getRunningCommands> = [];
  for (const cmd of getRegistry().values()) {
    if (cmd.projectCwd === projectCwd) {
      results.push({
        commandId: cmd.commandId,
        command: cmd.command,
        cwd: cmd.cwd,
        tabId: cmd.tabId,
        pid: cmd.pid,
        timestamp: cmd.timestamp,
        ...(cmd.usePty ? { usePty: true } : {}),
      });
    }
  }
  return results;
}

/**
 * 获取单个命令（用于 attach）
 */
export function getRunningCommand(commandId: string): RunningCommand | undefined {
  return getRegistry().get(commandId);
}

/**
 * 诊断：注册表总大小
 */
export function getRegistrySize(): number {
  return getRegistry().size;
}

/**
 * 诊断：注册表中所有不同的 projectCwd
 */
export function getAllProjectCwds(): string[] {
  const cwds = new Set<string>();
  for (const cmd of getRegistry().values()) {
    cwds.add(cmd.projectCwd);
  }
  return [...cwds];
}

/**
 * 命令结束时：写入 JSONL 历史，清理注册表
 */
export async function finalizeCommand(commandId: string, exitCode: number, pid?: number): Promise<void> {
  const registry = getRegistry();
  const cmd = registry.get(commandId);
  if (!cmd) return; // 幂等：已 finalize 过则跳过
  // rerun 场景：旧进程的 onExit 不应删掉新进程的注册表条目
  if (pid !== undefined && cmd.pid !== pid) return;

  console.log(`[registry] finalize: id=${commandId}, exitCode=${exitCode}, cmd="${cmd.command}", server=${getServerId()}`);
  registry.delete(commandId);

  const output = getBufferedOutput(cmd);

  const entry: Record<string, unknown> = {
    id: cmd.commandId,
    command: cmd.command,
    output: '',
    exitCode,
    timestamp: cmd.timestamp,
    cwd: cmd.cwd,
    ...(cmd.usePty ? { usePty: true } : {}),
  };

  const historyPath = getTerminalHistoryPath(cmd.projectCwd, cmd.tabId);
  await ensureParentDir(historyPath);

  // 长输出存到独立文件
  if (output.length > OUTPUT_FILE_THRESHOLD) {
    const outputPath = getTerminalOutputPath(cmd.projectCwd, cmd.commandId);
    await fs.writeFile(outputPath, output, 'utf-8');
    entry.outputFile = outputPath;
  } else {
    entry.output = output;
  }

  // 读取现有历史
  let existingLines: string[] = [];
  try {
    const content = await fs.readFile(historyPath, 'utf-8');
    existingLines = content.trim().split('\n').filter(Boolean);
  } catch {
    // 文件不存在
  }

  // 幂等保护：检查是否已存在
  const alreadyExists = existingLines.some((line) => {
    try { return JSON.parse(line).id === commandId; } catch { return false; }
  });
  if (alreadyExists) return;

  // 限制最多 100 条
  if (existingLines.length >= 100) {
    const removedLines = existingLines.slice(0, existingLines.length - 99);
    for (const line of removedLines) {
      try {
        const old = JSON.parse(line);
        if (old.outputFile) await fs.unlink(old.outputFile).catch(() => {});
      } catch { /* ignore */ }
    }
    existingLines = existingLines.slice(-99);
  }

  existingLines.push(JSON.stringify(entry));
  await fs.writeFile(historyPath, existingLines.join('\n') + '\n', 'utf-8');
}
