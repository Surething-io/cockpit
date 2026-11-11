import { Effect } from 'effect';
import { readFile, stat } from 'node:fs/promises';
import type { FSError } from '@cockpit/effect-core';
import type { ContextCategory, ContextCategoryId, ContextItem, ContextNote, ContextSnapshot } from '../../shared/contextSnapshot';
import { asNumber, asRecord, categorize, MAX_ITEM_CONTENT, parseJsonLine, pushItem, readLinesFromLastMatch, textItem } from './contextShared';
import { readClaudeContextUsage, type StoredClaudeContextUsage } from './claudeContextStore';

/**
 * Claude Code's breakdown comes from two places:
 *  - the CLI's own `get_context_usage` answer, captured at the end of each turn
 *    (an exact total; per-category numbers, names and paths but no prompt text), and
 *  - the transcript, for the conversation itself: the parentUuid chain from the
 *    newest entry back to the last compact boundary is what gets resent.
 * File-backed items (memory files, skills, agents) are read from disk on demand.
 */

/**
 * Per-category numbers come from `get_context_usage` in `summary` mode, which the
 * SDK documents as local estimates; only the total is the provider's figure.
 * Measured against `full` on one session: identical total, but system tools 3,679
 * vs 146 and messages 9,158 vs 12,382. `full` costs ~2.3 s of token-count calls
 * per turn (a fresh CLI process each turn, so nothing is cached), so the split is
 * shown as an estimate instead.
 */
const CLI_SPLIT_EXACT = false;

const ORDER: ContextCategoryId[] = ['system', 'instructions', 'memory', 'tools', 'mcp', 'skills', 'agents', 'environment', 'summary', 'messages', 'tool_io', 'reasoning', 'other'];

const CLI_CATEGORY: Record<string, ContextCategoryId> = {
  system_prompt: 'system', system_tools: 'tools', mcp_tools: 'mcp', mcp_instructions: 'instructions',
  custom_agents: 'agents', memory_files: 'memory', skills: 'skills', messages: 'messages',
};
/** Rows that are not in the window (deferred schemas) or are not content (free space, compaction reserve). */
const NOT_CONTENT = new Set(['system_tools_deferred', 'mcp_tools_deferred', 'autocompact_buffer', 'compact_buffer', 'free_space']);

type Rec = Record<string, unknown>;

function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => {
    const rec = asRecord(b);
    if (rec?.type === 'text' && typeof rec.text === 'string') return rec.text;
    if (rec?.type === 'image') return '[image]';
    return '';
  }).filter(Boolean).join('\n');
}

/** Walk the active chain: newest conversational entry → parentUuid → … → the compact boundary (parentUuid null). */
function activeChain(lines: string[]): Rec[] {
  const byId = new Map<string, Rec>();
  let leaf: Rec | undefined;
  for (const line of lines) {
    const rec = parseJsonLine(line);
    if (!rec || typeof rec.uuid !== 'string' || rec.isSidechain === true) continue;
    byId.set(rec.uuid, rec);
    if (rec.type === 'user' || rec.type === 'assistant' || rec.type === 'attachment') leaf = rec;
  }
  const chain: Rec[] = [];
  const seen = new Set<string>();
  for (let cur = leaf; cur && typeof cur.uuid === 'string' && !seen.has(cur.uuid); cur = typeof cur.parentUuid === 'string' ? byId.get(cur.parentUuid) : undefined) {
    seen.add(cur.uuid);
    chain.push(cur);
  }
  return chain.reverse();
}

interface Transcript {
  buckets: Map<ContextCategoryId, ContextItem[]>;
  compacted: boolean;
  lastUsage?: { tokens: number; at?: string; model?: string };
}

