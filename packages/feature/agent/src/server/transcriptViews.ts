/**
 * Views over TranscriptIndex snapshots — pure, O(turns), never O(bytes).
 *
 * Each consumer historically parsed transcripts with its own filtering rules, and
 * those rules are user-visible (which messages a card shows, what a title says),
 * so they are kept per view rather than unified:
 *
 *   previewMessages — recent-sessions cards + search corpus (state/globalState.ts)
 *   titleMessages   — run-teardown title (getSessionTitle)
 *   listMessages    — per-project session list (api/sessions/project-encoded.ts)
 *   mergeStats      — token usage dashboard (api/claude-stats.ts)
 */
import type { CodexSessionEntry, TranscriptSnapshot, TranscriptStats, TranscriptModelUsage } from '@cockpit/effect-services';
import { generateCodexTitle, generateTitle } from './sessionTitle';
import { codexPromptText } from '../shared/codexPrompt';
import { stripDecisionContext } from '../shared/decisionContext';

/**
 * Dictionaries keyed by transcript content (session ids, model names, dates) must never
 * touch the prototype chain: a key like "__proto__" or "constructor" would otherwise
 * read an inherited value and, on write, mutate Object.prototype for the whole process.
 * `getOwn` reads own properties only; `setOwn` defines rather than assigns, so any key
 * is just data — also on objects JSON.parse rebuilt from a persisted shard.
 */
export function getOwn<T>(dict: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

export function setOwn<T>(dict: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

/**
 * True for a rollout codex wrote for a sub-agent it spawned. Tested on presence, not
 * truthiness: `parentThreadId` is '' when a rollout is flagged `thread_source:
 * "subagent"` without naming its parent. Session lists exclude these — they share
 * their parent's directory and cwd, and are reached from its Task bubble instead.
 */
export function isCodexSubagent(entry: CodexSessionEntry): boolean {
  return entry.parentThreadId !== undefined;
}

/** Strip <command-*> / <local-command-*> tags and their content. */
export function filterCommandTags(text: string): string {
  // Decision-mode context is Cockpit's own preamble, never the user's words.
  let filtered = stripDecisionContext(text).replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '');
  filtered = filtered.replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '');
  return filtered.trim();
}

/** False for SDK-injected context and empty text. */
export function isValidUserMessage(text: string): boolean {
  if (text.startsWith('This session is being continued')) return false;
  if (text.startsWith('Caveat: The messages below')) return false;
  if (!text.trim()) return false;
  return true;
}

/** Human turns, command tags stripped, injected context dropped. */
export function previewMessages(snap: Pick<TranscriptSnapshot, 'format' | 'userTurns'>): string[] {
  const out: string[] = [];
  for (const turn of snap.userTurns) {
    if (turn.isMeta) continue;
    let text: string;
    if (snap.format === 'codex') {
      const prompt = codexPromptText(turn.listText ?? turn.blocks.join(''), turn.images);
      if (prompt === null) continue;
      out.push(prompt);
      continue;
    } else {
      text = turn.blocks.find((b) => b) ?? '';
      if (!text) continue;
    }
    const filtered = filterCommandTags(text);
    if (filtered && isValidUserMessage(filtered)) out.push(filtered);
  }
  return out;
}

/** Human text blocks for title generation, retaining command markup for generateTitle. */
export function titleMessages(snap: Pick<TranscriptSnapshot, 'userTurns'>): string[] {
  return snap.userTurns.filter((turn) => !turn.isMeta).flatMap((turn) => turn.blocks.filter((b) => b));
}

/** Codex has no title line: its first real prompt, clipped. */
export function codexTitle(snap: Pick<TranscriptSnapshot, 'userTurns'>): string | undefined {
  for (const turn of snap.userTurns) {
    const text = codexPromptText(turn.listText ?? turn.blocks.join(''), turn.images);
    if (text === null) continue;
    return generateCodexTitle(text);
  }
  return undefined;
}

/** Native fallback shared by title metadata, session lists, previews and search. */
export function defaultSessionTitle(snap: Pick<TranscriptSnapshot, 'format' | 'aiTitle' | 'summary' | 'userTurns'>): string {
  return snap.format === 'codex'
    ? codexTitle(snap) || 'Untitled Session'
    : generateTitle(snap.aiTitle, snap.summary, titleMessages(snap));
}

