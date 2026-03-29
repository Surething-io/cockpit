import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as readline from 'readline';
import { getClaudeSessionPath } from '@/lib/paths';

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
  message?: {
    role?: string;
    content?: Array<{
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

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImage[];
  timestamp?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
  }>;
}


// File fingerprint: mtime + size, lightweight check for file changes
function getFileFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}-${stat.size}`;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const cwd = body.cwd as string;
    const sessionId = body.sessionId as string;
    // Pagination params: limit = number of turns per page (one turn = user + assistant message pair)
    // beforeTurnIndex = load messages before this turn index (used for scroll-up to load more)
    const limit = body.limit as number | undefined;
    const beforeTurnIndex = body.beforeTurnIndex as number | undefined;
    // Lightweight check: client sends last fingerprint; return a 304-equivalent if unchanged
    const ifFingerprint = body.ifFingerprint as string | undefined;

    if (!cwd || !sessionId) {
      return new Response(JSON.stringify({ error: 'Missing cwd or sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build the full session file path
    const sessionPath = getClaudeSessionPath(cwd, sessionId);

    // Check if the file exists
    if (!fs.existsSync(sessionPath)) {
      return new Response(JSON.stringify({ error: 'Session not found', messages: [] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get the file fingerprint
    const fingerprint = getFileFingerprint(sessionPath);

    // If the client fingerprint matches the server's, data is unchanged; skip parsing
    if (ifFingerprint && ifFingerprint === fingerprint) {
      return new Response(JSON.stringify({ notModified: true, fingerprint }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read and parse the JSONL file (with pagination support)
    const { messages, title, usage, totalTurns, hasMore } = await parseTranscriptFile(sessionPath, limit, beforeTurnIndex);

    return new Response(JSON.stringify({ messages, sessionId, title, usage, totalTurns, hasMore, fingerprint }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Session by path API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// Filter command tags and extract meaningful content
function filterCommandTags(text: string): string {
  // First try to extract command-args
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim()) {
    return argsMatch[1].trim();
  }
  // If no args, try to extract command-name
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch && nameMatch[1].trim()) {
    return nameMatch[1].trim();
  }
  // Filter all command tags
  let filtered = text.replace(/<command-message>[^<]*<\/command-message>/g, '');
  filtered = filtered.replace(/<command-name>[^<]*<\/command-name>/g, '');
  filtered = filtered.replace(/<command-args>[^<]*<\/command-args>/g, '');
  filtered = filtered.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  filtered = filtered.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  return filtered.trim();
}

// Generate a title (no truncation, preserve full content)
function generateTitle(summary: string, userMessages: string[]): string {
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // If it's a command (starts with /), save the command name and continue to the next message
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // If a command name was saved before, combine them
    if (commandName) {
      return `${commandName} ${filtered}`;
    }

    // Regular message used directly as the title
    return filtered;
  }

  // If there is only a command name with no subsequent messages, show the command name
  if (commandName) return commandName;

  return 'Untitled Session';
}

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
  let summary = '';
  const userTextMessages: string[] = [];
  let lastUsage: TokenUsage | undefined;

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptMessage & { summary?: string; isMeta?: boolean };
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

        // Collect user text messages for title generation
        if (obj.type === 'user' && !obj.isMeta && obj.message?.content) {
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
  const title = generateTitle(summary, userTextMessages);

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

function convertToChatMessages(rawMessages: TranscriptMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  let currentAssistantMessage: ChatMessage | null = null;
  const toolResults = new Map<string, string>();

  // First pass: collect all tool results
  for (const msg of rawMessages) {
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content || '');
        }
      }
    }
  }

  // Second pass: build the message list
  for (const msg of rawMessages) {
    // Handle user text messages
    if (msg.type === 'user' && msg.message?.role === 'user' && msg.message?.content) {
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
        if (currentAssistantMessage) {
          currentAssistantMessage.content += textBlocks.map((b) => b.text || '').join('\n');
        } else {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: textBlocks.map((b) => b.text || '').join('\n'),
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }
      }

      if (toolBlocks.length > 0) {
        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: msg.uuid || `assistant-${Date.now()}`,
            role: 'assistant',
            content: '',
            timestamp: msg.timestamp,
            toolCalls: [],
          };
        }

        for (const tool of toolBlocks) {
          if (tool.name && tool.id) {
            currentAssistantMessage.toolCalls!.push({
              id: tool.id,
              name: tool.name,
              input: tool.input || {},
              result: toolResults.get(tool.id),
              isLoading: false,
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
