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

    // Allow sending images only (no text)
    const hasContent = (prompt && typeof prompt === 'string') || (images && images.length > 0);
    if (!hasContent) {
      return new Response(JSON.stringify({ error: 'Missing prompt or images' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build message content
    const content: ContentBlock[] = [];

    // Add images first (so Claude sees images before text)
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

    // Add text
    if (prompt && typeof prompt === 'string') {
      content.push({ type: 'text', text: prompt });
    }

    // Create streaming response
    const encoder = new TextEncoder();
    let isClosed = false;

    // Create AbortController for cancelling query
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

        // Track the actual sessionId (may be obtained from the stream)
        let actualSessionId = sessionId;

        // Immediately mark as loading, also pass user message (avoid reading stale messages before transcript is written)
        const userMessage = typeof prompt === 'string' ? prompt : undefined;
        if (cwd && sessionId) {
          updateGlobalState(cwd, sessionId, 'loading', undefined, userMessage).catch(() => {});
        }

        try {
          // Choose SDK call method based on whether images are present
          const hasImages = images && images.length > 0;

          // Common options
          const options = {
            // Resume session if sessionId is provided
            ...(sessionId && { resume: sessionId }),
            // Set working directory if cwd is provided
            ...(cwd && { cwd }),
            // Load user and project level settings
            settingSources: ['user', 'project', 'local'],
            // Allowed tools - includes all MCP tools
            allowedTools: [
              'Read',
              'Write',
              'Edit',
              'Bash',
              'Glob',
              'Grep',
              'WebFetch',
              'WebSearch',
              'Task',      // Sub-agent for complex tasks
              'TodoWrite', // Task management
              'mcp__*',    // Allow all MCP tools
            ],
            // Permission mode: skip all permission checks
            permissionMode: 'bypassPermissions' as const,
            // Allow skipping permission checks (must be used with bypassPermissions)
            allowDangerouslySkipPermissions: true,
            // Enable streaming text blocks
            includePartialMessages: true,
            // Enable 1M token context window (beta) - resolves "Prompt is too long"
            // betas: ['context-1m-2025-08-07'],
            // Pass abortController for cancelling query
            abortController: queryAbortController,
          };

          let response;
          if (hasImages) {
            // Use AsyncIterable to pass messages containing images
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
            // Plain text message
            response = query({
              prompt: prompt as string,
              options,
            });
          }

          for await (const message of response) {
            // Check if already cancelled
            if (isClosed) {
              break;
            }

            // Capture sessionId (from system init event) and update global state
            const msg = message as { type?: string; subtype?: string; session_id?: string };
            if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
              actualSessionId = msg.session_id;
              // Mark loading start here for both new and resumed sessions
              if (cwd) {
                updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
              }
            }

            // Send SSE-formatted data
            const data = `data: ${JSON.stringify(message)}\n\n`;
            safeEnqueue(data);
          }

          // Update global state: end loading (fetch title)
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          // Send end marker
          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          // Update global state: end loading (on error or cancel)
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          // If error was caused by cancellation, handle silently
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
        // Cancel query execution
        queryAbortController.abort();
        // Update global state: end loading (user cancelled)
        const actualSessionId = sessionId; // Use the passed-in sessionId on cancel
        if (cwd && actualSessionId) {
          const title = await getSessionTitle(cwd, actualSessionId);
          await updateGlobalState(cwd, actualSessionId, 'unread', title);
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