/** Session-list rows: meta lines skipped, all text blocks joined, image-only codex turns kept. */
export function listMessages(snap: Pick<TranscriptSnapshot, 'format' | 'userTurns'>): string[] {
  const out: string[] = [];
  for (const turn of snap.userTurns) {
    if (snap.format === 'codex') {
      const text = codexPromptText(turn.listText ?? '', turn.images);
      if (text === null) continue;
      out.push(text);
      continue;
    }
    if (turn.isMeta) continue;
    const text = turn.blocks.join(' ');
    if (text) out.push(text);
  }
  return out;
}

export interface ClaudeStatsResponse {
  modelUsage: Record<string, TranscriptModelUsage>;
  dailyActivity: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>;
  dailyModelTokens: Array<{ date: string; tokensByModel: Record<string, number> }>;
  hourCounts: Record<string, number>;
  totalSessions: number;
  totalMessages: number;
  longestSession?: { sessionId: string; duration: number };
  firstSessionDate?: string;
}

/** Combine per-file usage aggregates into the /api/claude-stats response. */
export function mergeStats(all: ReadonlyArray<TranscriptStats>): ClaudeStatsResponse {
  const modelUsage: Record<string, TranscriptModelUsage> = {};
  const daily = new Map<string, { messages: number; sessions: Set<string>; toolCalls: number }>();
  const dailyTokens = new Map<string, Record<string, number>>();
  const hourCounts: Record<string, number> = {};
  const sessionIds = new Set<string>();
  const sessionTimes = new Map<string, { start: number; end: number }>();
  let totalMessages = 0;
  let firstSessionDate = '';

  for (const s of all) {
    totalMessages += s.messages;
    if (s.firstDate && (!firstSessionDate || s.firstDate < firstSessionDate)) firstSessionDate = s.firstDate;
    for (const id of Object.keys(s.sessionIds)) sessionIds.add(id);
    for (const [id, t] of Object.entries(s.sessionTimes)) {
      const cur = sessionTimes.get(id);
      if (!cur) sessionTimes.set(id, { ...t });
      else {
        if (t.start < cur.start) cur.start = t.start;
        if (t.end > cur.end) cur.end = t.end;
      }
    }
    for (const [h, n] of Object.entries(s.hourCounts)) setOwn(hourCounts, h, (getOwn(hourCounts, h) || 0) + n);
    for (const [date, d] of Object.entries(s.daily)) {
      const cur = daily.get(date) ?? { messages: 0, sessions: new Set<string>(), toolCalls: 0 };
      cur.messages += d.messages;
      cur.toolCalls += d.toolCalls;
      for (const id of Object.keys(d.sessions)) cur.sessions.add(id);
      daily.set(date, cur);
    }
    for (const [date, byModel] of Object.entries(s.dailyTokens)) {
      const cur = dailyTokens.get(date) ?? {};
      for (const [model, n] of Object.entries(byModel)) setOwn(cur, model, (getOwn(cur, model) || 0) + n);
      dailyTokens.set(date, cur);
    }
    for (const [model, u] of Object.entries(s.modelUsage)) {
      const cur =
        getOwn(modelUsage, model) ??
        setOwn(modelUsage, model, {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
        });
      cur.inputTokens += u.inputTokens;
      cur.outputTokens += u.outputTokens;
      cur.cacheReadInputTokens += u.cacheReadInputTokens;
      cur.cacheCreationInputTokens += u.cacheCreationInputTokens;
      cur.webSearchRequests += u.webSearchRequests;
    }
  }

  let longestDuration = 0;
  let longestSessionId = '';
  for (const [sid, t] of sessionTimes) {
    const dur = t.end - t.start;
    if (dur > longestDuration) {
      longestDuration = dur;
      longestSessionId = sid;
    }
  }

  return {
    modelUsage,
    dailyActivity: Array.from(daily.entries())
      .map(([date, d]) => ({ date, messageCount: d.messages, sessionCount: d.sessions.size, toolCallCount: d.toolCalls }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    dailyModelTokens: Array.from(dailyTokens.entries())
      .map(([date, tokensByModel]) => ({ date, tokensByModel }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    hourCounts,
    totalSessions: sessionIds.size,
    totalMessages,
    longestSession: longestDuration > 0 ? { sessionId: longestSessionId, duration: longestDuration } : undefined,
    firstSessionDate: firstSessionDate || undefined,
  };
}
