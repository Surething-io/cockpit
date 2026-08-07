import * as fs from 'fs';
import * as readline from 'readline';
import { join } from 'path';
import { Effect } from 'effect';
import { resolveSessionPath } from './session/sessionStore';
import { findCodexSessionEntry } from '@cockpit/shared-utils';
import { injectionKind, isHumanTurnStart } from '../../shared/transcriptTurns';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import {
  CODEX_AGENT_FN_NAMES,
  CODEX_IMAGE_ONLY_TEXT,
  CODEX_SPAWN_FN_NAME,
  CODEX_WAIT_FN_NAME,
  codexAgentResultText,
  codexSpawnDescription,
  codexWebSearchCall,
  extractCodexUserContent,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  parseCodexPatchInput,
  parseCodexSpawnOutput,
  parseCodexWaitOutput,
} from './session/codexTools';
import { generateTitle } from '../sessionTitle';
import { appendTextPart, appendToolPart, joinAssistantText } from '../../shared/assistantText';
import type { MessagePart } from '../../shared/assistantText';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface TranscriptMessage {
  type: string;
  // Harness-injected (non-typed) user messages are marked so they can be routed
  // out of the "user bubble" bucket: `isMeta` (skill body / image annotation /
  // compact summary), `origin.kind` (e.g. 'task-notification'), and
  // `sourceToolUseID` (the tool call a skill body was loaded by).
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string };
  sourceToolUseID?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      text?: string;
      name?: string;
      id?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string;
      is_error?: boolean;
      source?: {
        type: string;
        media_type: string;
        data: string;
      };
    }>;
    usage?: TokenUsage;
  };
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
  };
}

interface MessageImage {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

/** One entry of ChatMessage.toolCalls, named so the codex parser can hold references. */
type CodexToolCall = NonNullable<ChatMessage['toolCalls']>[number];

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: MessageImage[];
  timestamp?: string;
  // Set on role:'system' rows — a harness event rendered as a muted one-line bar
  // (not a conversation bubble). `task-notification` shows the <summary> line.
  systemEvent?: { kind: 'task-notification' | 'meta'; status?: string; detail?: string };
  // Ordered text/tool skeleton of the turn — see shared/assistantText.ts. Built
  // in lockstep with `content`, which stays derivable from it (deriveContent).
  parts?: MessagePart[];
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
    // Skill body loaded by this call (folded here instead of shown as a user bubble).
    skillContent?: string;
  }>;
}


