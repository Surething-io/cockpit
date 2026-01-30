import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
}

interface TranscriptLine {
  type?: string;
  summary?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

// 截断消息到指定长度
function truncateMessage(msg: string, maxLength: number = 50): string {
  if (msg.length <= maxLength) return msg;
  return msg.slice(0, maxLength) + '...';
}

// 过滤 command 标签，提取纯文本内容
function filterCommandTags(text: string): string {
  // 提取 <command-args> 中的内容（这是用户实际输入的内容）
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim()) {
    return argsMatch[1].trim();
  }
  // 如果没有 args 或 args 为空，提取命令名称（如 /qa）
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch && nameMatch[1].trim()) {
    return nameMatch[1].trim();
  }
  // 移除所有 command 和系统标签
  let filtered = text.replace(/<command-message>[^<]*<\/command-message>/g, '');
  filtered = filtered.replace(/<command-name>[^<]*<\/command-name>/g, '');
  filtered = filtered.replace(/<command-args>[^<]*<\/command-args>/g, '');
  filtered = filtered.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  filtered = filtered.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  // 清理多余空白
  return filtered.trim();
}

// 生成标题：优先 summary，其次遍历 userMessages 找到第一个有效内容
// 如果第一条是纯命令（如 /qa），则追加下一条有效内容
function generateTitle(summary: string, userMessages: string[]): string {
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // 如果是纯命令（以 / 开头），记录下来并继续找下一条
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // 找到实际内容（不截断，保留完整内容）
    if (commandName) {
      // 追加命令名和实际内容
      return `${commandName} ${filtered}`;
    }
    return filtered;
  }

  // 如果只有命令没有后续内容
  if (commandName) return commandName;
  return 'Untitled Session';
}

// 从 jsonl 文件提取用户消息内容
function extractUserMessageContent(line: TranscriptLine): string | null {
  // 跳过非用户消息和元数据消息
  if (line.type !== 'user') return null;
  if (line.isMeta) return null;

  const content = line.message?.content;
  if (!content) return null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlocks = content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      return textBlocks.map(b => b.text || '').join(' ');
    }
  }

  return null;
}

// 解析单个 session 文件
async function parseSessionFile(filePath: string): Promise<{ title: string; userMessages: string[] }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let title = '';
  const userMessages: string[] = [];

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptLine;

      // 提取标题 (summary)
      if (obj.type === 'summary' && obj.summary) {
        title = obj.summary;
      }

      // 提取用户消息
      const msgContent = extractUserMessageContent(obj);
      if (msgContent) {
        userMessages.push(msgContent);
      }
    } catch {
      // 忽略解析错误
    }
  }

  return { title, userMessages };
}

// 获取文件修改时间
function getFileModifiedTime(filePath: string): Date {
  const stats = fs.statSync(filePath);
  return stats.mtime;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ encodedPath: string }> }
) {
  try {
    const { encodedPath } = await params;

    if (!encodedPath) {
      return new Response(JSON.stringify({ error: 'Missing encodedPath' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const homeDir = os.homedir();
    const projectPath = path.join(homeDir, '.claude', 'projects', encodedPath);

    // 检查目录是否存在
    if (!fs.existsSync(projectPath)) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 读取所有 .jsonl 文件（排除 agent-* 开头的子进程文件）
    const sessionFiles = fs.readdirSync(projectPath)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        name: file,
        path: path.join(projectPath, file),
        modifiedAt: getFileModifiedTime(path.join(projectPath, file)),
      }))
      // 按修改时间倒序排序
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    const sessions: SessionInfo[] = [];

    for (const sessionFile of sessionFiles) {
      try {
        const { title, userMessages } = await parseSessionFile(sessionFile.path);

        // 过滤掉没有用户消息的空 session（只有 queue-operation）
        if (userMessages.length === 0) {
          continue;
        }

        // 获取前5条和后5条用户消息
        let firstMessages: string[] = [];
        let lastMessages: string[] = [];

        if (userMessages.length <= 10) {
          // 总数不超过10条，全部放在 firstMessages
          firstMessages = userMessages.map(m => truncateMessage(m));
        } else {
          firstMessages = userMessages.slice(0, 5).map(m => truncateMessage(m));
          lastMessages = userMessages.slice(-5).map(m => truncateMessage(m));
        }

        sessions.push({
          path: sessionFile.path,
          title: generateTitle(title, userMessages),
          modifiedAt: sessionFile.modifiedAt.toISOString(),
          firstMessages,
          lastMessages,
        });
      } catch (error) {
        console.error(`Error parsing session file ${sessionFile.path}:`, error);
        // 跳过解析失败的文件
      }
    }

    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Project sessions API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
