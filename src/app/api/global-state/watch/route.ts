import { NextRequest } from 'next/server';
import { watch, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { GLOBAL_STATE_FILE, readJsonFile } from '@/lib/paths';
import { getLastUserMessage } from '@/lib/global-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

/**
 * GET /api/global-state/watch
 *
 * SSE 端点：监听 ~/.cockpit/state.json 变化并推送给前端
 * 替代 ProjectSidebar 的 1s 轮询
 */
export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();

  // 确保目录和文件存在
  const dir = dirname(GLOBAL_STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const stream = new ReadableStream({
    start(controller) {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      const sendState = async () => {
        if (closed) return;
        try {
          const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
          state.sessions.sort((a, b) => b.lastActive - a.lastActive);
          const recentSessions = state.sessions.slice(0, 15);

          // 为每个 session 获取最后一条用户消息
          const sessionsWithLastMessage = await Promise.all(
            recentSessions.map(async (session) => {
              const lastUserMessage = await getLastUserMessage(session.cwd, session.sessionId);
              return { ...session, lastUserMessage };
            })
          );

          if (closed) return;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ sessions: sessionsWithLastMessage })}\n\n`)
          );
        } catch (err) {
          if (!closed) console.error('Global state watch error:', err);
        }
      };

      // 立即推送一次当前状态
      sendState();

      // 监听 state.json 变化
      let watcher: ReturnType<typeof watch> | null = null;
      try {
        watcher = watch(GLOBAL_STATE_FILE, () => {
          // debounce 200ms，合并短时间内的多次写入
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(sendState, 200);
        });

        watcher.on('error', (error) => {
          console.error('Global state file watcher error:', error);
        });
      } catch {
        // 文件可能不存在，用 watch 监听目录
        try {
          watcher = watch(dir, (_, filename) => {
            if (filename === 'state.json') {
              if (debounceTimer) clearTimeout(debounceTimer);
              debounceTimer = setTimeout(sendState, 200);
            }
          });
        } catch (err) {
          console.error('Global state dir watcher error:', err);
        }
      }

      // 心跳保活（30s）
      const heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // controller 已关闭
        }
      }, 30000);

      // 客户端断开时清理
      request.signal.addEventListener('abort', () => {
        closed = true;
        if (watcher) watcher.close();
        if (debounceTimer) clearTimeout(debounceTimer);
        clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
