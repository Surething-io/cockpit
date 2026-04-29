import { query } from '@anthropic-ai/claude-agent-sdk';
import { NextRequest } from 'next/server';
import { updateGlobalState, getSessionTitle } from '@/lib/global-state';
import { resolveCommandPrompt } from '@/lib/chat/slashCommands';
import { DEEPSEEK_DIR, SETTINGS_FILE, readJsonFile } from '@/lib/paths';

// DeepSeek's Anthropic-compatible endpoint.
// See: https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';

const DEFAULT_MODEL = 'deepseek-v4-pro';
// Used by Claude Agent SDK for fast/small subtasks (title generation, compaction, etc.)
// DeepSeek server also maps unknown model names to v4-flash, but setting it explicitly
// avoids the fallback round-trip and keeps logs clean.
const SMALL_FAST_MODEL = 'deepseek-v4-flash';
const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

interface ImageData {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: {
        type: 'base64';
        media_type: ImageData['media_type'];
        data: string;
      };
    };

interface CockpitSettings {
  engines?: {
    deepseek?: {
      apiKey?: string;
      model?: string;
    };
  };
  [key: string]: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const { prompt: rawPrompt, sessionId, images, cwd, language, model: requestedModel } = await request.json();

    // Resolve built-in slash commands (/qa, /fx, etc.) based on language
    const prompt = typeof rawPrompt === 'string' ? resolveCommandPrompt(rawPrompt, language) : rawPrompt;

    // Allow sending images only (no text)
    const hasContent = (prompt && typeof prompt === 'string') || (images && images.length > 0);
    if (!hasContent) {
      return new Response(JSON.stringify({ error: 'Missing prompt or images' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Load Deepseek API key + model from ~/.cockpit/settings.json
    const settings = await readJsonFile<CockpitSettings>(SETTINGS_FILE, {});
    const apiKey = settings.engines?.deepseek?.apiKey?.trim();
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'Deepseek API key is not configured. Open the Deepseek picker in the chat header to set one.',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const savedModel = settings.engines?.deepseek?.model;
    const model = (typeof requestedModel === 'string' && ALLOWED_MODELS.has(requestedModel))
      ? requestedModel
      : (savedModel && ALLOWED_MODELS.has(savedModel))
        ? savedModel
        : DEFAULT_MODEL;

    // Build message content
    const content: ContentBlock[] = [];

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

    if (prompt && typeof prompt === 'string') {
      content.push({ type: 'text', text: prompt });
    }

    // Create streaming response
    const encoder = new TextEncoder();
    let isClosed = false;

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

        let actualSessionId = sessionId;
        const userMessage = typeof prompt === 'string' ? prompt : undefined;
        if (cwd && sessionId) {
          updateGlobalState(cwd, sessionId, 'loading', undefined, userMessage).catch(() => {});
        }

        try {
          const hasImages = images && images.length > 0;

          // Inject DeepSeek's Anthropic-compatible env vars + isolated config dir.
          // Claude Agent SDK reads these env vars to route the request to DeepSeek.
          // Refs:
          //   https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
          //   https://code.claude.com/docs/en/settings (env vars)
          //
          // IMPORTANT: We must *remove* ANTHROPIC_AUTH_TOKEN from the inherited env,
          // not just set it to ''. Some SDK code paths check "is variable defined"
          // rather than "is variable non-empty", and would still emit an empty
          // `Authorization: Bearer` header — which DeepSeek prefers over x-api-key,
          // resulting in a 401 even though our ANTHROPIC_API_KEY is correct.
          const {
            ANTHROPIC_AUTH_TOKEN: _droppedAuthToken,
            ANTHROPIC_API_KEY: _droppedApiKey,
            ...inheritedEnv
          } = process.env;
          void _droppedAuthToken; void _droppedApiKey;

          const deepseekEnv = {
            ...inheritedEnv,
            ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
            // DeepSeek docs explicitly use ANTHROPIC_API_KEY (sent as x-api-key header,
            // which their compat table marks as "Fully Supported").
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_SMALL_FAST_MODEL: SMALL_FAST_MODEL,
            CLAUDE_CONFIG_DIR: DEEPSEEK_DIR,
            // DeepSeek runs its own server-side prefix KV cache (auto-enabled,
            // see https://api-docs.deepseek.com/zh-cn/guides/kv_cache).
            // The Anthropic-style cache_control blocks the SDK injects are not
            // documented as supported and would only bloat the payload while
            // potentially perturbing the prefix that DeepSeek matches against.
            DISABLE_PROMPT_CACHING: '1',
            // Defensive: make sure we don't get hijacked into Bedrock/Vertex if the
            // user has those exported globally.
            CLAUDE_CODE_USE_BEDROCK: '0',
            CLAUDE_CODE_USE_VERTEX: '0',
            // Don't ship telemetry/error reports to Anthropic — this is DeepSeek traffic.
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          };

          const options = {
            ...(sessionId && { resume: sessionId }),
            ...(cwd && { cwd }),
            settingSources: ['user', 'project', 'local'],
            allowedTools: [
              'Read',
              'Write',
              'Edit',
              'Bash',
              'Glob',
              'Grep',
              'WebFetch',
              'WebSearch',
              'Task',
              'TodoWrite',
              'mcp__*',
            ],
            permissionMode: 'bypassPermissions' as const,
            allowDangerouslySkipPermissions: true,
            includePartialMessages: true,
            abortController: queryAbortController,
            env: deepseekEnv,
          };

          let response;
          if (hasImages) {
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
            response = query({
              prompt: prompt as string,
              options,
            });
          }

          const MAX_COMPACTION_RETRIES = 1;
          let currentResponse = response;

          for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
            let receivedResult = false;

            try {
              for await (const message of currentResponse) {
                if (isClosed) break;

                const msg = message as { type?: string; subtype?: string; session_id?: string };
                if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
                  actualSessionId = msg.session_id;
                  if (cwd) {
                    updateGlobalState(cwd, actualSessionId, 'loading', undefined, userMessage).catch(() => {});
                  }
                }

                if (msg.type === 'result') {
                  receivedResult = true;
                }

                const data = `data: ${JSON.stringify(message)}\n\n`;
                safeEnqueue(data);
              }
            } catch (streamError) {
              if (isClosed || queryAbortController.signal.aborted) break;
              throw streamError;
            }

            if (receivedResult || isClosed || queryAbortController.signal.aborted) break;

            const retryAbortController = new AbortController();
            queryAbortController.signal.addEventListener('abort', () => retryAbortController.abort(), { once: true });

            console.log(`[Deepseek] Stream ended without result message, resuming (attempt ${attempt + 1}/${MAX_COMPACTION_RETRIES})`);
            currentResponse = query({
              prompt: 'continue',
              options: {
                ...options,
                abortController: retryAbortController,
                resume: actualSessionId || sessionId,
              },
            });
          }

          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          if (cwd && actualSessionId) {
            const title = await getSessionTitle(cwd, actualSessionId);
            await updateGlobalState(cwd, actualSessionId, 'unread', title);
          }

          if (queryAbortController.signal.aborted) {
            console.log('Deepseek query aborted by user');
            safeClose();
            return;
          }
          console.error('Deepseek stream error:', error);
          safeEnqueue(`data: ${JSON.stringify({ type: 'error', error: String(error) })}\n\n`);
          safeClose();
        }
      },
      async cancel() {
        isClosed = true;
        queryAbortController.abort();
        const actualSessionId = sessionId;
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
    console.error('Deepseek API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
