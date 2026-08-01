import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import type { ModelMessage } from '@ai-sdk/provider-utils';
import { encodePath } from '@cockpit/shared-utils';

// The store root is passed in per engine (ollama → ~/.cockpit/ollama-sessions, deepseek →
// ~/.cockpit/deepseek-sessions) and MUST come from paths.ts, which is COCKPIT_HOME-aware.
// Hardcoding ~/.cockpit here once split the write/read dirs under COCKPIT_HOME and made
// sessions look unsaved after refresh.

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

function getSessionDir(root: string, cwd: string): string {
  return join(root, encodePath(cwd));
}

function getSessionPath(root: string, cwd: string, sessionId: string): string {
  return join(getSessionDir(root, cwd), `${sessionId}.jsonl`);
}

export function readSessionMessages(root: string, cwd: string, sessionId: string): ModelMessage[] {
  const path = getSessionPath(root, cwd, sessionId);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  const transcriptEntries: ClaudeTranscriptLine[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Claude-style transcript format (the only format written since v1.0.186; the AI SDK
      // ModelMessage legacy fallback for v1.0.184–185 files was removed).
      if (typeof obj.type === 'string') {
        transcriptEntries.push(obj as unknown as ClaudeTranscriptLine);
      }
    } catch {
      // skip corrupted lines
    }
  }

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

export function appendSessionLine(root: string, cwd: string, sessionId: string, line: ClaudeTranscriptLine): void {
  const dir = getSessionDir(root, cwd);
  mkdirSync(dir, { recursive: true });
  const path = getSessionPath(root, cwd, sessionId);
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
}

export function appendUserText(root: string, cwd: string, sessionId: string, text: string, opts?: { uuid?: string; timestamp?: string }): void {
  appendSessionLine(root, cwd, sessionId, {
    type: 'user',
    uuid: opts?.uuid,
    sessionId,
    timestamp: opts?.timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

export function appendAssistantMessage(
  root: string,
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
  appendSessionLine(root, cwd, sessionId, {
    type: 'assistant',
    uuid: opts?.uuid,
    sessionId,
    timestamp: opts?.timestamp,
    message: { role: 'assistant', content, ...(opts?.usage ? { usage: opts.usage } : {}) },
  });
}

export function appendToolResult(
  root: string,
  cwd: string,
  sessionId: string,
  toolUseId: string,
  content: string,
  opts?: { uuid?: string; timestamp?: string; is_error?: boolean }
): void {
  appendSessionLine(root, cwd, sessionId, {
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

