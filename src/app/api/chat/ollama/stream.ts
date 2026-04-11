import type { TextStreamPart } from 'ai';

export type SafeEnqueue = (data: string) => void;

export async function consumeStream(
  fullStream: AsyncIterable<TextStreamPart<Record<string, never>>>,
  safeEnqueue: SafeEnqueue,
  _sessionId: string,
  opts?: {
    onToolResult?: (toolUseId: string, content: string) => void;
    onToolCall?: (toolUseId: string, toolName: string, input: Record<string, unknown>) => void;
    onTextFlush?: (text: string) => void;
  }
): Promise<{
  text: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}> {
  let text = '';
  const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];

  const pendingToolCalls = new Map<string, { id: string; name: string; args: string }>();

  for await (const part of fullStream) {
    switch (part.type) {
      case 'text-delta': {
        text += part.text;
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

      case 'tool-call': {
        // Flush accumulated text before persisting the tool call (preserves chronological order)
        if (text) {
          opts?.onTextFlush?.(text);
          text = '';
        }
        const input = (part.input || {}) as Record<string, unknown>;
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
        opts?.onToolResult?.(part.toolCallId, content);
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

      case 'finish':
        break;

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