function readTranscriptItems(chain: Rec[]): Transcript {
  const buckets = new Map<ContextCategoryId, ContextItem[]>();
  const toolNames = new Map<string, string>();
  let compacted = false;
  let lastUsage: Transcript['lastUsage'];
  chain.forEach((rec, i) => {
    const id = `t${i}`;
    if (rec.type === 'system' && rec.subtype === 'compact_boundary') { compacted = true; return; }
    if (rec.type === 'attachment') {
      const att = asRecord(rec.attachment);
      pushItem(buckets, 'messages', textItem(id, `attachment · ${String(att?.type ?? '?')}`, JSON.stringify(att ?? {}, null, 2), 'json'));
      return;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') return;
    const message = asRecord(rec.message);
    if (!message) return;
    if (rec.isCompactSummary === true) {
      pushItem(buckets, 'summary', textItem(id, 'compaction summary', blocksText(message.content), 'markdown'));
      return;
    }
    const content = message.content;
    if (typeof content === 'string') {
      pushItem(buckets, 'messages', textItem(id, rec.type as string, content, 'markdown'));
    } else if (Array.isArray(content)) {
      const text = blocksText(content);
      if (text.trim()) pushItem(buckets, 'messages', textItem(id, rec.type as string, text, 'markdown'));
      content.forEach((block, j) => {
        const b = asRecord(block);
        if (!b) return;
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          pushItem(buckets, 'reasoning', textItem(`${id}.${j}`, 'thinking', b.thinking));
        } else if (b.type === 'redacted_thinking') {
          pushItem(buckets, 'reasoning', { id: `${id}.${j}`, label: 'thinking (redacted)', tokens: null, content: '[redacted]', format: 'text' });
        } else if (b.type === 'tool_use') {
          const name = String(b.name ?? 'tool');
          if (typeof b.id === 'string') toolNames.set(b.id, name);
          pushItem(buckets, 'tool_io', textItem(`${id}.${j}`, `→ ${name}`, JSON.stringify(b.input ?? {}, null, 2), 'json'));
        } else if (b.type === 'tool_result') {
          const name = typeof b.tool_use_id === 'string' ? toolNames.get(b.tool_use_id) ?? 'tool' : 'tool';
          pushItem(buckets, 'tool_io', textItem(`${id}.${j}`, `← ${name}${b.is_error ? ' (error)' : ''}`, blocksText(b.content)));
        }
      });
    }
    const usage = asRecord(message.usage);
    if (rec.type === 'assistant' && usage) {
      const tokens = (asNumber(usage.input_tokens) ?? 0) + (asNumber(usage.cache_read_input_tokens) ?? 0)
        + (asNumber(usage.cache_creation_input_tokens) ?? 0) + (asNumber(usage.output_tokens) ?? 0);
      if (tokens > 0) lastUsage = { tokens, at: typeof rec.timestamp === 'string' ? rec.timestamp : undefined, model: typeof message.model === 'string' ? message.model : undefined };
    }
  });
  return { buckets, compacted, lastUsage };
}

