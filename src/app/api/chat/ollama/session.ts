import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { encodePath } from '@/lib/paths';

const SESSIONS_ROOT = join(homedir(), '.cockpit', 'ollama-sessions');

type ClaudeContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id?: string; content?: string; is_error?: boolean }
  | {
      type: 'image';
      source?: { type: string; media_type: string; data: string };
    };

export interface ClaudeTranscriptLine {
  type: string; // 'user' | 'assistant' | 'summary' | 'result' | ...
  message?: {
    role?: string;
    content?: ClaudeContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  summary?: string;
  isMeta?: boolean;
}

function getSessionDir(cwd: string): string {
  return join(SESSIONS_ROOT, encodePath(cwd));
}

function getSessionPath(cwd: string, sessionId: string): string {
  return join(getSessionDir(cwd), `${sessionId}.jsonl`);
}

export function readSessionMessages(cwd: string, sessionId: string): ModelMessage[] {
  const path = getSessionPath(cwd, sessionId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const legacyMessages: ModelMessage[] = [];
  const transcriptEntries: ClaudeTranscriptLine[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;

      // Legacy format: AI SDK ModelMessage JSONL
      if (typeof obj.role === 'string' && 'content' in obj) {
        legacyMessages.push(obj as unknown as ModelMessage);
        continue;
      }

      // Claude-style transcript format
      if (typeof obj.type === 'string') {
        transcriptEntries.push(obj as unknown as ClaudeTranscriptLine);
      }
    } catch {
      // skip corrupted lines
    }
  }

  // If this is a legacy file (no Claude-style transcript lines), keep legacy behavior.
  if (transcriptEntries.length === 0) return legacyMessages;

  // First pass: build indices so we can drop dangling tool calls (tool_use without tool_result)
  // which would break AI SDK prompt validation on subsequent turns.
  const toolNameById = new Map<string, string>();
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const entry of transcriptEntries) {
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.id) {
          toolCallIds.add(block.id);
          if (block.name) toolNameById.set(block.id, block.name);
        }
      }
    }

    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  const messages: ModelMessage[] = [];

  for (const entry of transcriptEntries) {
    // User text
    if (entry.type === 'user' && entry.message?.role === 'user' && Array.isArray(entry.message.content)) {
      const text = entry.message.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join('\n');
      messages.push({ role: 'user', content: text } as ModelMessage);
      continue;
    }

    // Assistant message (text + tool calls)
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const parts: Array<Record<string, unknown>> = [];

      for (const block of entry.message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text || '' });
        } else if (block.type === 'tool_use') {
          const toolCallId = block.id || '';
          if (!toolCallId) continue;

          // Drop tool calls that never got a tool_result line (e.g. aborted mid-tool).
          if (!toolResultIds.has(toolCallId)) continue;

          const toolName = block.name || toolNameById.get(toolCallId) || 'tool';
          parts.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            input: block.input || {},
          });
        }
      }

      if (parts.length === 1 && parts[0].type === 'text') {
        messages.push({ role: 'assistant', content: String(parts[0].text || '') } as ModelMessage);
      } else if (parts.length > 0) {
        messages.push({ role: 'assistant', content: parts as unknown } as ModelMessage);
      } else {
        messages.push({ role: 'assistant', content: '' } as ModelMessage);
      }
      continue;
    }

    // Tool results are stored as user-typed lines in Claude-style transcripts
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      const toolResults = entry.message.content.filter(
        (b): b is Extract<ClaudeContentBlock, { type: 'tool_result' }> => b.type === 'tool_result' && Boolean(b.tool_use_id)
      );

      for (const tr of toolResults) {
        const toolCallId = tr.tool_use_id || '';
        if (!toolCallId) continue;

        // Drop results without matching call (keeps prompt schema consistent).
        if (!toolCallIds.has(toolCallId)) continue;

        const toolName = toolNameById.get(toolCallId) || 'tool';
        messages.push({
          role: 'tool',
	          content: [
	            {
	              type: 'tool-result',
	              toolCallId,
	              toolName,
	              output: tr.is_error ? { type: 'error-text', value: tr.content || '' } : { type: 'text', value: tr.content || '' },
	            },
	          ],
	        } as unknown as ModelMessage);
	      }
	    }
  }

  return messages;
}

export function appendSessionLine(cwd: string, sessionId: string, line: ClaudeTranscriptLine): void {
  const dir = getSessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getSessionPath(cwd, sessionId);
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
}

