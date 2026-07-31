// Pure transcript → ChatMessage conversion for Claude-style jsonl sessions.
//
// Deliberately NOT in history.ts: that module is re-exported wholesale by the
// Next route shim (`export *` in src/app/api/session/[sessionId]/history/route.ts),
// and Next rejects any export from a route file that is not a route field —
// exporting the parser there fails the production type check. Keeping the logic
// here also matches MODULES.md: the route file is a mount point, not a home for
// business code.
import * as fs from 'fs';
import * as readline from 'readline';
import { appendTextPart, appendToolPart, joinAssistantText } from '../../../shared/assistantText';
import type { MessagePart } from '../../../shared/assistantText';

export interface TranscriptMessage {
  type: string;
  // Harness-injected (non-typed) user messages — routed out of the user-bubble
  // bucket. See session-by-path.ts for the same treatment.
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
      // Image-related fields
      source?: {
        type: string;
        media_type: string;
        data: string;
      };
    }>;
  };
  uuid?: string;
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

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: MessageImage[];
  timestamp?: string;
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
    skillContent?: string;
  }>;
}

// Plain text of a user message, whether string- or block-form.
function messageText(msg: TranscriptMessage): string {
  const c = msg.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  return '';
}

// The harness-injection kind of a user message, or null if it's a real user turn.
function injectionKind(msg: TranscriptMessage): 'skill' | 'task-notification' | 'meta' | null {
  if (msg.isMeta && msg.sourceToolUseID) return 'skill';
  if (msg.origin?.kind === 'task-notification') return 'task-notification';
  if (msg.origin?.kind && msg.origin.kind !== 'human') return 'meta';
  if (msg.isMeta) return 'meta';
  if (msg.isCompactSummary) return 'meta'; // context-compaction continuation notice (no isMeta on some versions)
  return null;
}

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
export async function parseTranscriptFile(filePath: string): Promise<ChatMessage[]> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  const rawMessages: TranscriptMessage[] = [];

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptMessage;
      if (obj.type === 'user' || obj.type === 'assistant') {
        rawMessages.push(obj);
      }
    } catch {
      // Ignore lines with parse errors
    }
  }

  // Convert message format
  return convertToChatMessages(rawMessages);
}

// Exported for the reload-path tests: this is the half of the byte-identical
// contract that runs on page refresh, so it is worth pinning directly rather
// than only through the route.
// Exported alongside parseTranscriptFile so the reload half of the #parts
// contract can be tested directly (history.parts.test.ts) without touching disk.
export function convertToChatMessages(rawMessages: TranscriptMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  let currentAssistantMessage: ChatMessage | null = null;
  // True when a tool_use has landed on the current assistant bubble since its
  // last text segment — the next text segment then starts a new paragraph.
  // Kept in lockstep with the live reducer's pendingTextBreak (assistantText.ts).
  let toolSinceText = false;
  const toolResults = new Map<string, string>();
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
      // Route harness-injected messages out of the user-bubble bucket:
      // skill bodies fold into their tool call; task-notification / meta → system-event row.
      const injected = injectionKind(msg);
      if (injected) {
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
      // content may be a string or an array
      const content = msg.message.content;
      if (typeof content === 'string') {
        // If there is an unfinished assistant message, save it first
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

      // Only create a user message when there is text or images
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        // If there is an unfinished assistant message, save it first
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

        // Add images
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

      // Start of a new conversation turn (has text content and the previous assistant message is done)
      if (textBlocks.length > 0) {
        const entryText = textBlocks.map((b) => b.text || '').join('');
        if (currentAssistantMessage) {
          // Append text to the current message, breaking a paragraph only if a
          // tool_use has intervened since the previous text (matches live reducer).
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

      // Handle tool calls
      if (toolBlocks.length > 0) {
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: '',
            parts: [],
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

  // Save the last assistant message
  if (currentAssistantMessage) {
    chatMessages.push(currentAssistantMessage);
  }

  return chatMessages;
}
