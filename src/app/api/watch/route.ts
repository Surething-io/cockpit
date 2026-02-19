import { NextRequest } from 'next/server';
import { fileWatcher, type FileEvent } from '@/lib/fileWatcher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/watch?cwd=...
 *
 * SSE 端点：监听文件系统变化并推送给前端
 *
 * 事件格式：
 *   data: [{ type: 'file'|'git' }, ...]
 *
 * 心跳：
 *   : heartbeat (每 30 秒)
 */
export async function GET(request: NextRequest) {
  const cwd = request.nextUrl.searchParams.get('cwd');

  if (!cwd) {
    return new Response(JSON.stringify({ error: 'Missing cwd parameter' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (events: FileEvent[]) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(events)}\n\n`));
        } catch {
          // controller 已关闭
        }
      };

      const sendHeartbeat = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // controller 已关闭
        }
      };

      // 订阅文件变更
      const unsubscribe = fileWatcher.subscribe(cwd, send);

      // 心跳保活（30s）
      const heartbeatTimer = setInterval(sendHeartbeat, 30000);

      // 客户端断开时清理
      request.signal.addEventListener('abort', () => {
        closed = true;
        unsubscribe();
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
