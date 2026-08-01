/**
 * Built-in Agent — Cockpit's own agent loop.
 *
 * The third execution mode, alongside the vendor ones:
 *   - shared/sdkLoop.ts   → Claude Agent SDK   (vendor SDK drives the loop)
 *   - shared/ptyBranch.ts → Claude Code CLI    (vendor CLI drives the loop)
 *   - this file           → Built-in Agent     (we drive the loop)
 *
 * We own the system prompt (prompt.ts), the tools (tools.ts) and the transcript
 * (session.ts), and talk to any OpenAI-compatible endpoint through the AI SDK.
 * Everything provider-specific — base URL, credentials, model, store root — arrives
 * as BuiltinAgentConfig from the engine spec, so adding a provider is a config
 * object rather than a fork of this loop.
 */
import { streamText, stepCountIs } from 'ai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { randomUUID } from 'crypto';
import { buildSystemPrompt } from './prompt';
import { appendAssistantMessage, appendToolResult, appendUserText, readSessionMessages } from './session';
import { createTools } from './tools';
import { consumeStream, emitResultMessage } from './stream';
import type { AgentContext } from './types';
import type { DispatchParams, RunCtx } from '../types';

export interface BuiltinAgentConfig {
  /** Transcript store root — always from paths.ts getBuiltinSessionsRoot (COCKPIT_HOME-aware). */
  sessionsRoot: string;
  /** Model used when the request carries none. */
  defaultModel: string;
  /** Provider factory for the resolved model name. */
  createModel: (model: string) => Promise<LanguageModelV3>;
}

/** Shared preflight: the loop has no image support, and the orchestrator lets
 *  images-only messages through for the SDK engines — without this they reach the
 *  runner with an undefined prompt. */
export function requireTextPrompt(
  params: DispatchParams,
): { ok: true } | { ok: false; status: number; error: string } {
  return typeof params.prompt === 'string' && params.prompt.trim()
    ? { ok: true }
    : { ok: false, status: 400, error: 'The built-in agent requires a text prompt' };
}

export async function runBuiltinAgent(ctx: RunCtx, config: BuiltinAgentConfig): Promise<void> {
  const { sessionsRoot } = config;
  const cwd = ctx.cwd || process.cwd();
  const sid = ctx.currentKey(); // the built-in agent uses the runId/sessionId as its session id (no rekey)
  ctx.rekey(sid); // set the returned sessionId = sid (+ 'loading' global state)
  const model = (typeof ctx.params.model === 'string' && ctx.params.model) || config.defaultModel;
  const prompt = ctx.prompt as string; // orchestrator validated non-empty content

  // Bridge the builtinAgent/* helpers' SSE-string contract to ctx.emit (objects).
  const emit = (data: string) => {
    if (data.startsWith('data: [DONE]')) return;
    try { ctx.emit(JSON.parse(data.slice(6))); } catch { /* ignore */ }
  };

  // "Independent task" mode: send ONLY this turn to the model. We still read/write the
  // transcript exactly as usual — the jsonl is what the UI renders, so skipping the WRITE
  // would blank the visible history. Only the prompt loses the prior messages.
  const noHistory = ctx.params.noHistory === true;
  const existing = noHistory ? [] : readSessionMessages(sessionsRoot, cwd, sid);
  const messages: ModelMessage[] = [...existing, { role: 'user', content: prompt }];
  appendUserText(sessionsRoot, cwd, sid, prompt, { uuid: randomUUID(), timestamp: new Date().toISOString() });

  emit(`data: ${JSON.stringify({ type: 'system', subtype: 'init', session_id: sid })}\n\n`);

  const context: AgentContext = { cwd, todos: [] };
  const languageModel = await config.createModel(model);
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
        appendToolResult(sessionsRoot, cwd, sid, toolUseId, reason, {
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
            appendAssistantMessage(
              sessionsRoot,
              cwd,
              sid,
              [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
              { uuid: randomUUID(), timestamp: new Date().toISOString() },
            );
          } catch { /* ignore */ }
        },
        onToolResult: (toolUseId, content, isError) => {
          try {
            pendingToolCalls.delete(toolUseId);
            appendToolResult(sessionsRoot, cwd, sid, toolUseId, content, {
              uuid: randomUUID(),
              timestamp: new Date().toISOString(),
              is_error: Boolean(isError),
            });
          } catch { /* ignore */ }
        },
        onTextFlush: (flushedText) => {
          try {
            appendAssistantMessage(sessionsRoot, cwd, sid, [{ type: 'text', text: flushedText }], {
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
      appendAssistantMessage(sessionsRoot, cwd, sid, text ? [{ type: 'text', text }] : [], {
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
}
