import { query } from '@anthropic-ai/claude-agent-sdk';
import { NextRequest } from 'next/server';
import { updateGlobalState, getSessionTitle } from '@/lib/global-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, sessionId, images, cwd } = await request.json();

    // 允许仅发送图片（无文本）
    const hasContent = (prompt && typeof prompt === 'string') || (images && images.length > 0);
    if (!hasContent) {
      return new Response(JSON.stringify({ error: 'Missing prompt or images' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 构建消息内容
    const content: ContentBlock[] = [];

    // 添加图片（图片在文本前面，这样 Claude 先看到图片）
    if (images && Array.isArray(images)) {
      for (const img of images as ImageData[]) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
    }

    // 添加文本
    if (prompt && typeof prompt === 'string') {
      content.push({ type: 'text', text: prompt });
    }

    // 创建流式响应
    const encoder = new TextEncoder();
    let isClosed = false;

    // 创建 AbortController 用于取消 query
    const queryAbortController = new AbortController();

    const stream = new ReadableStream({
      async start(controller) {
        const safeEnqueue = (data: string) => {
          if (!isClosed) {
            try {
              controller.enqueue(encoder.encode(data));
            } catch {
              isClosed = true;
            }
          }
        };

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch {
              // ignore
            }
          }
        };

        // 用于跟踪实际的 sessionId（可能从流中获取）
        let actualSessionId = sessionId;

        try {
          // 根据是否有图片决定使用哪种方式调用 SDK
          const hasImages = images && images.length > 0;

          // 通用 options
          const options = {
            // 如果有 sessionId，则恢复会话
            ...(sessionId && { resume: sessionId }),
            // 如果有 cwd，设置工作目录
            ...(cwd && { cwd }),
            // 加载用户和项目级别的设置
            settingSources: ['user', 'project', 'local'],
            // 允许的工具 - 包括所有 MCP 工具
            allowedTools: [
              'Read',
              'Write',
              'Edit',
              'Bash',
              'Glob',
              'Grep',
              'WebFetch',
              'WebSearch',
              'Task',      // 子代理执行复杂任务
              'TodoWrite', // 任务管理
              'mcp__*',    // 允许所有 MCP 工具
            ],
            // 权限模式：跳过所有权限检查
            permissionMode: 'bypassPermissions' as const,
            // 允许跳过权限检查（必须与 bypassPermissions 一起使用）
            allowDangerouslySkipPermissions: true,
            // 启用流式文本块
            includePartialMessages: true,
            // 启用 1M token 上下文窗口（beta）- 解决 "Prompt is too long" 问题
            betas: ['context-1m-2025-08-07'],
            // 传入 abortController，用于取消 query
            abortController: queryAbortController,
          };

          let response;
          if (hasImages) {
            // 使用 AsyncIterable 方式传递包含图片的消息
            const messages = (async function* () {
              yield {
                type: 'user' as const,
                message: {
                  role: 'user' as const,
                  content,
                },
                parent_tool_use_id: null,
                session_id: sessionId || `session-${Date.now()}`,
              };
            })();

            response = query({
              prompt: messages,
              options,
            });
          } else {
            // 纯文本消息
            response = query({
              prompt: prompt as string,
              options,
            });
          }

          for await (const message of response) {
            // 检查是否已被取消
            if (isClosed) {
              break;
            }

            // 捕获 sessionId（从 system init 事件）并更新全局状态
            const msg = message as { type?: string; subtype?: string; session_id?: string };
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
              actualSessionId = msg.session_id;
              // 统一在这里标记开始加载（新会话和恢复会话都走这里）
              if (cwd) {
                updateGlobalState(cwd, actualSessionId, true).catch(() => {});
              }
            }

            // 发送 SSE 格式的数据
            const data = `data: ${JSON.stringify(message)}\n\n`;
            safeEnqueue(data);
          }

          // 更新全局状态：结束加载（获取标题）
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, false, title);
          }

          // 发送结束标记
          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          // 更新全局状态：结束加载（出错或取消）
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, false, title);
          }

          // 如果是取消导致的错误，静默处理
          if (queryAbortController.signal.aborted) {
            console.log('Query aborted by user');
            safeClose();
            return;
          }
          console.error('Stream error:', error);
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
          safeClose();
        }
      },
      async cancel() {
        isClosed = true;
        // 取消 query 执行
        queryAbortController.abort();
        // 更新全局状态：结束加载（用户取消）
        const actualSessionId = sessionId; // cancel 时使用传入的 sessionId
        if (cwd && actualSessionId) {
          const title = await getSessionTitle(cwd, actualSessionId);
          await updateGlobalState(cwd, actualSessionId, false, title);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
