import type { TextStreamPart } from 'ai';
import { estimateOutputUnits } from '@cockpit/shared-utils/outputProgress';
import { formatProviderError } from '../shared/providerError';

export type SafeEnqueue = (data: string) => void;

function emitUsageUpdate(outputTokens: number, safeEnqueue: SafeEnqueue): void {
  safeEnqueue(
    `data: ${JSON.stringify({
      type: 'usage_update',
      output_tokens: Math.max(0, Math.round(outputTokens)),
    })}\n\n`
  );
}

/** A failed tool call still owes the transcript a tool_result. Turn whatever the AI SDK
 *  threw (Error, string, structured payload) into readable text for the model and the UI. */
function formatToolError(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function consumeStream(
  fullStream: AsyncIterable<TextStreamPart<Record<string, never>>>,
  safeEnqueue: SafeEnqueue,
  _sessionId: string,
  opts?: {
    onToolResult?: (toolUseId: string, content: string, isError?: boolean) => void;
    onToolCall?: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;
    onTextFlush?: (text: string) => void;
  }
): Promise<{
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}> {
  let text = '';
  let progressOutputTokens = 0;
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

  const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();

  for await (const part of fullStream) {
    switch (part.type) {
      case 'text-delta': {
        text += part.text;
        progressOutputTokens += estimateOutputUnits(part.text);
        emitUsageUpdate(progressOutputTokens, safeEnqueue);
        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: part.text },
            },
          })}\n\n`
        );
        break;
      }

      case 'finish-step':
        break;

      case 'tool-call': {
        // Flush accumulated text before persisting the tool call (preserves chronological order)
        if (text) {
          opts?.onTextFlush?.(text);
          text = '';
        }
        const input = (part.input || {}) as Record<string, unknown>;
        progressOutputTokens += estimateOutputUnits(`${part.toolName} ${JSON.stringify(input)}`);
        emitUsageUpdate(progressOutputTokens, safeEnqueue);
        opts?.onToolCall?.(part.toolCallId, part.toolName, input);
        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: part.toolCallId, name: part.toolName, input }],
            },
          })}\n\n`
        );
        pendingToolCalls.set(part.toolCallId, {
          id: part.toolCallId,
          name: part.toolName,
          args: JSON.stringify(input),
        });
        break;
      }

      case 'tool-result': {
        const content = String(part.output);
        progressOutputTokens += estimateOutputUnits(content);
        emitUsageUpdate(progressOutputTokens, safeEnqueue);
        opts?.onToolResult?.(part.toolCallId, content, false);
        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: part.toolCallId, content, is_error: false }],
            },
          })}\n\n`
        );
        break;
      }

      // A tool that threw (or whose input failed schema validation) emits `tool-error`,
      // never `tool-result`. Skipping it left the tool_use dangling in the transcript;
      // on the NEXT turn that call was dropped on replay, the assistant message it lived
      // in became empty, and the provider rejected the whole request with
      // "Invalid assistant message: content or tool_calls must be set" — a permanently
      // unusable session. Every tool call must close with a result line, success or not.
      case 'tool-error': {
        const content = formatToolError(part.error);
        progressOutputTokens += estimateOutputUnits(content);
        emitUsageUpdate(progressOutputTokens, safeEnqueue);
        opts?.onToolResult?.(part.toolCallId, content, true);
        safeEnqueue(
          `data: ${JSON.stringify({
            type: 'user',
            message: {
              content: [{ type: 'tool_result', tool_use_id: part.toolCallId, content, is_error: true }],
            },
          })}\n\n`
        );
        break;
      }

      // A provider/transport failure (bad key, no quota, model not on the plan,
      // network reset) is NOT thrown by streamText — it arrives here as an
      // `error` part and the stream then ends. Falling through to `default`
      // dropped it: the SDK's own `onError` logged it to the server terminal,
      // `await result.usage` later rejected with the useless "No output
      // generated", and mid-loop failures didn't even do that — they emitted a
      // `result: success` over an empty bubble. Re-throw so the reason travels
      // the normal failure path (orchestrator → run `error` event → UI).
      case 'error':
        throw new Error(formatProviderError(part.error), { cause: part.error });

      default:
        break;
    }
  }

  for (const tc of pendingToolCalls.values()) {
    try {
      toolCalls.push({ id: tc.id, name: tc.name, args: JSON.parse(tc.args) });
    } catch {
      toolCalls.push({ id: tc.id, name: tc.name, args: {} });
    }
  }

  return { text, toolCalls };
}

export function emitAssistantMessage(
  text: string,
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  safeEnqueue: SafeEnqueue
): void {
  if (toolCalls.length === 0 && !text) return;

  const content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = [];
  if (text) {
    content.push({ type: 'text', text });
  }
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
  }

  safeEnqueue(
    `data: ${JSON.stringify({
      type: 'assistant',
      message: { content },
    })}\n\n`
  );
}

export function emitResultMessage(
  promptTokens: number,
  completionTokens: number,
  safeEnqueue: SafeEnqueue
): void {
  safeEnqueue(
    `data: ${JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      total_cost_usd: 0,
    })}\n\n`
  );
}
