// Transcript -> ChatMessage parsers for every engine session jsonl, plus the
// turn split that `beforeTurnIndex` pagination is expressed in.
//
// Deliberately NOT in session-by-path.ts: that module is re-exported wholesale
// by its Next route shim (`export *` in src/app/api/session-by-path/route.ts),
// and Next rejects any export from a route file that is not a route field, so
// a second caller cannot import from there. See the same note in
// session/transcriptToMessages.ts.
//
// Every caller that needs to talk about "the Nth turn" or "the user messages of
// this session" MUST come through here. Re-deriving either is the trap recorded
// in convertToChatMessages: not every `type:"user"` line is a human message
// (skill bodies, task notifications, tool_result tails), and fork.ts once cut a
// 21-turn conversation into 58 by guessing.
import * as fs from 'fs';
import * as readline from 'readline';
import { injectionKind, isHumanTurnStart } from '../../../shared/transcriptTurns';
import { asyncLaunchTaskId, parseTaskNotification, type ToolCallTask } from '../../../shared/subagentTask';
import { generateTitle } from '../../sessionTitle';
import { appendTextPart, appendToolPart, joinAssistantText } from '../../../shared/assistantText';
import type { MessagePart } from '../../../shared/assistantText';
import {
  CODEX_AGENT_MESSAGE_TYPE,
  CODEX_CUSTOM_TOOL_NAMES,
  CODEX_EXEC_SCRIPT_FN_NAME,
  CODEX_IMAGE_ONLY_TEXT,
  CODEX_SPAWN_FN_NAME,
  CODEX_WAIT_FN_NAME,
  codexAgentResultText,
  codexItemBubble,
  type CodexItemLike,
  codexExecScriptCall,
  codexSpawnDescription,
  codexToolOutputText,
  codexWebSearchCall,
  extractCodexUserContent,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  codexUnknownCallResult,
  parseCodexAgentMessage,
  parseCodexExecScript,
  parseCodexSpawnOutput,
  parseCodexSubAgentActivity,
  parseCodexTokenUsage,
  parseCodexUnknownCall,
  parseCodexWaitOutput,
} from './codexTools';

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TranscriptMessage {
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
    // Async Agent/Task launch receipt: {isAsync, status:'async_launched', agentId}.
    // Read through asyncLaunchTaskId — never by pattern-matching the receipt prose.
    isAsync?: boolean;
    status?: string;
    agentId?: string;
  };
}

export interface MessageImage {
  type: 'base64';
  media_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

/** One entry of ChatMessage.toolCalls, named so the codex parser can hold references. */
export type CodexToolCall = NonNullable<ChatMessage['toolCalls']>[number];

export interface ChatMessage {
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
    // The background task this call spawned — see shared/subagentTask.ts.
    task?: ToolCallTask;
  }>;
}
/**
 * Which slice of turns to return. `beforeTurnIndex` + `limit` walks BACKWARDS
 * (scroll-up paging); `fromTurnIndex` pins the start instead, for "bring turn N
 * back on screen" jumps.
 *
 * The two anchors differ in what they survive: a `limit` computed by the client
 * from a totalTurns it read earlier silently slides forward if the session grew
 * in between, so the very turn being jumped to falls out of the window.
 * `fromTurnIndex` is resolved against the totalTurns of THIS read, so it cannot.
 */
export interface TurnPage {
  limit?: number;
  beforeTurnIndex?: number;
  fromTurnIndex?: number;
}

export async function parseTranscriptFile(
  filePath: string,
  page: TurnPage = {}
): Promise<{
  messages: ChatMessage[];
  title: string;
  usage?: TokenUsage;
  totalTurns: number;
  hasMore: boolean;
  /** Index of the first returned turn — the cursor a further scroll-up pages before. */
  startTurnIndex: number;
}> {
  const { limit, beforeTurnIndex, fromTurnIndex } = page;
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

  const turns = splitTurns(allMessages);
  const totalTurns = turns.length;

  // If there are no pagination params, return all messages
  if (limit === undefined && fromTurnIndex === undefined) {
    return {
      messages: allMessages,
      title,
      usage: lastUsage,
      totalTurns,
      hasMore: false,
      startTurnIndex: 0,
    };
  }

  // Pagination logic: take `limit` turns going back from beforeTurnIndex, unless
  // fromTurnIndex pins the start outright.
  const endIndex = beforeTurnIndex !== undefined ? beforeTurnIndex : totalTurns;
  const startIndex =
    fromTurnIndex !== undefined
      ? Math.min(Math.max(0, fromTurnIndex), endIndex)
      : Math.max(0, endIndex - (limit as number));
  const hasMore = startIndex > 0;

  // Extract the specified range of turns and flatten into a message array
  const selectedTurns = turns.slice(startIndex, endIndex);
  const messages = selectedTurns.flat();

  return { messages, title, usage: lastUsage, totalTurns, hasMore, startTurnIndex: startIndex };
}

