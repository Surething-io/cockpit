import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as readline from 'readline';
import * as os from 'os';
import * as path from 'path';

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
  media_type: 'image/png';
  data: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImage[];
  toolCalls?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isLoading: boolean;
  }>;
}

// 根据 cwd 和 sessionId 构建 session 文件路径
function buildSessionPath(cwd: string, sessionId: string): string {
  const homeDir = os.homedir();
  // 对 cwd 进行编码：将 / 替换为 -（与 Claude 实际存储方式一致）
  const encodedCwd = cwd.replace(/\//g, '-');
  return path.join(homeDir, '.claude', 'projects', encodedCwd, `${sessionId}.jsonl`);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const cwd = body.cwd as string;
    const sessionId = body.sessionId as string;

    if (!cwd || !sessionId) {
      return new Response(JSON.stringify({ error: 'Missing cwd or sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 构建完整的 session 文件路径
    const sessionPath = buildSessionPath(cwd, sessionId);

    // 检查文件是否存在
    if (!fs.existsSync(sessionPath)) {
      return new Response(JSON.stringify({ error: 'Session not found', messages: [] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 读取并解析 JSONL 文件
    const { messages, title, usage } = await parseTranscriptFile(sessionPath);

    return new Response(JSON.stringify({ messages, sessionId, title, usage }), {
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

// 过滤命令标签，提取有意义的内容
function filterCommandTags(text: string): string {
  // 首先尝试提取 command-args
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim()) {
    return argsMatch[1].trim();
  }
  // 如果没有 args，尝试提取 command-name
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch && nameMatch[1].trim()) {
    return nameMatch[1].trim();
  }
  // 过滤所有命令标签
  let filtered = text.replace(/<command-message>[^<]*<\/command-message>/g, '');
  filtered = filtered.replace(/<command-name>[^<]*<\/command-name>/g, '');
  filtered = filtered.replace(/<command-args>[^<]*<\/command-args>/g, '');
  filtered = filtered.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  filtered = filtered.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  return filtered.trim();
}

// 截断消息到指定长度
function truncateMessage(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

// 生成标题（不截断，保留完整内容）
function generateTitle(summary: string, userMessages: string[]): string {
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // 如果是命令（以/开头），保存命令名并继续找下一条消息
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // 如果之前有命令名，组合显示
    if (commandName) {
      return `${commandName} ${filtered}`;
    }

    // 普通消息直接作为标题
    return filtered;
  }

  // 如果只有命令名没有后续消息，显示命令名
  if (commandName) return commandName;

  return 'Untitled Session';
}

async function parseTranscriptFile(filePath: string): Promise<{ messages: ChatMessage[]; title: string; usage?: TokenUsage }> {
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
        rawMessages.push(obj);

        // 收集最后一条 assistant 消息的 usage
        if (obj.type === 'assistant' && obj.message?.usage) {
          lastUsage = obj.message.usage;
        }

        // 收集用户文本消息用于生成标题
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
      // 收集 summary
      if (obj.type === 'summary' && obj.summary) {
        summary = obj.summary;
      }
    } catch {
      // 忽略解析错误的行
    }
  }

  // 转换消息格式
  const messages = convertToChatMessages(rawMessages);
  const title = generateTitle(summary, userTextMessages);

  return { messages, title, usage: lastUsage };
}

function convertToChatMessages(rawMessages: TranscriptMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = [];
  let currentAssistantMessage: ChatMessage | null = null;
  const toolResults = new Map<string, string>();

  // 第一遍：收集所有工具结果
  for (const msg of rawMessages) {
    if (msg.type === 'user' && msg.message?.content && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          toolResults.set(block.tool_use_id, block.content || '');
        }
      }
    }
  }

  // 第二遍：构建消息列表
  for (const msg of rawMessages) {
    // 处理用户文本消息
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
        };

        if (imageBlocks.length > 0) {
          userMessage.images = imageBlocks.map((b) => ({
            type: 'base64' as const,
            media_type: (b.source?.media_type || 'image/png') as 'image/png',
            data: b.source?.data || '',
          }));
        }

        chatMessages.push(userMessage);
      }
    }

    // 处理助手消息
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
