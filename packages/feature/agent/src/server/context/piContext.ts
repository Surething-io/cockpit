import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import { isPiEngine } from '@cockpit/shared-utils';
import { readPiEntries, piSelection } from '../../effect/piSessionLive';
import { PI_MODEL_ALIASES, PI_MODEL_CAPABILITIES } from '../engines/shared/piModelCapabilities';
import type { ContextCategoryId, ContextItem, ContextNote, ContextSnapshot } from '../../shared/contextSnapshot';
import { asNumber, asRecord, categorize, pushItem, textItem } from './contextShared';

/**
 * Pi persists the model's context natively: system prompts are `role: system`
 * messages with named sections and `toolsAdded` schemas, and compaction is an
 * entry `buildSessionContext()` already resolves. So the active branch IS what
 * the next request sends; nothing has to be captured at run time.
 */

const ORDER: ContextCategoryId[] = ['system', 'memory', 'tools', 'skills', 'environment', 'summary', 'messages', 'tool_io', 'reasoning', 'other'];

type Msg = Record<string, unknown>;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const rec = asRecord(part);
    if (!rec) return '';
    if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
    if (rec.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

const SECTION_CATEGORY: Record<string, ContextCategoryId> = { skills: 'skills', cwd: 'environment' };

function addSystem(buckets: Map<ContextCategoryId, ContextItem[]>, msg: Msg, index: number): void {
  const prefix = index === 0 ? '' : 'update · ';
  const base = contentText(msg.content);
  if (base.trim()) pushItem(buckets, 'system', textItem(`s${index}.content`, `${prefix}${index === 0 ? 'base' : 'instructions'}`, base, 'markdown'));
  const sections = asRecord(msg.sections) ?? {};
  for (const [name, value] of Object.entries(sections)) {
    if (typeof value !== 'string') continue;
    if (name === 'project_context') {
      // One item per memory file so each can be opened on its own.
      const files = [...value.matchAll(/<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g)];
      if (files.length) {
        files.forEach((m, i) => pushItem(buckets, 'memory', textItem(`s${index}.ctx${i}`, `${prefix}${m[1]}`, m[2], 'markdown', { path: m[1] })));
        continue;
      }
    }
    const cat = name === 'project_context' ? 'memory' : SECTION_CATEGORY[name] ?? 'system';
    pushItem(buckets, cat, textItem(`s${index}.${name}`, `${prefix}${name}`, value, 'markdown'));
  }
  const tools = Array.isArray(msg.toolsAdded) ? msg.toolsAdded : [];
  tools.forEach((tool, i) => {
    const name = String(asRecord(tool)?.name ?? `tool ${i}`);
    pushItem(buckets, 'tools', textItem(`s${index}.tool${i}`, `${prefix}${name}`, JSON.stringify(tool, null, 2), 'json'));
  });
  const removed = Array.isArray(msg.toolsRemoved) ? msg.toolsRemoved : [];
  if (removed.length) {
    const names = new Set(removed.map((ref) => String(asRecord(ref)?.name ?? ref)));
    buckets.set('tools', (buckets.get('tools') ?? []).filter((item) => !names.has(item.label.replace(/^update · /, ''))));
  }
}

export function piContextFromMessages(messages: Msg[], engine: string, model: string | undefined): Omit<ContextSnapshot, 'capturedAt'> & { capturedAt?: string } {
  const buckets = new Map<ContextCategoryId, ContextItem[]>();
  const notes: ContextNote[] = ['estimated_breakdown'];
  let systemIndex = 0;
  let usedTokens: number | null = null;
  let capturedAt: string | undefined;

  messages.forEach((msg, i) => {
    const id = `m${i}`;
    switch (msg.role) {
      case 'system':
        addSystem(buckets, msg, systemIndex++);
        break;
      case 'user':
        pushItem(buckets, 'messages', textItem(id, 'user', contentText(msg.content), 'markdown'));
        break;
      case 'assistant': {
        const parts = Array.isArray(msg.content) ? msg.content : [];
        const text = parts.map((p) => asRecord(p)).filter((p) => p?.type === 'text').map((p) => String(p!.text ?? '')).join('\n');
        if (text.trim()) pushItem(buckets, 'messages', textItem(id, 'assistant', text, 'markdown'));
        parts.forEach((part, j) => {
          const rec = asRecord(part);
          if (rec?.type === 'thinking' && typeof rec.thinking === 'string' && rec.thinking) {
            pushItem(buckets, 'reasoning', textItem(`${id}.t${j}`, rec.redacted ? 'thinking (redacted)' : 'thinking', rec.thinking));
          } else if (rec?.type === 'toolCall') {
            pushItem(buckets, 'tool_io', textItem(`${id}.c${j}`, `→ ${String(rec.name ?? 'tool')}`, JSON.stringify(rec.arguments ?? {}, null, 2), 'json'));
          }
        });
        const usage = asRecord(msg.usage);
        const input = asNumber(usage?.input);
        // Same formula Pi's own footer uses: the whole prompt plus this reply.
        // Failed or aborted replies carry all-zero usage and say nothing about size.
        const total = (input ?? 0) + (asNumber(usage?.cacheRead) ?? 0) + (asNumber(usage?.cacheWrite) ?? 0) + (asNumber(usage?.output) ?? 0);
        if (total > 0) {
          usedTokens = total;
          const ts = asNumber(msg.timestamp);
          capturedAt = ts ? new Date(ts).toISOString() : capturedAt;
        }
        break;
      }
      case 'toolResult':
        pushItem(buckets, 'tool_io', textItem(id, `← ${String(msg.toolName ?? 'tool')}${msg.isError ? ' (error)' : ''}`, contentText(msg.content)));
        break;
      case 'compactionSummary':
        notes.push('after_compaction');
        pushItem(buckets, 'summary', textItem(id, 'compaction summary', String(msg.summary ?? ''), 'markdown'));
        break;
      case 'branchSummary':
        pushItem(buckets, 'summary', textItem(id, 'branch summary', String(msg.summary ?? ''), 'markdown'));
        break;
      case 'bashExecution':
        if (msg.excludeFromContext) break;
        pushItem(buckets, 'tool_io', textItem(id, `! ${String(msg.command ?? '')}`.slice(0, 80), `$ ${String(msg.command ?? '')}\n${String(msg.output ?? '')}`));
        break;
      case 'custom':
        pushItem(buckets, 'other', textItem(id, String(msg.customType ?? 'custom'), contentText(msg.content), 'markdown'));
        break;
      default:
        pushItem(buckets, 'other', textItem(id, String(msg.role ?? 'message'), JSON.stringify(msg, null, 2), 'json'));
    }
  });

  if (usedTokens === null) notes.push('usage_unknown');
  const caps = isPiEngine(engine) && model
    ? PI_MODEL_CAPABILITIES[engine]?.[PI_MODEL_ALIASES[engine]?.[model] ?? model]
    : undefined;
  return {
    engine, model, usedTokens, contextWindow: caps?.contextWindow ?? null, capturedAt,
    categories: categorize(buckets, ORDER),
    notes,
  };
}

export const buildPiContext = (sessionPath: string): Effect.Effect<ContextSnapshot, AppError> => Effect.gen(function* () {
  const { entries, header } = yield* readPiEntries(sessionPath);
  const messages = yield* Effect.tryPromise({
    try: async () => {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      // In-memory: building context from a native file must never migrate it on disk.
      return SessionManager.inMemory(header.cwd, undefined, entries).buildSessionContext().messages as unknown as Msg[];
    },
    catch: (cause) => new AppError({ message: `Cannot build Pi context for ${sessionPath}`, cause }),
  });
  const { engine, model } = piSelection(entries.filter((entry) => entry.type !== 'session') as Parameters<typeof piSelection>[0]);
  return piContextFromMessages(messages, engine, model);
}).pipe(Effect.withSpan('agent.context.pi'));