// File fingerprint: mtime + size, lightweight check for file changes
function getFileFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}-${stat.size}`;
}

interface SessionByPathBody {
  cwd?: string;
  sessionId?: string;
  // When set, return the transcript of the subagent spawned by this Agent/Task
  // tool call instead of the main session (new-format `<sessionId>/subagents/` dir).
  toolUseId?: string;
  // Workflow drill-in. When `workflowId` is set, return the workflow run journal
  // (`<sessionId>/workflows/<workflowId>.json`); when `workflowAgentId` is also
  // set, return that workflow subagent's transcript
  // (`<sessionId>/subagents/workflows/<workflowId>/agent-<workflowAgentId>.jsonl`).
  workflowId?: string;
  workflowAgentId?: string;
  limit?: number;
  beforeTurnIndex?: number;
  ifFingerprint?: string;
}

// Subagent meta sidecar (agent-<id>.meta.json next to agent-<id>.jsonl)
interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

// One agent's progress entry inside a workflow run journal.
interface WorkflowAgentEntry {
  type?: string;
  index?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  state?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
}

// Workflow run journal (`workflows/<runId>.json`). Only the fields the
// drill-in UI needs are typed; the raw file also carries `script`, `logs`,
// full `result`, etc. which we deliberately do NOT forward to the client.
interface WorkflowJournal {
  runId?: string;
  workflowName?: string;
  status?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  startTime?: number;
  phases?: Array<{ title?: string; detail?: string }>;
  summary?: string;
  workflowProgress?: WorkflowAgentEntry[];
}

/**
 * Codex counterpart of findSubagentTranscript. Codex has no `subagents/` sidecar: a
 * sub-agent's transcript is an ordinary rollout of its own, in the shared
 * `~/.codex/sessions` tree, keyed by its thread id. The only link back to the
 * spawning call is inside the parent rollout — `spawn_agent`'s function_call_output
 * (`{"agent_id":…,"nickname":…}`) sits under the tool call's `call_id`, which IS the
 * tool_use id the client drilled in with. So: scan the parent for that call_id, then
 * resolve the child rollout by the agent id it names.
 */
async function findCodexSubagentTranscript(
  sessionPath: string,
  toolUseId: string
): Promise<{ transcriptPath: string; meta: SubagentMeta } | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath),
    crlfDelay: Infinity,
  });

  let agentId: string | null = null;
  let agentType: string | undefined;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let payload: {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: string;
        output?: string;
      } | undefined;
      try {
        payload = (JSON.parse(line) as { payload?: typeof payload }).payload;
      } catch { continue; }
      if (!payload || payload.call_id !== toolUseId) continue;

      if (payload.type === 'function_call' && payload.name === CODEX_SPAWN_FN_NAME) {
        try {
          const args = JSON.parse(payload.arguments || '{}') as { agent_type?: unknown };
          if (typeof args.agent_type === 'string') agentType = args.agent_type;
        } catch { /* keep going: the output line is what actually matters */ }
      } else if (payload.type === 'function_call_output') {
        const parsed = parseCodexSpawnOutput(payload.output || '');
        if (parsed) { agentId = parsed.agentId; break; }
      }
    }
  } finally {
    rl.close();
  }

  if (!agentId) return null;
  const entry = findCodexSessionEntry(agentId);
  if (!entry || !fs.existsSync(entry.path)) return null;
  return {
    transcriptPath: entry.path,
    // The child's own session_meta is authoritative for role/nickname; fall back to
    // the spawn arguments when this rollout predates those fields.
    meta: {
      agentType: entry.agentRole || agentType,
      description: entry.agentNickname,
      toolUseId,
    },
  };
}

// Locate the subagent transcript spawned by a given tool_use id.
// Subagents live in `<sessionDir>/<sessionId>/subagents/agent-<id>.jsonl`
// with a meta sidecar carrying the spawning toolUseId.
function findSubagentTranscript(
  sessionPath: string,
  toolUseId: string
): { transcriptPath: string; meta: SubagentMeta } | null {
  const subagentsDir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(subagentsDir)) return null;
  for (const file of fs.readdirSync(subagentsDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(join(subagentsDir, file), 'utf-8')
      ) as SubagentMeta;
      if (meta.toolUseId !== toolUseId) continue;
      const transcriptPath = join(subagentsDir, file.replace(/\.meta\.json$/, '.jsonl'));
      if (fs.existsSync(transcriptPath)) return { transcriptPath, meta };
    } catch {
      // Skip unreadable meta files
    }
  }
  return null;
}

// Path of a workflow run journal: `<sessionDir>/workflows/<runId>.json`.
function workflowJournalPath(sessionPath: string, workflowId: string): string {
  return join(sessionPath.replace(/\.jsonl$/, ''), 'workflows', `${workflowId}.json`);
}

// Path of a single workflow subagent transcript:
// `<sessionDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl`.
function workflowAgentTranscriptPath(
  sessionPath: string,
  workflowId: string,
  agentId: string
): string {
  return join(
    sessionPath.replace(/\.jsonl$/, ''),
    'subagents',
    'workflows',
    workflowId,
    `agent-${agentId}.jsonl`
  );
}

// Trim a raw journal down to the fields the drill-in UI renders. Drops
// `script`, `logs`, and the full `result` blob; keeps bounded previews only.
function trimWorkflowJournal(journal: WorkflowJournal) {
  const agents = (journal.workflowProgress ?? [])
    .filter((e) => e.type === 'workflow_agent')
    .map((e) => ({
      index: e.index,
      label: e.label,
      phaseIndex: e.phaseIndex,
      phaseTitle: e.phaseTitle,
      agentId: e.agentId,
      model: e.model,
      state: e.state,
      tokens: e.tokens,
      toolCalls: e.toolCalls,
      durationMs: e.durationMs,
      lastToolName: e.lastToolName,
      lastToolSummary: e.lastToolSummary,
      promptPreview: e.promptPreview,
      resultPreview: e.resultPreview,
    }));
  return {
    runId: journal.runId,
    workflowName: journal.workflowName,
    status: journal.status,
    durationMs: journal.durationMs,
    agentCount: journal.agentCount,
    totalTokens: journal.totalTokens,
    totalToolCalls: journal.totalToolCalls,
    startTime: journal.startTime,
    phases: journal.phases,
    summary: journal.summary,
    agents,
  };
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SessionByPathBody;
    const { cwd, sessionId, toolUseId, workflowId, workflowAgentId, limit, beforeTurnIndex, ifFingerprint } = body;
    if (!cwd || !sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? 'cwd' : 'sessionId',
          reason: 'missing',
        })
      );
    }

    // Resolve session file across 7 engines (claude/claude2/deepseek/codex/kimi/glm/ollama)
    const resolved = yield* Effect.sync(() => resolveSessionPath(cwd, sessionId));
    if (!resolved) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const { sessionPath, engine, mode } = resolved;

    // Subagent transcript branch: same parser/fingerprint flow on the agent jsonl
    if (toolUseId) {
      if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'toolUseId', reason: 'invalid' })
        );
      }
      const sub = yield* engine === 'codex'
        ? Effect.tryPromise({
            try: () => findCodexSubagentTranscript(sessionPath, toolUseId),
            catch: (cause) =>
              new AppError({ message: 'findCodexSubagentTranscript failed', cause }),
          })
        : Effect.sync(() => findSubagentTranscript(sessionPath, toolUseId));
      if (!sub) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'subagent', id: toolUseId })
        );
      }
      const subFingerprint = getFileFingerprint(sub.transcriptPath);
      if (ifFingerprint && ifFingerprint === subFingerprint) {
        return ok({ notModified: true, fingerprint: subFingerprint });
      }
      // Same drill-in contract for both engines, each with its own transcript parser.
      const subResult = yield* Effect.tryPromise({
        try: () =>
          engine === 'codex'
            ? parseCodexTranscriptFile(sub.transcriptPath)
            : parseTranscriptFile(sub.transcriptPath),
        catch: (cause) =>
          new AppError({ message: 'parseTranscriptFile failed', cause }),
      });
      return ok({
        messages: subResult.messages,
        subagent: { agentType: sub.meta.agentType, description: sub.meta.description },
        fingerprint: subFingerprint,
      });
    }

    // Workflow drill-in branch: run journal, or a single workflow subagent's
    // transcript when workflowAgentId is also supplied. Both ids are
    // whitelisted to keep the file path inside the session dir.
    if (workflowId) {
      if (!/^wf_[A-Za-z0-9_-]+$/.test(workflowId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'workflowId', reason: 'invalid' })
        );
      }

      if (workflowAgentId) {
        if (!/^[A-Za-z0-9_-]+$/.test(workflowAgentId)) {
          return yield* Effect.fail(
            new ValidationError({ field: 'workflowAgentId', reason: 'invalid' })
          );
        }
        const agentPath = workflowAgentTranscriptPath(sessionPath, workflowId, workflowAgentId);
        if (!fs.existsSync(agentPath)) {
          return yield* Effect.fail(
            new NotFoundError({ resource: 'workflowAgent', id: workflowAgentId })
          );
        }
        const agentFingerprint = getFileFingerprint(agentPath);
        if (ifFingerprint && ifFingerprint === agentFingerprint) {
          return ok({ notModified: true, fingerprint: agentFingerprint });
        }
        const agentResult = yield* Effect.tryPromise({
          try: () => parseTranscriptFile(agentPath),
          catch: (cause) =>
            new AppError({ message: 'parseTranscriptFile failed', cause }),
        });
        return ok({ messages: agentResult.messages, fingerprint: agentFingerprint });
      }

      const journalPath = workflowJournalPath(sessionPath, workflowId);
      if (!fs.existsSync(journalPath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'workflow', id: workflowId })
        );
      }
      const journalFingerprint = getFileFingerprint(journalPath);
      if (ifFingerprint && ifFingerprint === journalFingerprint) {
        return ok({ notModified: true, fingerprint: journalFingerprint });
      }
      const workflow = yield* Effect.try({
        try: () =>
          trimWorkflowJournal(
            JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as WorkflowJournal
          ),
        catch: (cause) =>
          new AppError({ message: 'readWorkflowJournal failed', cause }),
      });
      return ok({ workflow, fingerprint: journalFingerprint });
    }

    const fingerprint = getFileFingerprint(sessionPath);
    if (ifFingerprint && ifFingerprint === fingerprint) {
      return ok({ notModified: true, fingerprint });
    }

    const parseResult = yield* Effect.tryPromise({
      try: async () => {
        if (engine === 'codex') return parseCodexTranscriptFile(sessionPath);
        // Everything else (claude/claude2/ollama/deepseek/kimi/glm) writes Claude-style
        // transcripts, in both SDK and Built-in Agent mode, so one parser covers them.
        // ollama has done so since v1.0.186; the AI SDK ModelMessage legacy fallback
        // (v1.0.184–185 only) was removed.
        return parseTranscriptFile(sessionPath, limit, beforeTurnIndex);
      },
      catch: (cause) =>
        new AppError({ message: 'parseTranscriptFile failed', cause }),
    });

    const { messages, title, usage } = parseResult;
    const totalTurns = 'totalTurns' in parseResult ? parseResult.totalTurns : 0;
    const hasMore = 'hasMore' in parseResult ? parseResult.hasMore : false;
    return ok({
      messages,
      sessionId,
      title,
      usage,
      totalTurns,
      hasMore,
      fingerprint,
      // Authoritative engine for this session, resolved by file location across
      // all 7 engines. Clients use this to send on the session's native engine —
      // more reliable than the optional global-state engine field, which is only
      // written for sessions that were open as a tab.
      engine,
      // Authoritative execution mode where the store proves it (deepseek/kimi/glm
      // sdk vs builtin); omitted when it doesn't (see resolveSessionPath).
      mode,
    });
  })
);

async function parseTranscriptFile(
  filePath: string,
  limit?: number,
  beforeTurnIndex?: number
): Promise<{ messages: ChatMessage[]; title: string; usage?: TokenUsage; totalTurns: number; hasMore: boolean }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const rawMessages: TranscriptMessage[] = [];
  let aiTitle = '';
  let summary = '';
  const userTextMessages: string[] = [];
  let lastUsage: TokenUsage | undefined;

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptMessage & { summary?: string; aiTitle?: string; isMeta?: boolean };
      if (obj.type === 'user' || obj.type === 'assistant') {
        // Deduplicate: skip user messages with identical content within 1s of the previous one
        // (SDK resume + prompt may write duplicate user entries)
        if (obj.type === 'user' && rawMessages.length > 0) {
          const prev = rawMessages[rawMessages.length - 1];
          if (
            prev.type === 'user' &&
            prev.timestamp && obj.timestamp &&
            Math.abs(new Date(obj.timestamp).getTime() - new Date(prev.timestamp).getTime()) < 1000 &&
            JSON.stringify(prev.message?.content) === JSON.stringify(obj.message?.content)
          ) {
            continue; // skip duplicate
          }
        }
        rawMessages.push(obj);

        // Collect the usage of the last assistant message
        if (obj.type === 'assistant' && obj.message?.usage) {
          lastUsage = obj.message.usage;
        }

        // Collect user text messages for title generation. Harness-injected entries
        // (task notifications, skill bodies, compaction notices) are not user input and
        // must not name the session — same rule the renderer and the turn splitter use.
        if (isHumanTurnStart(obj) && obj.message?.content) {
          const content = obj.message.content;
          if (typeof content === 'string') {
            userTextMessages.push(content);
          } else if (Array.isArray(content)) {
            const textBlocks = content.filter((b) => b.type === 'text');
            for (const block of textBlocks) {
              if (block.text) userTextMessages.push(block.text);
            }
          }
        }
      }
      // Collect the aiTitle line (cockpit/SDK runtime; stable single value, last wins)
      if (obj.type === 'ai-title' && obj.aiTitle) {
        aiTitle = obj.aiTitle;
      }
      // Collect summary
      if (obj.type === 'summary' && obj.summary) {
        summary = obj.summary;
      }
    } catch {
      // Ignore lines with parse errors
    }
  }

  // Convert message format (full set)
  const allMessages = convertToChatMessages(rawMessages);
  const title = generateTitle(aiTitle, summary, userTextMessages);

  // Count turns: one turn = one user message + the corresponding assistant message
  // Simplified here: each user message starts a new turn
  const turns: ChatMessage[][] = [];
  let currentTurn: ChatMessage[] = [];

  for (const msg of allMessages) {
    if (msg.role === 'user') {
      if (currentTurn.length > 0) {
        turns.push(currentTurn);
      }
      currentTurn = [msg];
    } else {
      currentTurn.push(msg);
    }
  }
  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  const totalTurns = turns.length;

  // If there are no pagination params, return all messages
  if (limit === undefined) {
    return { messages: allMessages, title, usage: lastUsage, totalTurns, hasMore: false };
  }

  // Pagination logic: take `limit` turns going back from beforeTurnIndex
  const endIndex = beforeTurnIndex !== undefined ? beforeTurnIndex : totalTurns;
  const startIndex = Math.max(0, endIndex - limit);
  const hasMore = startIndex > 0;

  // Extract the specified range of turns and flatten into a message array
  const selectedTurns = turns.slice(startIndex, endIndex);
  const messages = selectedTurns.flat();

  return { messages, title, usage: lastUsage, totalTurns, hasMore };
}

// Plain text of a user message, whether string- or block-form.
function messageText(msg: TranscriptMessage): string {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

// Build a muted system-event row from an injected message (task-notification / meta).
function buildSystemEvent(msg: TranscriptMessage, kind: 'task-notification' | 'meta'): ChatMessage | null {
  const raw = messageText(msg);
  if (kind === 'task-notification') {
    const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    const status = raw.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    return {
      id: msg.uuid || `sysevent-${Date.now()}`,
      role: 'system',
      content: summary || raw.trim().slice(0, 200),
      timestamp: msg.timestamp,
      systemEvent: { kind: 'task-notification', detail: raw.trim(), ...(status ? { status } : {}) },
    };
  }
  const text = raw.trim();
  if (!text) return null;
  return {
    id: msg.uuid || `sysevent-${Date.now()}`,
    role: 'system',
    content: text,
    timestamp: msg.timestamp,
    systemEvent: { kind: 'meta' },
  };
}

function convertToChatMessages(rawMessages: TranscriptMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  let currentAssistantMessage: ChatMessage | null = null;
  // See history.ts / assistantText.ts: paragraph-break only across a tool_use.
  let toolSinceText = false;
  const toolResults = new Map<string, string>();
  // Skill bodies, keyed by the tool call (sourceToolUseID) that loaded them — folded
  // into that tool call instead of being rendered as a user bubble.
  const skillContents = new Map<string, string>();

  // First pass: collect all tool results + skill bodies
  for (const msg of rawMessages) {
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content || '');
        }
      }
    }
    if (msg.type === 'user' && injectionKind(msg) === 'skill' && msg.sourceToolUseID) {
      const text = messageText(msg);
      if (text) skillContents.set(msg.sourceToolUseID, text);
    }
  }

  // Second pass: build the message list
  for (const msg of rawMessages) {
    // Handle user text messages
    if (msg.type === 'user' && msg.message?.role === 'user' && msg.message?.content) {
      // Route harness-injected messages out of the user-bubble bucket.
      const injected = injectionKind(msg);
      if (injected) {
        // Skill bodies are folded into their originating tool call (collected above).
        // task-notification / meta become a muted system-event row.
        if (injected !== 'skill') {
          const ev = buildSystemEvent(msg, injected);
          if (ev) {
            if (currentAssistantMessage) {
              chatMessages.push(currentAssistantMessage);
              currentAssistantMessage = null;
            }
            chatMessages.push(ev);
          }
        }
        continue;
      }
      const content = msg.message.content;
      if (typeof content === 'string') {
        if (currentAssistantMessage) {
          chatMessages.push(currentAssistantMessage);
          currentAssistantMessage = null;
        }

        const userMessage: ChatMessage = {
          id: msg.uuid || `user-${Date.now()}`,
          role: 'user',
          content: content,
          timestamp: msg.timestamp,
        };
        chatMessages.push(userMessage);
        continue;
      }

      if (!Array.isArray(content)) continue;

      const textBlocks = content.filter((b) => b.type === 'text');
      const imageBlocks = content.filter((b) => b.type === 'image' && b.source);

      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        if (currentAssistantMessage) {
          chatMessages.push(currentAssistantMessage);
          currentAssistantMessage = null;
        }

        const userMessage: ChatMessage = {
          id: msg.uuid || `user-${Date.now()}`,
          role: 'user',
          content: textBlocks.map((b) => b.text || '').join('\n'),
          timestamp: msg.timestamp,
        };

        if (imageBlocks.length > 0) {
          userMessage.images = imageBlocks.map((b) => ({
            type: 'base64' as const,
            media_type: (b.source?.media_type || 'image/png') as MessageImage['media_type'],
            data: b.source?.data || '',
          }));
        }

        chatMessages.push(userMessage);
      }
    }

    // Handle assistant messages
    if (msg.type === 'assistant' && msg.message?.content) {
      const content = msg.message.content;
      if (!Array.isArray(content)) continue;

      const textBlocks = content.filter((b) => b.type === 'text');
      const toolBlocks = content.filter((b) => b.type === 'tool_use');

      if (textBlocks.length > 0) {
        const entryText = textBlocks.map((b) => b.text || '').join('');
        if (currentAssistantMessage) {
          currentAssistantMessage.content = joinAssistantText(currentAssistantMessage.content, entryText, toolSinceText);
          currentAssistantMessage.parts = appendTextPart(currentAssistantMessage.parts, entryText, toolSinceText);
        } else {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: entryText,
            parts: appendTextPart([], entryText),
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }
        toolSinceText = false;
      }

      if (toolBlocks.length > 0) {
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: '',
            parts: [],
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }
        toolSinceText = true;

        for (const tool of toolBlocks) {
          if (tool.name && tool.id) {
            currentAssistantMessage.parts = appendToolPart(currentAssistantMessage.parts, tool.id);
            currentAssistantMessage.toolCalls!.push({
              id: tool.id,
              name: tool.name,
              input: tool.input || {},
              result: toolResults.get(tool.id),
              isLoading: false,
              ...(skillContents.has(tool.id) ? { skillContent: skillContents.get(tool.id) } : {}),
            });
          }
        }
      }
    }
  }

  if (currentAssistantMessage) {
    chatMessages.push(currentAssistantMessage);
  }

  return chatMessages;
}

// ============================================
// Codex session transcript parser
// ============================================

interface CodexPayload {
  type?: string;
  role?: string;
  name?: string;
  /** `mcp__<server>` for MCP calls, `multi_agent_v1` for sub-agent tools. */
  namespace?: string;
  arguments?: string;
  input?: string; // custom_tool_call (apply_patch) body
  call_id?: string;
  output?: string;
  content?: Array<{ type?: string; text?: string; image_url?: string }>;
  // web_search_end (an event_msg, not a response_item) — the only persisted web
  // search line carrying both the stable `ws_…` id and the query.
  query?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
}

async function parseCodexTranscriptFile(
  filePath: string
): Promise<{ messages: ChatMessage[]; title: string; usage?: TokenUsage }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const messages: ChatMessage[] = [];
  let currentAssistant: ChatMessage | null = null;
  let title = 'Untitled Session';
  let lastUsage: TokenUsage | undefined;
  let msgCounter = 0;
  // Paragraph-break only across a tool call (see assistantText.ts).
  let toolSinceText = false;

  // Sub-agent wiring. All three are session-scoped, not per-message: a `wait_agent`
  // routinely lands in a later turn (so a later assistant message) than the
  // `spawn_agent` whose bubble it completes. The maps hold live references into
  // `messages`, so filling a result later mutates the already-pushed bubble.
  const spawnByCallId = new Map<string, CodexToolCall>();
  const agentToCall = new Map<string, CodexToolCall>();
  const waitCallIds = new Set<string>();

  const flushAssistant = () => {
    if (currentAssistant) {
      messages.push(currentAssistant);
      currentAssistant = null;
      toolSinceText = false;
    }
  };

  const ensureAssistant = (timestamp?: string): ChatMessage => {
    if (!currentAssistant) {
      currentAssistant = {
        id: `codex-assistant-${msgCounter++}`,
        role: 'assistant',
        content: '',
        parts: [],
        toolCalls: [],
        timestamp,
      };
    }
    return currentAssistant;
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry: { timestamp?: string; type?: string; payload?: CodexPayload };
    try {
      entry = JSON.parse(line);
    } catch { continue; }

    const { type, payload, timestamp } = entry;
    if (!payload) continue;

    if (type === 'response_item') {
      // User message
      if (payload.type === 'message' && payload.role === 'user') {
        const { text, images } = extractCodexUserContent(payload.content);
        // Skip system/developer messages (permissions, AGENTS.md, env context)
        if (images.length === 0 && (!text || text.startsWith('<') || text.startsWith('#'))) continue;

        flushAssistant();
        messages.push({
          id: `codex-user-${msgCounter++}`,
          role: 'user',
          content: text,
          ...(images.length > 0 ? { images } : {}),
          timestamp,
        });
        // First real user message becomes the title
        if (title === 'Untitled Session') {
          title = (text || CODEX_IMAGE_ONLY_TEXT).slice(0, 80);
        }
      }

      // Assistant text message
      if (payload.type === 'message' && payload.role === 'assistant') {
        const text = payload.content
          ?.filter(c => c.type === 'output_text' && c.text)
          .map(c => c.text!)
          .join('') || '';
        if (text) {
          const assistant = ensureAssistant(timestamp);
          assistant.content = joinAssistantText(assistant.content || '', text, toolSinceText);
          assistant.parts = appendTextPart(assistant.parts, text, toolSinceText);
          toolSinceText = false;
        }
      }

      // Reasoning
      if (payload.type === 'reasoning') {
        // Skip reasoning for now (could render as collapsed block later)
      }

      // Tool call (function_call)
      if (payload.type === 'function_call' && payload.name) {
        const fnName = payload.name;
        if (fnName === CODEX_WAIT_FN_NAME && payload.call_id) waitCallIds.add(payload.call_id);
        // Multi-agent plumbing gets no bubble of its own: `spawn_agent` is the only one
        // that becomes a Task, and the rest merely feed it (see codexTools). This must
        // match the live engine's handleCollabItem or the turn changes shape on refresh.
        const isAgentPlumbing = CODEX_AGENT_FN_NAMES.has(fnName) && fnName !== CODEX_SPAWN_FN_NAME;

        if (!isAgentPlumbing) {
          const assistant = ensureAssistant(timestamp);
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(payload.arguments || '{}'); } catch { /* */ }
          assistant.toolCalls = assistant.toolCalls || [];
          const callId = payload.call_id || `tool-${msgCounter++}`;
          assistant.parts = appendToolPart(assistant.parts, callId);
          const toolCall: CodexToolCall = {
            id: callId,
            // The namespace is what turns a bare `js` into `mcp__node_repl__js`.
            name: normalizeCodexToolName(fnName, payload.namespace),
            input: normalizeCodexToolInput(fnName, input),
            isLoading: false,
          };
          assistant.toolCalls.push(toolCall);
          if (fnName === CODEX_SPAWN_FN_NAME) spawnByCallId.set(callId, toolCall);
          toolSinceText = true;
        }
      }

      // Tool result (function_call_output)
      if (payload.type === 'function_call_output' && payload.call_id) {
        const callId = payload.call_id;
        const spawned = spawnByCallId.get(callId);
        const output = payload.output || '';

        if (spawned) {
          // `spawn_agent`'s output is bookkeeping (`{agent_id, nickname}`), not a report,
          // so it deliberately does NOT become the bubble's result: the report arrives
          // later, from the wait_agent that collects this agent. Leaving `result` unset
          // until then is also what keeps the drill-in view polling the sub-agent's
          // still-growing rollout — including for an agent that was never waited on.
          const parsed = parseCodexSpawnOutput(output);
          if (parsed) {
            agentToCall.set(parsed.agentId, spawned);
            spawned.input = {
              ...spawned.input,
              agent_id: parsed.agentId,
              description: codexSpawnDescription(
                parsed.nickname,
                typeof spawned.input.subagent_type === 'string' ? spawned.input.subagent_type : undefined,
                typeof spawned.input.prompt === 'string' ? spawned.input.prompt : ''
              ),
            };
          }
        } else if (waitCallIds.has(callId)) {
          // Route each agent's report onto the bubble its spawn_agent created. Agents
          // spawned in an earlier turn are not in the map (codex cannot reach them across
          // an `exec resume` either) and are simply skipped.
          for (const state of parseCodexWaitOutput(output)) {
            if (!state.done) continue;
            const tc = agentToCall.get(state.agentId);
            if (tc) tc.result = codexAgentResultText(state);
          }
        } else {
          const assistant = ensureAssistant(timestamp);
          const tc = assistant.toolCalls?.find(t => t.id === callId);
          if (tc) {
            tc.result = output;
            tc.isLoading = false;
          }
        }
      }

      // Custom tool call (apply_patch) — codex's file editor. Surface it as its own
      // tool call so the edit shows a bubble and its FileDiff resolves (matches the
      // live engine's file_change handling).
      if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
        const assistant = ensureAssistant(timestamp);
        assistant.toolCalls = assistant.toolCalls || [];
        const callId = payload.call_id || `tool-${msgCounter++}`;
        assistant.parts = appendToolPart(assistant.parts, callId);
        assistant.toolCalls.push({
          id: callId,
          name: normalizeCodexToolName(payload.name),
          input: parseCodexPatchInput(payload.input || ''),
          isLoading: false,
        });
        toolSinceText = true;
      }

      // Custom tool call result (apply_patch output)
      if (payload.type === 'custom_tool_call_output' && payload.call_id) {
        const assistant = ensureAssistant(timestamp);
        const tc = assistant.toolCalls?.find(t => t.id === payload.call_id);
        if (tc) {
          tc.result = payload.output || '';
          tc.isLoading = false;
        }
      }
    }

    // Web search. Unlike every other tool this is NOT persisted as a function_call:
    // the `response_item`/`web_search_call` line has no id at all, so the only usable
    // record is this event_msg — which carries the same `ws_…` id the live item uses.
    if (type === 'event_msg' && payload.type === 'web_search_end' && payload.call_id) {
      const assistant = ensureAssistant(timestamp);
      const { name, input, result } = codexWebSearchCall(payload.query, payload.action);
      assistant.toolCalls = assistant.toolCalls || [];
      assistant.parts = appendToolPart(assistant.parts, payload.call_id);
      assistant.toolCalls.push({ id: payload.call_id, name, input, result, isLoading: false });
      toolSinceText = true;
    }

    // Usage from response_completed or event_msg
    if (type === 'response_completed') {
      const usage = (payload as Record<string, unknown>).usage as TokenUsage | undefined;
      if (usage) lastUsage = usage;
      flushAssistant();
    }
  }

  flushAssistant();

  return { messages, title, usage: lastUsage };
}