/** Current on-disk text of a file the CLI reported; bounded, and absent rather than failing. */
async function fileText(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    if ((await stat(path)).size > MAX_ITEM_CONTENT * 4) return undefined;
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Only a skill's frontmatter (name + description) sits in context until the skill is invoked. */
function frontmatter(text: string): string {
  const m = /^---\n[\s\S]*?\n---/.exec(text);
  return m ? m[0] : text.slice(0, 600);
}

const fileItem = async (id: string, label: string, tokens: number, path: string | undefined, transform?: (t: string) => string): Promise<ContextItem> => {
  const text = await fileText(path);
  if (text === undefined) return { id, label, tokens, exact: CLI_SPLIT_EXACT, ...(path ? { path } : {}) };
  const shown = transform ? transform(text) : text;
  return { ...textItem(id, label, shown, 'markdown', path ? { path } : undefined), tokens, exact: CLI_SPLIT_EXACT };
};

async function cliCategories(stored: StoredClaudeContextUsage, transcript: Transcript): Promise<ContextCategory[]> {
  const u = stored.usage;
  const out: ContextCategory[] = [];
  for (const row of u.categories) {
    const rowId = row.id;
    if (row.kind && row.kind !== 'used') continue;
    if (rowId && NOT_CONTENT.has(rowId)) continue;
    if (row.isDeferred) continue;
    const cat: ContextCategoryId = (rowId && CLI_CATEGORY[rowId]) || 'other';
    const base: ContextCategory = { id: cat, name: row.name, tokens: row.tokens, exact: CLI_SPLIT_EXACT, items: [] };
    switch (rowId) {
      case 'system_prompt':
        base.items = (u.systemPromptSections ?? []).map((s, i) => ({ id: `sp${i}`, label: s.name, tokens: s.tokens, exact: CLI_SPLIT_EXACT }));
        break;
      case 'system_tools':
        base.items = (u.systemTools ?? []).map((t, i) => ({ id: `st${i}`, label: t.name, tokens: t.tokens, exact: CLI_SPLIT_EXACT }));
        break;
      case 'mcp_tools':
        base.items = u.mcpTools.filter((t) => t.isLoaded !== false).map((t, i) => ({ id: `mt${i}`, label: t.name, tokens: t.tokens, exact: CLI_SPLIT_EXACT }));
        break;
      case 'mcp_instructions':
        base.items = (u.mcpInstructions ?? []).map((m, i) => ({ id: `mi${i}`, label: m.serverName, tokens: m.tokens, exact: CLI_SPLIT_EXACT }));
        break;
      case 'memory_files':
        base.items = await Promise.all(u.memoryFiles.map((f, i) => fileItem(`mf${i}`, `${f.type} · ${f.path}`, f.tokens, f.path)));
        break;
      case 'custom_agents':
        base.items = await Promise.all(u.agents.map((a, i) => fileItem(`ag${i}`, a.agentType, a.tokens, a.path)));
        break;
      case 'skills':
        base.items = await Promise.all((u.skills?.skillFrontmatter ?? []).map((s, i) => fileItem(`sk${i}`, s.pluginName ? `${s.pluginName}:${s.name}` : s.name, s.tokens, s.path, frontmatter)));
        break;
      case 'messages': {
        // Exact row total from the CLI; items are the transcript's, estimated individually.
        const tools = transcript.buckets.get('tool_io') ?? [];
        const rest = ORDER.filter((id) => id !== 'tool_io').flatMap((id) => transcript.buckets.get(id) ?? []);
        const mb = u.messageBreakdown;
        if (mb) {
          const toolTokens = mb.toolCallTokens + mb.toolResultTokens;
          out.push({ ...base, tokens: Math.max(0, row.tokens - toolTokens), items: rest });
          out.push({ id: 'tool_io', tokens: toolTokens, exact: CLI_SPLIT_EXACT, items: tools });
          continue;
        }
        base.items = [...rest, ...tools];
        break;
      }
    }
    out.push(base);
  }
  // The CLI emits zero-token rows (and a turn without tools leaves tool_io empty); hide them.
  return out.filter((c) => c.tokens > 0 || c.items.length > 0);
}

export const buildClaudeContext = (cwd: string, sessionId: string, transcriptPath: string): Effect.Effect<ContextSnapshot, FSError> => Effect.gen(function* () {
  const lines = yield* readLinesFromLastMatch(transcriptPath, (line) => line.slice(0, 400).includes('"subtype":"compact_boundary"'));
  const transcript = readTranscriptItems(activeChain(lines));
  const stored = yield* readClaudeContextUsage(cwd, sessionId);
  const notes: ContextNote[] = [];
  if (transcript.compacted) notes.push('after_compaction');
  // Claude Code assembles its system prompt inside the CLI and never persists the
  // text. (The CLI's `api-request-blob` journal looks like it might hold it, but its
  // system-role entries are mid-conversation system messages — e.g. repeated
  // "# Environment update" notes — not the top-level prompt; they already appear
  // here as transcript attachments.)
  notes.push('system_prompt_hidden');

  if (!stored) {
    notes.push('no_snapshot_yet', 'estimated_breakdown');
    if (!transcript.lastUsage) notes.push('usage_unknown');
    return {
      engine: 'claude', model: transcript.lastUsage?.model,
      usedTokens: transcript.lastUsage?.tokens ?? null, contextWindow: null, capturedAt: transcript.lastUsage?.at,
      categories: categorize(transcript.buckets, ORDER), notes,
    };
  }
  notes.push('snapshot_from_last_turn', 'estimated_breakdown', 'tool_schemas_hidden', 'skills_listing_only');
  const categories = yield* Effect.promise(() => cliCategories(stored, transcript));
  return {
    engine: 'claude', model: stored.usage.model,
    usedTokens: stored.usage.totalTokens, contextWindow: stored.usage.rawMaxTokens, capturedAt: stored.capturedAt,
    categories, notes,
  };
}).pipe(Effect.withSpan('agent.context.claude'));
