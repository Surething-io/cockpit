import { Effect } from 'effect';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { FSError } from '@cockpit/effect-core';
import {
  GROK_INDEPENDENT_CONTEXT_FILE, GROK_INDEPENDENT_MARKER, grokNativeSessionPath, isGrokPreamble,
} from '../../effect/grokNativeSessionLive';
import type { AcpObject } from '../engines/grokAcp/client';
import { grokSessionPath } from '../../effect/grokSessionLive';
import type { ContextCategoryId, ContextItem, ContextNote, ContextSnapshot } from '../../shared/contextSnapshot';
import { asNumber, asRecord, categorize, estimateTokens, parseJsonLine, pushItem, readLinesFromLastMatch, textItem } from './contextShared';

/**
 * Grok's native session directory holds the model context verbatim:
 * `chat_history.jsonl` is the message list sent to the model (system prompt
 * first), `tool_definitions.json` the declared tools, `prompt_context.json`
 * the AGENTS.md-style files folded into the system prompt, and
 * `signals.json` Grok's counters. Its `contextTokensUsed` is NOT the main
 * request's size (observed 1,419 against a 21,908-token request, attributed to
 * a different model), so the size comes from Cockpit's own display transcript,
 * which records each model response's usage; signals only supply the window.
 *
 * Independent (noHistory) turns run in a temporary native branch holding only
 * the session preamble and are then merged back (grokNativeSessionLive.ts), so:
 *  - while one runs, the live context is that branch, not this directory;
 *  - right after the merge, the last request carried only the preamble plus that
 *    turn — the merge records where the turn starts and its usage counters, valid
 *    until any later turn or edit changes the history length.
 */

const ORDER: ContextCategoryId[] = ['system', 'instructions', 'memory', 'tools', 'environment', 'summary', 'messages', 'tool_io', 'reasoning', 'other'];

type Rec = Record<string, unknown>;

