// 运行中命令注册表
// 使用 globalThis 确保 Turbopack 模块隔离下共享同一实例
// 职责：
// 1. 跟踪所有运行中的子进程（缓冲 stdout/stderr）
// 2. 子进程 exit 时写入 JSONL 历史文件

import { ChildProcess } from 'child_process';
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
  outputLines: string[];
  outputPartial: string;
  timestamp: string;
}

const GLOBAL_KEY = Symbol.for('terminal_running_commands');

type GlobalWithRegistry = typeof globalThis & {
  [key: symbol]: Map<string, RunningCommand> | undefined;
};

function getRegistry(): Map<string, RunningCommand> {
  const g = globalThis as GlobalWithRegistry;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, RunningCommand>();
  }
  return g[GLOBAL_KEY]!;
}

/**
 * 注册一个运行中的命令
 * 自动挂载 close/error 监听确保 finalizeCommand 一定执行
 */
export function registerCommand(cmd: Omit<RunningCommand, 'outputLines' | 'outputPartial'>): void {
  getRegistry().set(cmd.commandId, {
    ...cmd,
    outputLines: [],
    outputPartial: '',
  });

  // 永久挂载 close/error，保证进程退出时一定 finalize（不依赖 WS 连接）
  const child = cmd.process;
  child.on('close', async (code: number | null) => {
    try { await finalizeCommand(cmd.commandId, code ?? 0); } catch (e) { console.error('[registry] finalize error:', e); }
  });
  child.on('error', async () => {
    try { await finalizeCommand(cmd.commandId, 1); } catch (e) { console.error('[registry] finalize error:', e); }
  });
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
 * 命令结束时：写入 JSONL 历史，清理注册表
 */
export async function finalizeCommand(commandId: string, exitCode: number): Promise<void> {
  const registry = getRegistry();
  const cmd = registry.get(commandId);
  if (!cmd) return; // 幂等：已 finalize 过则跳过

  registry.delete(commandId);

  const output = getBufferedOutput(cmd);

  const entry: Record<string, unknown> = {
    id: cmd.commandId,
    command: cmd.command,
    output: '',
    exitCode,
    timestamp: cmd.timestamp,
    cwd: cmd.cwd,
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
