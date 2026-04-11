import { streamText, stepCountIs } from 'ai';
import { NextRequest } from 'next/server';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { updateGlobalState } from '@/lib/global-state';
import { resolveCommandPrompt } from '@/lib/chat/slashCommands';
import { createOllamaModel } from './model';
import { appendAssistantMessage, appendToolResult, appendUserText, readSessionMessages } from './session';
import { createTools } from './tools';
import { consumeStream, emitResultMessage } from './stream';
import type { AgentContext, ChatRequestBody } from './types';
import { randomUUID } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_MODEL = 'qwen3.5:35b-a3b-coding-nvfp4';


function buildSystemPrompt(cwd: string): string {
  let prompt = `You are a coding agent. You help the user build and modify software using the provided tools.

CWD: ${cwd}

## Workflow

1. Plan: call TodoWrite FIRST to break down the task into steps (all pending, first one in_progress).
2. Act: execute steps one by one. After completing each step, call TodoWrite to update progress (mark completed, set next in_progress).
3. Check: after each tool call, assess — did it succeed? Is the overall task done? If not, continue to the next step.
4. Respond: you MUST always end with a text response to the user. Summarize what was done, what was found, or what remains.

IMPORTANT: never stop in the middle of a task silently. If you cannot continue (error, missing info, blocked), respond to the user explaining why and what is needed.

NEVER repeat a tool call with the same or similar arguments. When a search finds nothing, follow this escalation:
1. Simplify the pattern (shorter keyword, remove qualifiers, use a single core term)
2. Broaden the path (search parent directory, or omit path to search entire CWD)
3. Switch tool (Grep → Glob for filenames, Grep → Bash with find, or Read a likely file directly)
4. Give up after 3 failed attempts on the same topic — tell the user what you tried and ask for guidance.

## Tools

- Read: read a file by line range.
- Edit: exact string replacement in an existing file (prefer over Write).
- Write: create new files or full rewrites only.
- Bash: run shell commands.
- Grep: ripgrep search. ALWAYS use Grep (never rg/grep via Bash).
- Glob: fast file listing by glob pattern.
- TodoWrite: plan tasks and track progress. ALWAYS call this first.

Every tool has a "thought" parameter — ALWAYS fill it using this format:
"PREVIOUS: [what the last tool returned and whether it achieved the goal] → THIS: [what I am doing now and why] → EXPECT: [what result I expect]"
Example: "PREVIOUS: Grep found 3 matches in cache.go → THIS: Read cache.go to see full implementation → EXPECT: understand the caching logic"
If this is the first tool call, write "PREVIOUS: n/a" for the first part.

## Rules

Tool usage:
- Read before modify: do NOT edit a file you haven't Read.
- Absolute paths only: resolve relative paths against CWD.

Accuracy:
- Verify before retracting: when the user questions you, use tools to verify first, then respond based on evidence. Do NOT blindly agree you were wrong.
- Honesty over confidence: only state what is backed by tool output. If unsure, say so and state what info is needed or propose a verification plan. Never fabricate data.

## Output

- Be concise. Lead with the action or answer.
- Only elaborate on decisions, blockers, or milestones.`;

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
    const actualSessionId = sessionId || randomUUID();
    const actualModel = model || DEFAULT_MODEL;

    const context: AgentContext = {
      cwd: actualCwd,
      todos: [],
    };

    const existingMessages = readSessionMessages(actualCwd, actualSessionId);
    const userMessage: ModelMessage = { role: 'user', content: prompt };
    const messages = [...existingMessages, userMessage];

    const userUuid = randomUUID();
    const userTimestamp = new Date().toISOString();
    appendUserText(actualCwd, actualSessionId, prompt, { uuid: userUuid, timestamp: userTimestamp });

    const abortController = new AbortController();
    request.signal.addEventListener('abort', () => abortController.abort());

    const ollamaModel = createOllamaModel(actualModel);
    const tools = createTools(context);

    const result = streamText({
      model: ollamaModel,
      system: buildSystemPrompt(actualCwd),
      messages,
      tools,
      stopWhen: stepCountIs(256),
      temperature: 0,
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

        const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();

        const flushPendingToolCallsAsErrors = (reason: string) => {
          if (pendingToolCalls.size === 0) return;

          for (const [toolUseId] of pendingToolCalls) {
            try {
              appendToolResult(actualCwd, actualSessionId, toolUseId, reason, {
                uuid: randomUUID(),
                timestamp: new Date().toISOString(),
                is_error: true,
              });
            } catch {
              // ignore session write errors
            }

            try {
              safeEnqueue(
                `data: ${JSON.stringify({
                  type: 'user',
                  message: {
                    content: [
                      {
                        type: 'tool_result',
                        tool_use_id: toolUseId,
                        content: reason,
                        is_error: true,
                      },
                    ],
                  },
                })}\n\n`
              );
            } catch {
              // ignore enqueue errors
            }
          }

          pendingToolCalls.clear();
        };

        try {
          const { text } = await consumeStream(
            result.fullStream as AsyncIterable<import('ai').TextStreamPart<Record<string, never>>>,
            safeEnqueue,
            actualSessionId,
            {
              onToolCall: (toolUseId, toolName, input) => {
                try {
                  pendingToolCalls.set(toolUseId, { name: toolName, input });
                  appendAssistantMessage(
                    actualCwd,
                    actualSessionId,
                    [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
                    { uuid: randomUUID(), timestamp: new Date().toISOString() }
                  );
                } catch {
                  // ignore session write errors
                }
              },
              onToolResult: (toolUseId, content) => {
                try {
                  pendingToolCalls.delete(toolUseId);
                  appendToolResult(actualCwd, actualSessionId, toolUseId, content, {
                    uuid: randomUUID(),
                    timestamp: new Date().toISOString(),
                    is_error: false,
                  });
                } catch {
                  // ignore session write errors
                }
              },
              onTextFlush: (flushedText) => {
                try {
                  appendAssistantMessage(
                    actualCwd,
                    actualSessionId,
                    [{ type: 'text', text: flushedText }],
                    { uuid: randomUUID(), timestamp: new Date().toISOString() }
                  );
                } catch {
                  // ignore session write errors
                }
              },
            }
          );

          const usage = await result.usage;

          emitResultMessage(usage.inputTokens || 0, usage.outputTokens || 0, safeEnqueue);

          if (!abortController.signal.aborted) {
            appendAssistantMessage(actualCwd, actualSessionId, text ? [{ type: 'text', text }] : [], {
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              usage: {
                input_tokens: usage.inputTokens || 0,
                output_tokens: usage.outputTokens || 0,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
            });
          }

          if (actualCwd) {
            updateGlobalState(actualCwd, actualSessionId, 'unread', undefined).catch(() => {});
          }

          safeEnqueue('data: [DONE]\n\n');
          safeClose();
        } catch (error) {
          if (abortController.signal.aborted) {
            flushPendingToolCallsAsErrors('Tool call cancelled (request aborted).');
            safeClose();
            return;
          }

          flushPendingToolCallsAsErrors('Tool call failed (stream error).');

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
