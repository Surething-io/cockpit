import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as readline from 'readline';
import { getClaudeSessionPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
      // 图片相关字段
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await params;

    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'Missing sessionId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 动态获取当前工作目录并构造 transcript 文件路径
    const cwd = process.cwd();
    const transcriptPath = getClaudeSessionPath(cwd, sessionId);

    // 检查文件是否存在
    if (!fs.existsSync(transcriptPath)) {
      return new Response(JSON.stringify({ error: 'Session not found', messages: [] }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 读取并解析 JSONL 文件
    const messages = await parseTranscriptFile(transcriptPath);

    return new Response(JSON.stringify({ messages }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('History API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function parseTranscriptFile(filePath: string): Promise<ChatMessage[]> {
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
      // 忽略解析错误的行
    }
  }

  // 转换消息格式
  return convertToChatMessages(rawMessages);
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
      // content 可能是字符串或数组
      const content = msg.message.content;
      if (typeof content === 'string') {
        // 如果有未完成的 assistant 消息，先保存
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

      // 只有当有文本或图片时才创建用户消息
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        // 如果有未完成的 assistant 消息，先保存
        if (currentAssistantMessage) {
          chatMessages.push(currentAssistantMessage);
          currentAssistantMessage = null;
        }

        const userMessage: ChatMessage = {
          id: msg.uuid || `user-${Date.now()}`,
          role: 'user',
          content: textBlocks.map((b) => b.text || '').join('\n'),
        };

        // 添加图片
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

      // 如果是新的一轮对话（有文本内容且之前的 assistant 消息已完成）
      if (textBlocks.length > 0) {
        if (currentAssistantMessage) {
          // 追加文本到当前消息
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

      // 处理工具调用
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

  // 保存最后一个 assistant 消息
  if (currentAssistantMessage) {
    chatMessages.push(currentAssistantMessage);
  }

  return chatMessages;
}
