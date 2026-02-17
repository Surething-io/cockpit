import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import { registerCommand, appendCommandOutput, finalizeCommand } from '@/lib/terminal/RunningCommandRegistry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/terminal/execute
 *
 * Per-command SSE：每个命令独立返回一个 SSE stream。
 * 命令结束（exit/error）后 stream 自动关闭。
 *
 * 事件类型：
 *   { type: 'pid', pid: number }
 *   { type: 'stdout', data: string }
 *   { type: 'stderr', data: string }
 *   { type: 'exit', code: number }
 *   { type: 'error', error: string }
 */
export async function POST(request: NextRequest) {
  let body: {
    cwd: string;
    command: string;
    commandId: string;
    tabId: string;
    projectCwd: string;
    env?: Record<string, string>;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { cwd, command, commandId, tabId, projectCwd, env } = body;

  if (!cwd || !command || !commandId || !tabId || !projectCwd) {
    return new Response(JSON.stringify({ error: 'Missing required parameters' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 不继承 process.env（Next.js dev server 会污染 TURBOPACK、NODE_ENV 等）
  // login shell（--login）会从 ~/.zshrc / ~/.bash_profile 加载用户完整环境
  // 这里只传 shell 启动所需的最小变量 + 颜色控制
  const childEnv: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    USER: process.env.USER,
    SHELL: process.env.SHELL,
    TERM: 'xterm-256color',
    FORCE_COLOR: '1',
    CLICOLOR: '1',
    CLICOLOR_FORCE: '1',
    PYTHONUNBUFFERED: '1',
    npm_config_color: 'always',
    ...env,
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (msg: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
        } catch {
          // controller 已关闭
        }
      };

      try {
        const userShell = process.env.SHELL || '/bin/bash';
        const child = spawn(userShell, ['--login', '-c', command], {
          cwd,
          env: childEnv as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        if (child.pid) {
          registerCommand({
            commandId,
            command,
            cwd,
            projectCwd,
            tabId,
            pid: child.pid,
            process: child,
            timestamp: new Date().toISOString(),
          });
          send({ type: 'pid', pid: child.pid });
        }

        child.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          appendCommandOutput(commandId, text);
          send({ type: 'stdout', data: text });
        });

        child.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          appendCommandOutput(commandId, text);
          send({ type: 'stderr', data: text });
        });

        child.on('close', async (code: number | null) => {
          const exitCode = code ?? 0;
          send({ type: 'exit', code: exitCode });
          // 写入 JSONL 历史
          try {
            await finalizeCommand(commandId, exitCode);
          } catch (e) {
            console.error('[execute] Failed to finalize:', e);
          }
          try { controller.close(); } catch { /* already closed */ }
        });

        child.on('error', async (error: Error) => {
          send({ type: 'error', error: error.message });
          try {
            await finalizeCommand(commandId, 1);
          } catch (e) {
            console.error('[execute] Failed to finalize:', e);
          }
          try { controller.close(); } catch { /* already closed */ }
        });

        // 前端断开连接（刷新/关闭页面）→ kill 子进程 + 保存历史
        request.signal.addEventListener('abort', async () => {
          // 先 finalize 保存当前缓冲的输出
          try {
            await finalizeCommand(commandId, 130); // 130 = SIGTERM 退出码
          } catch { /* ignore */ }
          // 再 kill 进程树
          if (child.pid) {
            try { process.kill(child.pid, 'SIGTERM'); } catch { /* already dead */ }
            setTimeout(() => {
              try { process.kill(child.pid!, 0); process.kill(child.pid!, 'SIGKILL'); } catch { /* gone */ }
            }, 3000);
          }
        });
      } catch (spawnError) {
        send({ type: 'error', error: (spawnError as Error).message });
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
