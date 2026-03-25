import { readFile, readdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { CLAUDE_DIR, COCKPIT_DIR, ensureDir } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const CACHE_FILE = join(COCKPIT_DIR, 'stats-cache.json');
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
}

interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

function emptyUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0 };
}

/**
 * Scan all session JSONL files under ~/.claude/projects and aggregate token usage in real time.
 */
async function scanSessions() {
  const modelUsage: Record<string, ModelUsage> = {};
  // date → { messages, sessions: Set<sessionId>, toolCalls }
  const dailyMap = new Map<string, { messages: number; sessions: Set<string>; toolCalls: number }>();
  // date → model → tokens
  const dailyTokenMap = new Map<string, Record<string, number>>();
  // hour → count
  const hourCounts: Record<string, number> = {};
  let totalMessages = 0;
  let totalSessions = 0;
  let firstSessionDate = '';
  const sessionIds = new Set<string>();
  // longest session tracking: sessionId → { start, end }
  const sessionTimes = new Map<string, { start: number; end: number }>();

  // List project dirs
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return null;
  }

  for (const projDir of projectDirs) {
    const projPath = join(PROJECTS_DIR, projDir);
    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      // Skip subagent files in subdirs — we only read top-level JSONL
      const filePath = join(projPath, file);

      try {
        await processJSONL(filePath, {
          modelUsage, dailyMap, dailyTokenMap, hourCounts,
          sessionIds, sessionTimes,
          onMessage: () => { totalMessages++; },
          onFirstDate: (date) => {
            if (!firstSessionDate || date < firstSessionDate) firstSessionDate = date;
          },
        });
      } catch {
        // skip unreadable files
      }
    }

    // We skip subagents — they are internal and would double-count tokens
  }

  totalSessions = sessionIds.size;

  // Find longest session
  let longestDuration = 0;
  let longestSessionId = '';
  for (const [sid, times] of sessionTimes) {
    const dur = times.end - times.start;
    if (dur > longestDuration) {
      longestDuration = dur;
      longestSessionId = sid;
    }
  }

  // Convert dailyMap to sorted array
  const dailyActivity: DailyActivity[] = Array.from(dailyMap.entries())
    .map(([date, data]) => ({
      date,
      messageCount: data.messages,
      sessionCount: data.sessions.size,
      toolCallCount: data.toolCalls,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Convert dailyTokenMap to sorted array
  const dailyModelTokens: DailyModelTokens[] = Array.from(dailyTokenMap.entries())
    .map(([date, tokensByModel]) => ({ date, tokensByModel }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    modelUsage,
    dailyActivity,
    dailyModelTokens,
    hourCounts,
    totalSessions,
    totalMessages,
    longestSession: longestDuration > 0 ? { sessionId: longestSessionId, duration: longestDuration } : undefined,
    firstSessionDate: firstSessionDate || undefined,
  };
}

interface ProcessContext {
  modelUsage: Record<string, ModelUsage>;
  dailyMap: Map<string, { messages: number; sessions: Set<string>; toolCalls: number }>;
  dailyTokenMap: Map<string, Record<string, number>>;
  hourCounts: Record<string, number>;
  sessionIds: Set<string>;
  sessionTimes: Map<string, { start: number; end: number }>;
  onMessage: () => void;
  onFirstDate: (date: string) => void;
}

async function processJSONL(filePath: string, ctx: ProcessContext) {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }

    const type = d.type as string;
    const sessionId = d.sessionId as string | undefined;
    const timestamp = d.timestamp as string | undefined;

    if (sessionId) {
      ctx.sessionIds.add(sessionId);
    }

    // Track session start/end times
    if (sessionId && timestamp) {
      const ts = new Date(timestamp).getTime();
      if (!isNaN(ts)) {
        const existing = ctx.sessionTimes.get(sessionId);
        if (!existing) {
          ctx.sessionTimes.set(sessionId, { start: ts, end: ts });
        } else {
          if (ts < existing.start) existing.start = ts;
          if (ts > existing.end) existing.end = ts;
        }
      }
    }

    const date = timestamp?.slice(0, 10);
    if (date) {
      ctx.onFirstDate(date);
    }

    // Hour tracking (from first timestamp of each session in each file)
    if (timestamp && type === 'user') {
      const hour = new Date(timestamp).getHours();
      if (!isNaN(hour)) {
        ctx.hourCounts[String(hour)] = (ctx.hourCounts[String(hour)] || 0) + 1;
      }
    }

    if (type === 'user') {
      ctx.onMessage();
      if (date && sessionId) {
        if (!ctx.dailyMap.has(date)) {
          ctx.dailyMap.set(date, { messages: 0, sessions: new Set(), toolCalls: 0 });
        }
        const daily = ctx.dailyMap.get(date)!;
        daily.messages++;
        daily.sessions.add(sessionId);
      }
    }

    if (type === 'assistant') {
      ctx.onMessage();
      const message = d.message as Record<string, unknown> | undefined;
      if (!message) continue;

      const model = message.model as string;
      const usage = message.usage as Record<string, number> | undefined;

      if (model && usage) {
        if (!ctx.modelUsage[model]) ctx.modelUsage[model] = emptyUsage();
        const mu = ctx.modelUsage[model];
        mu.inputTokens += usage.input_tokens || 0;
        mu.outputTokens += usage.output_tokens || 0;
        mu.cacheReadInputTokens += usage.cache_read_input_tokens || 0;
        mu.cacheCreationInputTokens += usage.cache_creation_input_tokens || 0;

        const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) +
          (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);

        if (date) {
          if (!ctx.dailyTokenMap.has(date)) ctx.dailyTokenMap.set(date, {});
          const dtm = ctx.dailyTokenMap.get(date)!;
          dtm[model] = (dtm[model] || 0) + totalTokens;
        }
      }

      // Tool use counting
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content) && date) {
        const toolCount = content.filter(c => c.type === 'tool_use').length;
        if (toolCount > 0) {
          if (!ctx.dailyMap.has(date)) {
            ctx.dailyMap.set(date, { messages: 0, sessions: new Set(), toolCalls: 0 });
          }
          ctx.dailyMap.get(date)!.toolCalls += toolCount;
        }
      }
    }
  }
}

async function readCache(): Promise<unknown | null> {
  try {
    const s = await stat(CACHE_FILE);
    if (Date.now() - s.mtimeMs < CACHE_TTL) {
      const content = await readFile(CACHE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // no cache or expired
  }
  return null;
}

async function writeCache(data: unknown): Promise<void> {
  try {
    await ensureDir(COCKPIT_DIR);
    await writeFile(CACHE_FILE, JSON.stringify(data), 'utf-8');
  } catch {
    // ignore write errors
  }
}

export async function GET() {
  try {
    // Check cache first
    const cached = await readCache();
    if (cached) {
      return Response.json(cached);
    }

    const stats = await scanSessions();
    if (!stats) {
      return Response.json({ error: 'Projects directory not found' }, { status: 404 });
    }

    // Write cache for next request
    await writeCache(stats);

    return Response.json(stats);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
