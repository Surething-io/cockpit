import { Effect } from 'effect';
import type { FSError } from '@cockpit/effect-core';
import type { ContextCategoryId, ContextItem, ContextNote, ContextSnapshot } from '../../shared/contextSnapshot';
import {
  asNumber, asRecord, categorize, estimateTokens, parseJsonLine, pushItem,
  readFirstLine, readLinesFromLastMatch, textItem,
} from './contextShared';

/**
 * Codex rollouts are an append log of exactly what the model is sent:
 * `response_item` lines are input items. The live context starts at the most
 * recent of two resets, and this rebuilds it from there — read backwards so a
 * 100 MB rollout costs only its tail:
 *  - a `compacted` line, whose `replacement_history` replaces every item before it;
 *  - a fresh context: Codex marks it with a `world_state` carrying `full: true`
 *    (incremental turns carry `full: false`), emitted AFTER that turn's initial
 *    instructions, so the context begins at the turn's `task_started`. Besides the
 *    session's first turn this is how an independent (noHistory) turn looks once
 *    Cockpit appends it back onto the stashed rollout (noHistoryRollout.ts) — with
 *    no other marker, every earlier turn would otherwise be counted as live.
 */

const ORDER: ContextCategoryId[] = ['system', 'instructions', 'memory', 'environment', 'tools', 'skills', 'summary', 'messages', 'tool_io', 'reasoning', 'other'];

/** Top-level record type. Records serialize `timestamp, ordinal, type, payload`, so the first "type" key is the record's. */
function recordType(line: string): string | undefined {
  return /"type":"([a-z_]+)"/.exec(line.slice(0, 240))?.[1];
}

/**
 * Start-of-context predicate for readLinesFromLastMatch, which calls it newest
 * line first: stop at a compaction, or — once a full world_state has been seen —
 * at the task_started that opened that turn. A compaction is followed by its own
 * full world_state, so meeting the compaction first still wins.
 */
function contextStart(): (line: string) => boolean {
  let sawFullState = false;
  return (line) => {
    const type = recordType(line);
    if (type === 'compacted') return true;
    const head = line.slice(0, 320);
    if (type === 'world_state' && head.includes('"full":true')) { sawFullState = true; return false; }
    return sawFullState && type === 'event_msg' && head.includes('"type":"task_started"');
  };
}

function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const rec = asRecord(part);
    if (!rec) return '';
    if (typeof rec.text === 'string') return rec.text;
    if (rec.type === 'input_image') return '[image]';
    return '';
  }).join('\n');
}

function developerCategory(text: string): { id: ContextCategoryId; label: string } {
  const head = text.trimStart();
  if (head.startsWith('You are Codex') || head.startsWith('<model_instructions>')) return { id: 'system', label: head.startsWith('<') ? 'model_instructions' : 'base instructions' };
  if (head.startsWith('<skills_instructions>')) return { id: 'skills', label: 'skills_instructions' };
  if (head.startsWith('<tools>') || head.startsWith('This is an incremental tools') || head.startsWith('The following tools are no l')) return { id: 'tools', label: 'tools update' };
  const tag = /^<([a-z_ ]+)>/.exec(head)?.[1];
  return { id: 'instructions', label: tag ?? head.slice(0, 48) };
}

interface Acc {
  buckets: Map<ContextCategoryId, ContextItem[]>;
  callNames: Map<string, string>;
  seq: number;
  hasEncryptedReasoning: boolean;
}

