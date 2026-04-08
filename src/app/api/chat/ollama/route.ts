import { streamText, stepCountIs } from 'ai';
import { NextRequest } from 'next/server';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { updateGlobalState } from '@/lib/global-state';
import { resolveCommandPrompt } from '@/lib/chat/slashCommands';
import { createOllamaModel } from './model';
import { readSessionMessages, writeSessionMessages } from './session';
import { createTools } from './tools';
import { consumeStream, emitAssistantMessage, emitResultMessage } from './stream';
import type { AgentContext, ChatRequestBody } from './types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_MODEL = 'qwen3.5:35b-a3b-coding-nvfp4';

function buildSystemPrompt(todos: AgentContext['todos']): string {
  let prompt = `You are a vibe coding agent. Your goal is to help the user build and modify software by any means necessary.

You have access to the local filesystem and shell. Use your tools freely.

Guidelines:
- Read files before you edit them.
- Use the Edit tool with exact oldString/newString matches.
- Use Bash to run commands, install dependencies, or verify changes.
- Use Glob and Grep to explore the codebase.
- Track your progress with TodoWrite when tasks have multiple steps.
- Prefer small, working increments over big refactors.
- If something is unclear, ask the user before making irreversible changes.

When you finish, briefly summarize what you did.`;

  if (todos.length > 0) {
    prompt += `\n\nCurrent todos:\n${todos.map(t => `- [${t.status}] ${t.content}`).join('\n')}`;
  }

  return prompt;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ChatRequestBody;
    const { prompt: rawPrompt, sessionId, cwd, model, language } = body;

    const prompt = typeof rawPrompt === 'string' ? resolveCommandPrompt(rawPrompt, language) : rawPrompt;
    if (!prompt || typeof prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const actualCwd = cwd || process.cwd();
    const actualSessionId = sessionId || `ollama-${Date.now()}`;
    const actualModel = model || DEFAULT_MODEL;

    const context: AgentContext = {
      cwd: actualCwd,
      todos: [],
    };

    let messages = readSessionMessages(actualCwd, actualSessionId);
    const userMessage: ModelMessage = { role: 'user', content: prompt };
    messages = [...messages, userMessage];

    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => abortController.abort());

    const ollamaModel = createOllamaModel(actualModel);
    const tools = createTools(context);

    const result = streamText({
      model: ollamaModel,
      system: buildSystemPrompt(context.todos),
      messages,
      tools,
      stopWhen: stepCountIs(64),
      temperature: 0.2,
      abortSignal: abortController.signal,
    });

    const encoder = new TextEncoder();
    let isClosed = false;

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
              /* ignore */
            }
          }
        };

        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'system',
            subtype: 'init',
            session_id: actualSessionId,
          })}\n\n`
        );

        if (actualCwd) {
          updateGlobalState(actualCwd, actualSessionId, 'loading', undefined, prompt.slice(0, 50)).catch(() => {});
        }

        try {
          const { text, toolCalls } = await consumeStream(
            result.fullStream as AsyncIterable<import('ai').TextStreamPart<Record<string, never>>>,
            safeEnqueue,
            actualSessionId
          );

          const response = await result.response;
          const usage = await result.usage;

          if (toolCalls.length > 0) {
            emitAssistantMessage(text, toolCalls, safeEnqueue);
          }

          emitResultMessage(usage.inputTokens || 0, usage.outputTokens || 0, safeEnqueue);

          if (!abortController.signal.aborted) {
            writeSessionMessages(actualCwd, actualSessionId, response.messages);
          }

          if (actualCwd) {
            updateGlobalState(actualCwd, actualSessionId, 'unread', undefined).catch(() => {});
          }

          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          if (abortController.signal.aborted) {
            safeClose();
            return;
          }

          console.error('[Ollama] stream error:', error);
          safeEnqueue(
            `data: ${JSON.stringify({
              type: 'error',
              error: String(error),
            })}\n\n`
          );
          safeClose();
        }
      },
      cancel() {
        isClosed = true;
        abortController.abort();
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
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
