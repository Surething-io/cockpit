import { randomUUID } from 'node:crypto';
import type { RunEvent } from '../types';
import { object, type AcpObject } from './client';

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  const block = object(value);
  if (typeof block.output_for_prompt === 'string') return block.output_for_prompt;
  if (typeof block.output === 'string') return block.output;
  if (typeof block.text === 'string') return block.text;
  if (block.content) return contentText(block.content);
  if (block.type === 'diff') return `${block.path ?? ''}\n${block.newText ?? ''}`;
  return '';
}

const TOOL_NAMES: Record<string, string> = {
  read: 'Read', edit: 'Edit', execute: 'Bash', search: 'Grep', fetch: 'WebFetch', think: 'Think',
};

/** Keeps ACP partial tool updates associated with their original call. */
export class GrokEventAdapter {
  constructor(private readonly nextId: () => string = randomUUID) {}

  private readonly tools = new Map<string, AcpObject>();
  private readonly completed = new Set<string>();
  private readonly background = new Map<string, { toolId: string; description: string }>();
  private wakePending = false;
  private readonly streamedMessages = new Set<string>();

  get waitingForBackground(): boolean { return this.background.size > 0 || this.wakePending; }
  finishWake(): void { this.wakePending = false; }

  private backgroundChanged(): RunEvent {
    return { type: 'system', subtype: 'background_tasks_changed', tasks: [...this.background].map(([task_id, task]) => ({ task_id, description: task.description })) };
  }

  update(update: AcpObject): RunEvent[] {
    const kind = update.sessionUpdate;
    if (kind === 'agent_message' || kind === 'agent_thought') {
      if (typeof update.messageId === 'string' && this.streamedMessages.has(update.messageId)) return [];
      return this.update({ ...update, sessionUpdate: kind === 'agent_message' ? 'agent_message_chunk' : 'agent_thought_chunk' });
    }
    if (kind === 'task_completed' || kind === 'subagent_finished') {
      const snapshot = object(update.task_snapshot);
      const taskId = String(update.child_session_id ?? snapshot.task_id ?? update.task_id ?? '');
      const task = this.background.get(taskId);
      if (!task) return [];
      this.background.delete(taskId);
      if (update.will_wake === true) this.wakePending = true;
      this.completed.add(task.toolId);
      return [this.backgroundChanged(), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: task.toolId,
        content: contentText(update.output ?? update.error ?? snapshot.output), is_error: update.status === 'failed' || (typeof snapshot.exit_code === 'number' && snapshot.exit_code !== 0),
        ...(typeof snapshot.exit_code === 'number' ? { exit_code: snapshot.exit_code } : {}),
      }] } }];
    }
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = contentText(update.content);
      if (!text) return [];
      if (typeof update.messageId === 'string') this.streamedMessages.add(update.messageId);
      const thinking = kind === 'agent_thought_chunk';
      return [{ type: 'stream_event', event: { type: 'content_block_delta', delta: thinking
        ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text } } }];
    }
    if (kind === 'tool_call' || kind === 'tool_call_update' || kind === 'tool_call_content_chunk') {
      const id = update.toolCallId;
      if (typeof id !== 'string' || this.completed.has(id)) return [];
      const previous = this.tools.get(id);
      const tool = { ...previous, ...update };
      if (kind === 'tool_call_content_chunk') tool.content = [...(Array.isArray(previous?.content) ? previous.content : []), update.content];
      this.tools.set(id, tool);
      const events: RunEvent[] = [];
      if (!previous) {
        const raw = object(tool.rawInput);
        const native = object(object(tool._meta)['x.ai/tool']);
        const nativeName = native.name ?? tool.name;
        const name = nativeName === 'spawn_subagent' ? 'Task'
          : TOOL_NAMES[String(tool.kind ?? native.kind)] ?? String(nativeName ?? tool.title ?? 'GrokTool');
        const input: AcpObject = { ...raw };
        if (typeof raw.path === 'string') input.file_path = raw.path;
        if (name === 'Bash' && !input.command) input.command = tool.title ?? '';
        events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
      }
      const rawOutput = object(tool.rawOutput);
      const receiptText = contentText(tool.rawOutput) || contentText(tool.content);
      const backgroundId = rawOutput.type === 'BackgroundTaskStarted' ? rawOutput.task_id
        : /subagent started in background/i.test(receiptText) ? receiptText.match(/subagent_id:\s*([a-zA-Z0-9_-]+)/)?.[1] : undefined;
      if (typeof backgroundId === 'string' && !this.background.has(backgroundId)) {
        this.background.set(backgroundId, { toolId: id, description: String(tool.title ?? 'Grok background task') });
        events.push(this.backgroundChanged());
      }
      const result = object(rawOutput.Result);
      if (typeof result.task_id === 'string' && ['completed', 'failed', 'cancelled'].includes(String(result.status))) {
        const task = this.background.get(result.task_id);
        if (task) {
          this.background.delete(result.task_id);
          this.completed.add(task.toolId);
          events.push(this.backgroundChanged(), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: task.toolId, content: contentText(result), is_error: result.status === 'failed' }] } });
        }
      }
      if ([...this.background.values()].some((task) => task.toolId === id)) {
        events.push({ type: 'tool_progress', tool_call_id: id, progress_text: receiptText });
        return events;
      }
      if (tool.status === 'completed' || tool.status === 'failed') {
        this.completed.add(id);
        const output = contentText(tool.content) || contentText(tool.rawOutput)
          || (tool.rawOutput === undefined ? '' : JSON.stringify(tool.rawOutput));
        const exitCode = object(tool.rawOutput).exit_code;
        events.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: tool.status === 'failed', ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}) }] } });
      } else if (kind === 'tool_call_content_chunk') {
        events.push({ type: 'tool_progress', tool_call_id: id, progress_text: contentText(tool.content) });
      }
      return events;
    }
    if (kind === 'plan' && Array.isArray(update.entries)) {
      const id = `grok-plan-${this.nextId()}`;
      return [{ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'TodoWrite', input: {
        todos: update.entries.map((entry) => ({ ...object(entry), activeForm: object(entry).content })),
      } }] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Plan updated.' }] } }];
    }
    return [];
  }
}

/** Display transcript uses the existing Claude-shaped reader; native context stays in Grok. */
export function grokTranscriptEvent(event: RunEvent): AcpObject | null {
  if (event.type === 'stream_event') {
    const delta = object(object(event.event).delta);
    const block = delta.type === 'text_delta' ? { type: 'text', text: delta.text }
      : delta.type === 'thinking_delta' ? { type: 'thinking', thinking: delta.thinking } : null;
    return block ? { type: 'assistant', message: { role: 'assistant', content: [block] } } : null;
  }
  if (event.type === 'assistant' || event.type === 'user') return event;
  return null;
}

export function grokCompletion(params: AcpObject, promptId: string, nativeV2 = false): AcpObject | null {
  const update = object(params.update);
  const result = update.sessionUpdate === 'turn_completed' ? update : params;
  if (Object.keys(update).length > 0 && update.sessionUpdate !== 'turn_completed'
    && !(nativeV2 && update.sessionUpdate === 'state_update' && update.state === 'idle')) return null;
  const id = result.prompt_id ?? result.promptId;
  if (id !== promptId) {
    if (!(nativeV2 && update.sessionUpdate === 'state_update' && update.state === 'idle')) return null;
  }
  return update.sessionUpdate === 'state_update' ? update : result;
}