/**
 * Split a converted message list into turns: a turn opens at every `role:'user'`
 * message and swallows everything that follows it, so a leading assistant/system
 * prefix (a resumed session that starts mid-reply) forms turn 0 on its own.
 *
 * This IS the unit `beforeTurnIndex` pages in. Any caller that needs a turn index
 * must get it from here rather than counting rendered user bubbles: `role:'system'`
 * rows and folded-away injected user lines make the two counts drift.
 */
export function splitTurns(allMessages: ChatMessage[]): ChatMessage[][] {
  const turns: ChatMessage[][] = [];
  let currentTurn: ChatMessage[] = [];
  for (const msg of allMessages) {
    if (msg.role === 'user') {
      if (currentTurn.length > 0) turns.push(currentTurn);
      currentTurn = [msg];
    } else {
      currentTurn.push(msg);
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

/** One row of the user-message index: enough to render, search and jump. */
export interface UserMessageIndexEntry {
  /** The rendered bubble's `data-message-id`, so a jump can find it in the DOM. */
  id: string;
  /** Cursor for `beforeTurnIndex` pagination — how the client pulls this row in. */
  turnIndex: number;
  timestamp?: string;
  /** Full text, not a preview: the modal filters on it client-side. */
  content: string;
}

/**
 * Every human message of a session, in file order, with the turn index that
 * brings it into a paginated window.
 *
 * Built from the same conversion the chat renders, on purpose: `id` is exactly
 * the bubble's `data-message-id` and `turnIndex` is exactly the cursor that
 * loads it. Re-deriving either from raw jsonl is the trap convertToChatMessages
 * documents — skill bodies, task notifications and `tool_result` tails are all
 * `type:"user"` lines that are not human messages.
 */
export async function parseUserMessageIndex(
  filePath: string,
  engine: string
): Promise<{ entries: UserMessageIndexEntry[]; totalTurns: number; title: string }> {
  // Codex rollouts have no pagination (parseCodexTranscriptFile takes no limit),
  // so their turnIndex is only ever informational — the client already holds the
  // whole session. Producing it anyway keeps one shape across all engines.
  const parsed =
    engine === 'codex'
      ? await parseCodexTranscriptFile(filePath)
      : await parseTranscriptFile(filePath);
  const turns = splitTurns(parsed.messages);
  const entries: UserMessageIndexEntry[] = [];
  turns.forEach((turn, turnIndex) => {
    // A turn holds at most one user message, and always at its head (splitTurns).
    const head = turn[0];
    if (head?.role !== 'user') return;
    entries.push({
      id: head.id,
      turnIndex,
      timestamp: head.timestamp,
      content: head.content,
    });
  });
  return { entries, totalTurns: turns.length, title: parsed.title };
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
  // Background tasks a tool call spawned, keyed by that call. Rebuilt from the transcript so a
  // reload agrees with what the live `system/task_*` stream put on screen: the launch receipt
  // opens the entry as `unknown`, the matching `<task-notification>` settles it. Never `running`
  // — that status is a live claim only the owning process may make; see TaskStatus.
  const spawnedTasks = new Map<string, ToolCallTask>();

  // First pass: collect all tool results + skill bodies + spawned-task state (file order, so a
  // notification always lands after the launch that opened its entry)
  for (const msg of rawMessages) {
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content || '');
          const taskId = asyncLaunchTaskId(msg.toolUseResult);
          // 'unknown', never 'running': this is a receipt, not a heartbeat. See TaskStatus.
          if (taskId) spawnedTasks.set(block.tool_use_id, { status: 'unknown', id: taskId });
        }
      }
    }
    if (msg.type === 'user' && injectionKind(msg) === 'task-notification') {
      const note = parseTaskNotification(messageText(msg));
      if (note?.toolUseId && note.status) {
        spawnedTasks.set(note.toolUseId, {
          ...spawnedTasks.get(note.toolUseId),
          status: note.status,
          ...(note.taskId ? { id: note.taskId } : {}),
          ...(note.summary ? { summary: note.summary } : {}),
        });
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
              ...(spawnedTasks.has(tool.id) ? { task: spawnedTasks.get(tool.id) } : {}),
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
  /** custom_tool_call body: an apply_patch patch, or (5.6+) an `exec` JS script. */
  input?: string;
  call_id?: string;
  /** String for function_call_output; content blocks for custom_tool_call_output. */
  output?: string | Array<{ type?: string; text?: string }>;
  content?: Array<{ type?: string; text?: string; image_url?: string }>;
  // web_search_end (an event_msg, not a response_item) — the only persisted web
  // search line carrying both the stable `ws_…` id and the query.
  query?: string;
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  // sub_agent_activity (event_msg) — `event_id` is the spawning call_id.
  event_id?: string;
  agent_thread_id?: string;
  agent_path?: string;
  // agent_message (response_item) — a sub-agent reporting to its parent.
  author?: string;
  recipient?: string;
  // task_complete (event_msg) — set when the turn ended in failure (server
  // overload, rate limit, aborted stream). The ONLY on-disk record of the reason.
  error?: { message?: string };
  // item_completed (event_msg) — written only by the app-server transport, and
  // the sole source of tool bubbles. Self-sufficient: id, input and result.
  item?: CodexItemLike;
}

export async function parseCodexTranscriptFile(
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

  /**
   * Tool bubbles come from `event_msg/item_completed`, which carries a call's
   * id, its input and its result in ONE record — the same record the live
   * engine draws from, through the same `codexItemBubble`. That is what makes a
   * bubble identical live and after a reload without anything being rewritten.
   *
   * Two kinds of call never get an item, so they are built from their
   * `response_item` instead and are the only reason a call_id index survives:
   *
   *   - an `exec` script that runs no command line (`write_stdin`,
   *     `create_goal`, or a body too dynamic to read) — measured at ~5% of exec
   *     calls, and today they draw a history bubble the live stream never had;
   *   - a `spawn_agent`, whose own arguments live on the call line while the
   *     item carries only thread ids and states.
   */
  const toolByCallId = new Map<string, CodexToolCall>();
  /**
   * Ids already drawn this session. A web search is recorded twice by the two
   * transports — `event_msg/web_search_end` and an `item_completed` — under the
   * SAME `ws_…` id, so a session resumed across the transport change could
   * otherwise draw it twice.
   */
  const drawnToolIds = new Set<string>();
  // A sub-agent is addressed by its path (`/root/cr_static`), not its thread id, (`/root/cr_static`), not its thread id,
  // in the agent_message that carries its report.
  const agentPathToCall = new Map<string, CodexToolCall>();

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

      // A sub-agent reporting back (0.147+). Its report is no longer part of
      // wait_agent's output, so this line is what completes the Task bubble its
      // spawn_agent created. No bubble of its own: the report belongs to that one.
      if (payload.type === CODEX_AGENT_MESSAGE_TYPE) {
        const report = parseCodexAgentMessage(payload);
        if (report?.final && report.text) {
          const tc = agentPathToCall.get(report.author);
          if (tc) tc.result = report.text;
        }
      }

      // Tool call (function_call). Only `spawn_agent` draws its bubble here:
      // its arguments exist nowhere else. Every other named tool (MCP included)
      // arrives as a completed item, which carries input AND result together.
      if (payload.type === 'function_call' && payload.name) {
        const fnName = payload.name;
        if (fnName === CODEX_WAIT_FN_NAME && payload.call_id) waitCallIds.add(payload.call_id);

        if (fnName === CODEX_SPAWN_FN_NAME) {
          const assistant = ensureAssistant(timestamp);
          let input: Record<string, unknown> = {};
          try { input = JSON.parse(payload.arguments || '{}'); } catch { /* */ }
          assistant.toolCalls = assistant.toolCalls || [];
          const callId = payload.call_id || `tool-${msgCounter++}`;
          assistant.parts = appendToolPart(assistant.parts, callId);
          const toolCall: CodexToolCall = {
            id: callId,
            name: normalizeCodexToolName(fnName),
            input: normalizeCodexToolInput(fnName, input),
            isLoading: false,
          };
          assistant.toolCalls.push(toolCall);
          toolByCallId.set(callId, toolCall);
          spawnByCallId.set(callId, toolCall);
          toolSinceText = true;
        }
      }

      // Tool result (function_call_output)
      if (payload.type === 'function_call_output' && payload.call_id) {
        const callId = payload.call_id;
        const spawned = spawnByCallId.get(callId);
        const output = codexToolOutputText(payload.output);

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
          ensureAssistant(timestamp);
          const tc = toolByCallId.get(callId);
          if (tc) {
            tc.result = output;
            tc.isLoading = false;
          }
        }
      }

      /**
       * The exception path: a custom tool call that will never produce an item.
       *
       * gpt-5.6 routes everything through one freeform `exec` script, and only
       * the bodies that actually run a command line or apply a patch yield a
       * `command_execution` / `file_change` item. The rest — `write_stdin`,
       * `create_goal`, a body too dynamic to read statically — measured at ~5%
       * of exec calls, produce nothing, and would otherwise vanish. A name
       * outside CODEX_CUSTOM_TOOL_NAMES is the same case: unknown shape, no
       * item, but the call did happen.
       *
       * Anything that WILL get an item is skipped here on purpose; letting both
       * paths draw it is how a turn ends up with the same call twice.
       */
      if (payload.type === 'custom_tool_call' && payload.name) {
        const known = CODEX_CUSTOM_TOOL_NAMES.has(payload.name);
        const isExecScript = payload.name === CODEX_EXEC_SCRIPT_FN_NAME;
        // Only a body that runs a command line or applies a patch yields an
        // item. `other` (a named tool like write_stdin) and `unknown` (a body
        // too dynamic to read) both yield nothing — the same split the rollout
        // reader used to make before the ids made it unnecessary.
        const execKind = isExecScript ? parseCodexExecScript(payload.input || '').kind : null;
        const producesItem = known && (!isExecScript || execKind === 'exec' || execKind === 'patch');

        if (!producesItem) {
          const assistant = ensureAssistant(timestamp);
          assistant.toolCalls = assistant.toolCalls || [];
          const callId = payload.call_id || `tool-${msgCounter++}`;
          assistant.parts = appendToolPart(assistant.parts, callId);
          const { name, input } = !known
            ? { name: payload.name, input: { input: payload.input || '' } }
            : codexExecScriptCall(payload.input || '');
          const customCall: CodexToolCall = { id: callId, name, input, isLoading: false };
          assistant.toolCalls.push(customCall);
          toolByCallId.set(callId, customCall);
          toolSinceText = true;
        }
      }

      // Custom tool call result (apply_patch / exec output)
      if (payload.type === 'custom_tool_call_output' && payload.call_id) {
        ensureAssistant(timestamp);
        const tc = toolByCallId.get(payload.call_id);
        if (tc) {
          tc.result = codexToolOutputText(payload.output);
          tc.isLoading = false;
        }
      }

      // Any other response_item carrying a call_id is a tool call we have no branch
      // for (see parseCodexUnknownCall). Render it under its raw type rather than
      // dropping it — that is how `tool_search_call` stayed invisible since 0.141.
      // A shared call_id means this is the paired output, not a second call.
      // codexFork's walker mirrors this, or a fork cuts at the wrong message.
      const unknownCall = parseCodexUnknownCall(payload);
      if (unknownCall) {
        const assistant = ensureAssistant(timestamp);
        const existing = toolByCallId.get(unknownCall.callId);
        if (existing) {
          existing.result = codexUnknownCallResult(payload as unknown as Record<string, unknown>);
          existing.isLoading = false;
        } else {
          assistant.toolCalls = assistant.toolCalls || [];
          assistant.parts = appendToolPart(assistant.parts, unknownCall.callId);
          const unknownTool: CodexToolCall = {
            id: unknownCall.callId,
            name: unknownCall.name,
            input: unknownCall.input,
            isLoading: false,
          };
          assistant.toolCalls.push(unknownTool);
          toolByCallId.set(unknownCall.callId, unknownTool);
          toolSinceText = true;
        }
      }
    }

    // Sub-agent start (0.147+). The only line binding a spawn's call_id to the thread
    // it created, which is what both the drill-in and the report routing key off. It
    // creates no message of its own — codexFork's line walker therefore needs no
    // matching branch.
    if (type === 'event_msg') {
      const activity = parseCodexSubAgentActivity(payload);
      const spawned = activity ? spawnByCallId.get(activity.callId) : undefined;
      if (activity && spawned) {
        agentToCall.set(activity.agentThreadId, spawned);
        if (activity.agentPath) agentPathToCall.set(activity.agentPath, spawned);
        // Same key the ≤ 0.14x path sets from spawn_agent's output: the client uses
        // it to tell a spawned agent from one that never started.
        spawned.input = { ...spawned.input, agent_id: activity.agentThreadId };
      }
    }

    /**
     * The tool bubbles. `item_completed` carries the call's id, its input and
     * its result in one record, and `codexItemBubble` is the same function the
     * live engine draws from — so a bubble is identical live and after a reload,
     * with nothing rewritten in between.
     *
     * Written only by the app-server transport. A rollout from the old `exec`
     * transport has none of these lines and therefore no tool bubbles; that is
     * the deliberate cost of not carrying a second, contradictory code path.
     */
    if (type === 'event_msg' && payload.type === 'item_completed' && payload.item) {
      const bubble = codexItemBubble(payload.item as CodexItemLike);
      if (bubble && !drawnToolIds.has(bubble.id)) {
        drawnToolIds.add(bubble.id);
        const assistant = ensureAssistant(timestamp);
        assistant.toolCalls = assistant.toolCalls || [];
        assistant.parts = appendToolPart(assistant.parts, bubble.id);
        assistant.toolCalls.push({
          id: bubble.id,
          name: bubble.name,
          input: bubble.input,
          result: bubble.result,
          isLoading: false,
        });
        toolSinceText = true;
      }
    }

    // Web search. Unlike every other tool this is NOT persisted as a function_call:
    // the `response_item`/`web_search_call` line has no id at all, so the only usable
    // record is this event_msg — which carries the same `ws_…` id the live item uses.
    if (type === 'event_msg' && payload.type === 'web_search_end' && payload.call_id
        && !drawnToolIds.has(payload.call_id)) {
      drawnToolIds.add(payload.call_id);
      const assistant = ensureAssistant(timestamp);
      const { name, input, result } = codexWebSearchCall(payload.query, payload.action);
      assistant.toolCalls = assistant.toolCalls || [];
      assistant.parts = appendToolPart(assistant.parts, payload.call_id);
      assistant.toolCalls.push({ id: payload.call_id, name, input, result, isLoading: false });
      toolSinceText = true;
    }

    // A failed turn. codex records the reason ONLY here — the CLI exits non-zero with
    // it absent from stderr, so the SDK's thrown Error carries no reason at all and the
    // live ⚠️ banner (orchestrator → applyStreamEvent) reads "exited with code 1".
    // Without this branch the reason is lost on reload and the turn replays as its last
    // tool call and nothing else. Same shape as applyStreamEvent's banner so `content`
    // stays byte-identical to deriveContent(parts); codexFork mirrors it (see the
    // ensureCodexAssistantId call there) or msgCounter drifts and forks cut wrong.
    if (type === 'event_msg' && payload.type === 'task_complete' && payload.error?.message) {
      const assistant = ensureAssistant(timestamp);
      const banner = `⚠️ ${payload.error.message}`;
      assistant.content = joinAssistantText(assistant.content || '', banner, true);
      assistant.parts = appendTextPart(assistant.parts, banner, true);
    }

    // Usage. codex reports it per request on an `event_msg`/`token_count` line; the
    // last one wins, which is the current context size (see parseCodexTokenUsage).
    if (type === 'event_msg') {
      const usage = parseCodexTokenUsage(payload);
      if (usage) lastUsage = usage;
    }

    // `response_completed` is claude-era plumbing kept for old transcripts only: no
    // codex version in the local corpus (0.94 → 0.147, 148 rollouts) writes it, so
    // this is also why usage had to move to token_count above.
    if (type === 'response_completed') {
      const usage = (payload as Record<string, unknown>).usage as TokenUsage | undefined;
      if (usage) lastUsage = usage;
      flushAssistant();
    }
  }

  flushAssistant();

  return { messages, title, usage: lastUsage };
}