const readOptional = (path: string): Effect.Effect<string | null, FSError> => Effect.tryPromise({
  try: async () => {
    try { return await readFile(path, 'utf8'); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  },
  catch: (cause) => new FSError({ path, op: 'read', cause }),
});

const mtime = (path: string): Effect.Effect<string | undefined> => Effect.promise(async () => {
  try { return (await stat(path)).mtime.toISOString(); } catch { return undefined; }
});

const parseJson = (text: string | null): unknown => {
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
};

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => {
    const rec = asRecord(p);
    if (typeof rec?.text === 'string') return rec.text;
    if (rec?.type === 'image' || rec?.type === 'image_url') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

/** The chat items of the last request, and the counters that describe it. */
function liveHistory(history: string | null, independent: unknown, signals: string | null): { items: Array<Rec | null>; signals: unknown; independent: boolean } {
  const items = (history ?? '').split('\n').filter((line) => line.trim()).map((line) => parseJsonLine(line));
  const record = asRecord(independent);
  const start = asNumber(record?.start);
  if (start === undefined || asNumber(record?.length) !== items.length) return { items, signals: parseJson(signals), independent: false };
  // Keep line positions stable (item ids) by blanking, not removing, excluded items.
  return {
    items: items.map((item, i) => i >= start || (item && isGrokPreamble(item as AcpObject)) ? item : null),
    signals: record?.signals ?? parseJson(signals),
    independent: true,
  };
}

interface LastRequest { tokens: number; model?: string; at?: string }

/** Usage of the newest model response in Cockpit's Grok transcript: the last request's real size. */
const lastRequest = (cwd: string, sessionId: string): Effect.Effect<LastRequest | null> => {
  let found: LastRequest | null = null;
  return readLinesFromLastMatch(grokSessionPath(cwd, sessionId), (line) => {
    if (!line.includes('"usage"')) return false;
    const rec = parseJsonLine(line);
    const message = asRecord(rec?.message);
    const usage = asRecord(message?.usage);
    if (rec?.type !== 'assistant' || !usage) return false;
    const tokens = (asNumber(usage.input_tokens) ?? 0) + (asNumber(usage.cache_read_input_tokens) ?? 0)
      + (asNumber(usage.cache_creation_input_tokens) ?? 0) + (asNumber(usage.output_tokens) ?? 0);
    if (tokens <= 0) return false;
    found = { tokens, model: typeof message?.model === 'string' ? message.model : undefined, at: typeof rec.timestamp === 'string' ? rec.timestamp : undefined };
    return true;
  }).pipe(Effect.map(() => found), Effect.catchAll(() => Effect.succeed(null)));
};

export const buildGrokContext = (cwd: string, sessionId: string): Effect.Effect<ContextSnapshot, FSError> => Effect.gen(function* () {
  const home = grokNativeSessionPath(cwd, sessionId);
  // An independent turn in flight: its temporary branch is what is on the wire.
  const branchId = asRecord(parseJson(yield* readOptional(join(home, GROK_INDEPENDENT_MARKER))))?.sessionId;
  const dir = typeof branchId === 'string' && /^[a-zA-Z0-9_-]+$/.test(branchId) ? grokNativeSessionPath(cwd, branchId) : home;
  const [history, tools, promptContext, signalsText, independent] = yield* Effect.all([
    readOptional(join(dir, 'chat_history.jsonl')),
    readOptional(join(dir, 'tool_definitions.json')),
    readOptional(join(dir, 'prompt_context.json')),
    readOptional(join(dir, 'signals.json')),
    dir === home ? readOptional(join(dir, GROK_INDEPENDENT_CONTEXT_FILE)) : Effect.succeed(null),
  ]);
  const live = liveHistory(history, parseJson(independent), signalsText);
  const buckets = new Map<ContextCategoryId, ContextItem[]>();
  const notes: ContextNote[] = ['estimated_breakdown'];

  const memoryFiles = (asRecord(parseJson(promptContext))?.agents_md_files as unknown[] | undefined ?? [])
    .map((f) => asRecord(f))
    .filter((f): f is Rec => typeof f?.content === 'string' && (f.content as string).length > 0);

  // Memory files ride inside the system prompt or a harness-authored user message;
  // carve them out so each is its own item and is not counted twice.
  const carved = new Set<number>();
  const carveMemory = (text: string, id: string): string => {
    memoryFiles.forEach((file, j) => {
      const body = file.content as string;
      if (carved.has(j) || !text.includes(body)) return;
      carved.add(j);
      const path = String(file.file_path ?? file.file_name ?? `memory ${j}`);
      text = text.replace(body, `[→ ${path}]`);
      pushItem(buckets, 'memory', textItem(`${id}.m${j}`, path, body, 'markdown', { path }));
    });
    return text;
  };
  const toolNames = new Map<string, string>();
  let encrypted = false;
  live.items.forEach((rec, i) => {
    if (!rec) return;
    const id = `h${i}`;
    switch (rec.type) {
      case 'system':
        pushItem(buckets, 'system', textItem(id, 'system prompt', carveMemory(contentText(rec.content), id), 'markdown'));
        break;
      case 'user': {
        const raw = contentText(rec.content);
        const head = raw.trimStart();
        // Harness-authored user messages (user_info, reminders) may carry memory files.
        const text = rec.synthetic_reason || head.startsWith('<user_info>') ? carveMemory(raw, id) : raw;
        if (rec.synthetic_reason === 'system_reminder') pushItem(buckets, 'instructions', textItem(id, 'system reminder', text, 'markdown'));
        else if (head.startsWith('<user_info>')) pushItem(buckets, 'environment', textItem(id, 'user_info', text));
        else if (rec.synthetic_reason) pushItem(buckets, 'instructions', textItem(id, String(rec.synthetic_reason), text, 'markdown'));
        else pushItem(buckets, 'messages', textItem(id, 'user', text, 'markdown'));
        break;
      }
      case 'assistant': {
        const text = contentText(rec.content);
        if (text.trim()) pushItem(buckets, 'messages', textItem(id, 'assistant', text, 'markdown'));
        const calls = Array.isArray(rec.tool_calls) ? rec.tool_calls : [];
        calls.forEach((call, j) => {
          const c = asRecord(call);
          const fn = asRecord(c?.function);
          const name = String(c?.name ?? fn?.name ?? 'tool');
          if (typeof c?.id === 'string') toolNames.set(c.id, name);
          const args = c?.arguments ?? fn?.arguments ?? {};
          pushItem(buckets, 'tool_io', textItem(`${id}.c${j}`, `→ ${name}`, typeof args === 'string' ? args : JSON.stringify(args, null, 2), 'json'));
        });
        break;
      }
      case 'tool_result': {
        const name = typeof rec.tool_call_id === 'string' ? toolNames.get(rec.tool_call_id) ?? 'tool' : 'tool';
        pushItem(buckets, 'tool_io', textItem(id, `← ${name}`, contentText(rec.content)));
        break;
      }
      case 'reasoning': {
        const summary = contentText(rec.summary);
        if (typeof rec.encrypted_content === 'string' && rec.encrypted_content) encrypted = true;
        pushItem(buckets, 'reasoning', { ...textItem(id, 'reasoning', summary || '[encrypted]'), tokens: summary ? estimateTokens(summary) : null });
        break;
      }
      default:
        pushItem(buckets, 'other', textItem(id, String(rec.type ?? 'item'), JSON.stringify(rec, null, 2), 'json'));
    }
  });

  const toolList = parseJson(tools);
  if (Array.isArray(toolList)) toolList.forEach((tool, i) => {
    const rec = asRecord(tool);
    const name = String(asRecord(rec?.function)?.name ?? rec?.name ?? `tool ${i}`);
    pushItem(buckets, 'tools', textItem(`tool${i}`, name, JSON.stringify(tool, null, 2), 'json'));
  });

  if (encrypted) notes.push('reasoning_encrypted');
  const sig = asRecord(live.signals);
  const last = yield* lastRequest(cwd, sessionId);
  const usedTokens = last?.tokens ?? asNumber(sig?.contextTokensUsed) ?? null;
  if (usedTokens === null) notes.push('usage_unknown');
  if (history === null) notes.push('no_snapshot_yet');
  return {
    engine: 'grok',
    model: last?.model ?? (typeof sig?.primaryModelId === 'string' ? sig.primaryModelId : undefined),
    usedTokens,
    contextWindow: asNumber(sig?.contextWindowTokens) ?? null,
    capturedAt: last?.at ?? (yield* mtime(join(dir, live.independent ? GROK_INDEPENDENT_CONTEXT_FILE : 'signals.json'))),
    categories: categorize(buckets, ORDER),
    notes,
  };
}).pipe(Effect.withSpan('agent.context.grok'));