function addItem(acc: Acc, payload: Record<string, unknown>): void {
  const id = `i${acc.seq++}`;
  const type = payload.type;
  const push = (cat: ContextCategoryId, item: ContextItem) => pushItem(acc.buckets, cat, item);

  if (type === 'message') {
    const role = String(payload.role ?? '');
    const text = partsText(payload.content);
    if (role === 'developer' || role === 'system') {
      const { id: cat, label } = developerCategory(text);
      push(cat, textItem(id, label, text, 'markdown'));
      return;
    }
    if (role === 'user') {
      const head = text.trimStart();
      const agents = /^# AGENTS\.md instructions for (.+)/.exec(head);
      if (agents) { push('memory', textItem(id, `AGENTS.md · ${agents[1].trim()}`, text, 'markdown')); return; }
      if (head.startsWith('<environment_context>')) { push('environment', textItem(id, 'environment_context', text)); return; }
      push('messages', textItem(id, 'user', text, 'markdown'));
      return;
    }
    push('messages', textItem(id, role || 'message', text, 'markdown'));
    return;
  }
  if (type === 'additional_tools') {
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    for (const tool of tools) {
      const rec = asRecord(tool);
      push('tools', textItem(`${id}.${acc.seq++}`, String(rec?.name ?? 'tools'), JSON.stringify(tool, null, 2), 'json'));
    }
    return;
  }
  if (type === 'function_call' || type === 'custom_tool_call') {
    const name = [payload.namespace, payload.name].filter((p) => typeof p === 'string' && p).join('.') || 'tool';
    if (typeof payload.call_id === 'string') acc.callNames.set(payload.call_id, name);
    const body = typeof payload.arguments === 'string' ? payload.arguments : typeof payload.input === 'string' ? payload.input : JSON.stringify(payload);
    push('tool_io', textItem(id, `→ ${name}`, body, type === 'function_call' ? 'json' : 'text'));
    return;
  }
  if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const name = typeof payload.call_id === 'string' ? acc.callNames.get(payload.call_id) ?? 'tool' : 'tool';
    const output = typeof payload.output === 'string' ? payload.output : partsText(payload.output) || JSON.stringify(payload.output);
    push('tool_io', textItem(id, `← ${name}`, output));
    return;
  }
  if (type === 'reasoning') {
    const summary = partsText(payload.summary);
    if (typeof payload.encrypted_content === 'string' && payload.encrypted_content) acc.hasEncryptedReasoning = true;
    // Encrypted reasoning is opaque: show the summary if any, never guess its token cost.
    push('reasoning', { ...textItem(id, 'reasoning', summary || '[encrypted]'), tokens: summary ? estimateTokens(summary) : null });
    return;
  }
  if (type === 'compaction') {
    // Remote compaction keeps user turns verbatim and folds everything else into
    // one encrypted item; its plaintext never reaches the rollout.
    acc.hasEncryptedReasoning = true;
    push('summary', { id, label: 'compaction (encrypted)', tokens: null, content: '[encrypted]', format: 'text' });
    return;
  }
  if (type === 'agent_message') {
    push('messages', textItem(id, 'agent message', partsText(payload.content) || JSON.stringify(payload, null, 2), 'markdown'));
    return;
  }
  if (type === 'configuration_update') return;
  push('other', textItem(id, String(type ?? 'item'), JSON.stringify(payload, null, 2), 'json'));
}

export const buildCodexContext = (rolloutPath: string): Effect.Effect<ContextSnapshot, FSError> => Effect.gen(function* () {
  const lines = yield* readLinesFromLastMatch(rolloutPath, contextStart());
  const acc: Acc = { buckets: new Map(), callNames: new Map(), seq: 0, hasEncryptedReasoning: false };
  const notes: ContextNote[] = ['estimated_breakdown'];
  let model: string | undefined;
  let usedTokens: number | null = null;
  let contextWindow: number | null = null;
  let capturedAt: string | undefined;

  for (const line of lines) {
    const type = recordType(line);
    if (type !== 'compacted' && type !== 'response_item' && type !== 'turn_context' && type !== 'event_msg') continue;
    // event_msg lines are mostly streaming noise; only token_count matters.
    if (type === 'event_msg' && !line.includes('"type":"token_count"')) continue;
    const record = parseJsonLine(line);
    const payload = asRecord(record?.payload);
    if (!payload) continue;
    if (type === 'compacted') {
      notes.push('after_compaction');
      const history = Array.isArray(payload.replacement_history) ? payload.replacement_history : [];
      for (const entry of history) { const rec = asRecord(entry); if (rec) addItem(acc, rec); }
      if (typeof payload.message === 'string' && payload.message.trim()) {
        pushItem(acc.buckets, 'summary', textItem(`i${acc.seq++}`, 'compaction summary', payload.message, 'markdown'));
      }
    } else if (type === 'response_item') {
      addItem(acc, payload);
    } else if (type === 'turn_context') {
      if (typeof payload.model === 'string') model = payload.model;
    } else if (payload.type === 'token_count') {
      const info = asRecord(payload.info);
      const last = asRecord(info?.last_token_usage);
      const input = asNumber(last?.input_tokens);
      if (input !== undefined) {
        usedTokens = input + (asNumber(last?.output_tokens) ?? 0);
        capturedAt = typeof record?.timestamp === 'string' ? record.timestamp : capturedAt;
      }
      contextWindow = asNumber(info?.model_context_window) ?? contextWindow;
    }
  }

  // Base instructions travel as the request's `instructions` field, outside the
  // item list. Some history modes also echo them as the first developer message;
  // only add them when that echo is absent so they are not counted twice.
  const meta = asRecord(parseJsonLine((yield* readFirstLine(rolloutPath)) ?? '')?.payload);
  const base = asRecord(meta?.base_instructions)?.text ?? meta?.base_instructions;
  if (typeof base === 'string' && base.trim()) {
    const system = acc.buckets.get('system') ?? [];
    const echoed = system.some((item) => item.content?.slice(0, 200) === base.slice(0, 200));
    if (!echoed) acc.buckets.set('system', [textItem('base', 'base instructions', base, 'markdown'), ...system]);
  }
  if (acc.hasEncryptedReasoning) notes.push('reasoning_encrypted');
  if (usedTokens === null) notes.push('usage_unknown');

  return {
    engine: 'codex', model, usedTokens, contextWindow, capturedAt,
    categories: categorize(acc.buckets, ORDER),
    notes,
  };
}).pipe(Effect.withSpan('agent.context.codex'));