export function appendUserText(cwd: string, sessionId: string, text: string, opts?: { uuid?: string; timestamp?: string }): void {
  appendSessionLine(cwd, sessionId, {
    type: 'user',
    uuid: opts?.uuid,
    sessionId,
    timestamp: opts?.timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

export function appendAssistantMessage(
  cwd: string,
  sessionId: string,
  content: ClaudeContentBlock[],
  opts?: {
    uuid?: string;
    timestamp?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  }
): void {
  appendSessionLine(cwd, sessionId, {
    type: 'assistant',
    uuid: opts?.uuid,
    sessionId,
    timestamp: opts?.timestamp,
    message: { role: 'assistant', content, ...(opts?.usage ? { usage: opts.usage } : {}) },
  });
}

export function appendToolResult(
  cwd: string,
  sessionId: string,
  toolUseId: string,
  content: string,
  opts?: { uuid?: string; timestamp?: string; is_error?: boolean }
): void {
  appendSessionLine(cwd, sessionId, {
    type: 'user',
    uuid: opts?.uuid,
    sessionId,
    timestamp: opts?.timestamp,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          is_error: Boolean(opts?.is_error),
        },
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Backward-compatible exports (legacy ModelMessage JSONL writer)
// ---------------------------------------------------------------------------

function modelMessageToTranscriptLines(
  sessionId: string,
  m: ModelMessage
): ClaudeTranscriptLine[] {
  if (m.role === 'user') {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
              .filter((p) => p.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text!)
              .join('\n')
          : '';
    return [
      {
        type: 'user',
        sessionId,
        message: { role: 'user', content: [{ type: 'text', text }] },
      },
    ];
  }

  if (m.role === 'assistant') {
    if (typeof m.content === 'string') {
      return [
        {
          type: 'assistant',
          sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: m.content }] },
        },
      ];
    }

    if (Array.isArray(m.content)) {
      const content: ClaudeContentBlock[] = [];
      for (const part of m.content as Array<Record<string, unknown>>) {
        if (part.type === 'text' && typeof part.text === 'string') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: typeof part.toolCallId === 'string' ? part.toolCallId : '',
            name: typeof part.toolName === 'string' ? part.toolName : '',
            input:
              (typeof part.input === 'object' && part.input !== null
                ? (part.input as Record<string, unknown>)
                : typeof part.args === 'object' && part.args !== null
                  ? (part.args as Record<string, unknown>)
                  : {}) as Record<string, unknown>,
          });
        }
      }
      return [
        {
          type: 'assistant',
          sessionId,
          message: { role: 'assistant', content },
        },
      ];
    }

    return [{ type: 'assistant', sessionId, message: { role: 'assistant', content: [{ type: 'text', text: '' }] } }];
  }

  if (m.role === 'tool' && Array.isArray(m.content)) {
    const lines: ClaudeTranscriptLine[] = [];
    for (const part of m.content as Array<Record<string, unknown>>) {
      if (part.type === 'tool-result' && typeof part.toolCallId === 'string') {
        let value = '';
        if (typeof part.output === 'object' && part.output !== null) {
          const output = part.output as { type?: string; value?: unknown };
          if (output.type === 'text' || output.type === 'error-text') {
            value = typeof output.value === 'string' ? output.value : String(output.value ?? '');
          } else {
            value = JSON.stringify(output.value ?? '');
          }
        } else if (typeof part.result === 'string') {
          value = part.result;
        } else {
          value = String(part.result ?? '');
        }

        lines.push({
          type: 'user',
          sessionId,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: part.toolCallId,
                content: value,
                is_error: false,
              },
            ],
          },
        });
      }
    }
    return lines;
  }

  return [];
}

// Legacy API: previously wrote AI SDK ModelMessage JSONL. Keep the export to avoid build/runtime breaks,
// but write Claude-style transcript JSONL instead (so sessions remain compatible with Claude parser).
export function writeSessionMessages(cwd: string, sessionId: string, messages: ModelMessage[]): void {
  const dir = getSessionDir(cwd);
  mkdirSync(dir, { recursive: true });
  const path = getSessionPath(cwd, sessionId);

  const lines: ClaudeTranscriptLine[] = [];
  for (const m of messages) {
    lines.push(...modelMessageToTranscriptLines(sessionId, m));
  }
  const content = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(path, content, 'utf-8');
}
