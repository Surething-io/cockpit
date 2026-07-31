import { streamText, stepCountIs } from 'ai';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { randomUUID } from 'crypto';
import { createOllamaModel } from './model';
import { appendAssistantMessage, appendToolResult, appendUserText, readSessionMessages } from './session';
import { createTools } from './tools';
import { consumeStream, emitResultMessage } from './stream';
import type { AgentContext } from './types';
import type { EngineSpec, RunCtx } from '../types';

const DEFAULT_MODEL = 'qwen3.5:35b-a3b-coding-nvfp4';

function buildSystemPrompt(cwd: string): string {
  return `You are a coding agent. You help the user build and modify software using the provided tools.

CWD: ${cwd}

## Language

ALWAYS reply in the SAME language as the user's most recent message — whatever language they used (Chinese, English, Japanese, French, Spanish, …), mirror it. Do NOT default to English just because this system prompt is written in English. If the user switches language mid-conversation, switch with them on the next reply.

Exceptions that stay as-is regardless of reply language:
- Tool "thought" parameters: keep the "PREVIOUS / THIS / EXPECT" template in English.
- Code, identifiers, file paths, shell commands, and error messages quoted from tool output: keep original.
- Only your natural-language prose to the user follows the user's language.

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
}

export const ollamaSpec: EngineSpec = {
  name: 'ollama',
  // Ollama has no image support here — require a text prompt (the SDK orchestrator allows
  // images-only for claude/deepseek; without this an images-only message reaches the runner
  // with an undefined prompt).
  async preflight(params) {
    return typeof params.prompt === 'string' && params.prompt.trim()
      ? { ok: true }
      : { ok: false, status: 400, error: 'ollama requires a text prompt' };
  },
  runner: {
    async run(ctx: RunCtx) {
      const cwd = ctx.cwd || process.cwd();
      const sid = ctx.currentKey(); // ollama uses the runId/sessionId as its session id (no rekey)
      ctx.rekey(sid); // set the returned sessionId = sid (+ 'loading' global state)
      const model = (typeof ctx.params.model === 'string' && ctx.params.model) || DEFAULT_MODEL;
      const prompt = ctx.prompt as string; // orchestrator validated non-empty content

      // Bridge the engines/ollama/* helpers' SSE-string contract to ctx.emit (objects).
      const emit = (data: string) => {
        if (data.startsWith('data: [DONE]')) return;
        try { ctx.emit(JSON.parse(data.slice(6))); } catch { /* ignore */ }
      };

      // "Independent task" mode: send ONLY this turn to the model. We still read/write the
      // transcript exactly as usual — the jsonl is what the UI renders, so skipping the WRITE
      // would blank the visible history. Only the prompt loses the prior messages.
      const noHistory = ctx.params.noHistory === true;
      const existing = noHistory ? [] : readSessionMessages(cwd, sid);
      const messages: ModelMessage[] = [...existing, { role: 'user', content: prompt }];
      appendUserText(cwd, sid, prompt, { uuid: randomUUID(), timestamp: new Date().toISOString() });

      emit(`data: ${JSON.stringify({ type: 'system', subtype: 'init', session_id: sid })}\n\n`);

      const context: AgentContext = { cwd, todos: [] };
      const languageModel = await createOllamaModel(model);
      const result = streamText({
        model: languageModel,
        system: buildSystemPrompt(cwd),
        messages,
        tools: createTools(context),
        stopWhen: stepCountIs(256),
        temperature: 0,
        abortSignal: ctx.signal,
      });

      const pendingToolCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
      const flushPendingToolCallsAsErrors = (reason: string) => {
        if (pendingToolCalls.size === 0) return;
        for (const [toolUseId] of pendingToolCalls) {
          try {
            appendToolResult(cwd, sid, toolUseId, reason, {
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              is_error: true,
            });
          } catch { /* ignore */ }
          try {
            emit(
              `data: ${JSON.stringify({
                type: 'user',
                message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: reason, is_error: true }] },
              })}\n\n`,
            );
          } catch { /* ignore */ }
        }
        pendingToolCalls.clear();
      };

      try {
        const { text } = await consumeStream(
          result.fullStream as AsyncIterable<import('ai').TextStreamPart<Record<string, never>>>,
          emit,
          sid,
          {
            onToolCall: (toolUseId, toolName, input) => {
              try {
                pendingToolCalls.set(toolUseId, { name: toolName, input });
                appendAssistantMessage(cwd, sid, [{ type: 'tool_use', id: toolUseId, name: toolName, input }], {
                  uuid: randomUUID(),
                  timestamp: new Date().toISOString(),
                });
              } catch { /* ignore */ }
            },
            onToolResult: (toolUseId, content) => {
              try {
                pendingToolCalls.delete(toolUseId);
                appendToolResult(cwd, sid, toolUseId, content, {
                  uuid: randomUUID(),
                  timestamp: new Date().toISOString(),
                  is_error: false,
                });
              } catch { /* ignore */ }
            },
            onTextFlush: (flushedText) => {
              try {
                appendAssistantMessage(cwd, sid, [{ type: 'text', text: flushedText }], {
                  uuid: randomUUID(),
                  timestamp: new Date().toISOString(),
                });
              } catch { /* ignore */ }
            },
          },
        );

        const usage = await result.usage;
        emitResultMessage(usage.inputTokens || 0, usage.outputTokens || 0, emit);

        if (!ctx.signal.aborted) {
          appendAssistantMessage(cwd, sid, text ? [{ type: 'text', text }] : [], {
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
      } catch (error) {
        if (ctx.signal.aborted) {
          flushPendingToolCallsAsErrors('Tool call cancelled (request aborted).');
          return; // orchestrator maps abort → idle
        }
        flushPendingToolCallsAsErrors('Tool call failed (stream error).');
        throw error; // orchestrator marks 'error' + emits the error event
      }
    },
    // No resolveTitle → teardown uses 'unread' with undefined title (matches original).
  },
};
