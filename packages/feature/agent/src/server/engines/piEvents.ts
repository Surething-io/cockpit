// Pure projection of Pi messages into Cockpit's existing chat and snapshot events.
import type { AgentSessionEvent, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Message, Usage } from '@earendil-works/pi-ai';
import type { RunEvent } from './types';
import type { TranscriptMessage } from '../api/session/transcriptToMessages';
import { join, resolve } from 'path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** Pi 1.4.0 resolveToCwd semantics; its resolver is not part of the public SDK. */
export function piToolPath(input: string, cwd: string): string {
  const normalize = (value: string, toolPath = false): string => {
    let path = toolPath ? value.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '') : value;
    if (process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
      const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
      if (match) path = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll('/', '\\') ?? ''}`;
    }
    if (path === '~') return homedir();
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) return join(homedir(), path.slice(2));
    return path.startsWith('file://') ? fileURLToPath(path) : path;
  };
  return resolve(normalize(cwd), normalize(input, true));
}

/** Normalize presentation only; Pi retains its native tool names and arguments. */
export function piTool(name: string, args: Record<string, unknown>, cwd?: string): { name: string; input: Record<string, unknown> } {
  const names: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', bash: 'Bash', grep: 'Grep', find: 'Glob', ls: 'LS' };
  return { name: names[name] ?? name, input: {
    ...args,
    ...(typeof args.path === 'string' ? { file_path: cwd ? piToolPath(args.path, cwd) : args.path } : {}),
    ...(typeof args.oldText === 'string' ? { old_string: args.oldText } : {}),
    ...(typeof args.newText === 'string' ? { new_string: args.newText } : {}),
  } };
}

/** Convert native usage counters for the existing usage display. */
export function piUsage(usage: Usage): Record<string, number> {
  return { input_tokens: usage.input, output_tokens: usage.output, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite };
}

/** Count finalized responses once within one run, independently of persisted session totals. */
export function createPiRunUsage(): { record: (message: AssistantMessage) => RunEvent | undefined; snapshot: () => Record<string, number>; cost: () => number } {
  const seen = new WeakSet<AssistantMessage>();
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let cost = 0;
  return {
    record(message) {
      // Pi emits the finalized message object before persisting it. Object identity
      // distinguishes retries and identical replies without inventing transcript ids.
      if (seen.has(message)) return undefined;
      seen.add(message);
      totals.input_tokens += message.usage.input;
      totals.output_tokens += message.usage.output;
      totals.cache_read_input_tokens += message.usage.cacheRead;
      totals.cache_creation_input_tokens += message.usage.cacheWrite;
      cost += message.usage.cost.total;
      return { type: 'usage_update', ...totals };
    },
    snapshot: () => ({ ...totals }),
    cost: () => cost,
  };
}

/** Project finalized messages without writing a second transcript. */
export function piMessage(message: Message, id: string, timestamp: string, cwd?: string): TranscriptMessage[] {
  const base = { uuid: id, timestamp };
  if (message.role === 'system') return [];
  if (message.role === 'toolResult') return [{ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), is_error: message.isError }] } }];
  if (message.role === 'user') return [{ ...base, type: 'user', message: { role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map((b) => b.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } } : { type: 'text', text: b.text }) } }];
  const result: TranscriptMessage[] = message.content.flatMap<TranscriptMessage>((block) => {
    if (block.type === 'text') return [{ ...base, type: 'assistant', message: { content: [{ type: 'text', text: block.text }] } }];
    if (block.type === 'toolCall') {
      const tool = piTool(block.name, block.arguments, cwd);
      return [{ ...base, type: 'assistant', message: { content: [{ type: 'tool_use', id: block.id, ...tool }] } }];
    }
    return [];
  });
  if (message.errorMessage) result.push({ ...base, type: 'assistant', message: { content: [{ type: 'text', text: `⚠️ ${message.errorMessage}` }] } });
  if (!result.length) result.push({ ...base, type: 'assistant', message: { content: [] } });
  const last = result[result.length - 1];
  last.message = { ...last.message, model: message.model, usage: piUsage(message.usage) };
  return result;
}

/** Render the active branch, including pre-compaction history for browsing. */
export function piBranchMessages(entries: SessionEntry[], cwd?: string): TranscriptMessage[] {
  const latestEdits = new Map(entries.flatMap((e) => e.type === 'context_edit' ? [[e.targetId, e.replacement] as const] : []));
  return entries.flatMap<TranscriptMessage>((entry) => {
    if (entry.type === 'custom' && ['cockpit.undelivered-input', 'cockpit.subagent-instructions', 'cockpit.subagent-interrupted-output', 'cockpit.subagent-snapshot'].includes(entry.customType)) {
      const data = entry.data as { text?: unknown } | undefined;
      if (typeof data?.text !== 'string') return [];
      return [{ type: 'user', uuid: entry.id, timestamp: entry.timestamp, isMeta: true, message: { role: 'user', content: data.text } }];
    }
    if (entry.type !== 'message') return [];
    const message = entry.message;
    const rows = message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult'
      ? piMessage(message, entry.id, entry.timestamp, cwd) : [];
    if (message.role === 'assistant' && ['length', 'error', 'aborted'].includes(message.stopReason)) {
      const excluded = latestEdits.has(entry.id) && latestEdits.get(entry.id) === null;
      const text = `Response incomplete (stopReason=${message.stopReason}).${message.stopReason === 'length' ? ' Output was truncated.' : ''}${excluded ? ' Pi excluded this response from subsequent model context.' : ''} Partial output is retained above.`;
      rows.push({ type: 'user', uuid: `${entry.id}-outcome`, timestamp: entry.timestamp, isMeta: true, message: { role: 'user', content: text } });
    }
    return rows;
  });
}

/** Translate streaming events; settled is handled by the scoped runner. */
export function piRunEvents(event: AgentSessionEvent, cwd?: string): RunEvent[] {
  if (event.type === 'message_start' && event.message.role === 'assistant') return [{ type: 'stream_event', event: { type: 'message_start' } }];
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent;
    if (delta.type === 'text_delta') return [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta.delta } } }];
    if (delta.type === 'thinking_delta') return [{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: delta.delta } } }];
  }
  // Finalized assistant text is already streamed. Only tool blocks are emitted here
  // so snapshots index the call before tool_execution_end without duplicating text.
  if (event.type === 'tool_execution_start') {
    const tool = piTool(event.toolName, event.args, cwd);
    return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: event.toolCallId, ...tool }] } }];
  }
  if (event.type === 'tool_execution_update' && event.toolName === 'subagent') {
    return [{ type: 'tool_progress', tool_call_id: event.toolCallId,
      progress_text: event.partialResult.content.filter((block: { type: string }) => block.type === 'text').map((block: { text?: string }) => block.text ?? '').join('\n') }];
  }
  if (event.type === 'tool_execution_end') return [{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: event.toolCallId, content: event.result.content.filter((b: { type: string }) => b.type === 'text').map((b: { text?: string }) => b.text ?? '').join('\n'), is_error: event.isError }] } }];
  if (event.type === 'auto_retry_start') return [{ type: 'system', subtype: 'api_retry', attempt: event.attempt, max_retries: event.maxAttempts, retry_delay_ms: event.delayMs, error: event.errorMessage }];
  if (event.type === 'compaction_start') return [{ type: 'system', subtype: 'status', status: 'compacting' }];
  if (event.type === 'compaction_end') return [{ type: 'system', subtype: 'status', status: null }];
  return [];
}
