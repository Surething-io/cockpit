import { GLOBAL_STATE_FILE, readJsonFile, writeJsonFile, withFileLock, getClaudeSessionPath } from './paths';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

export type SessionStatus = 'normal' | 'loading' | 'unread';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: SessionStatus;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

const MAX_SESSIONS = 15;

/**
 * 更新全局 session 状态
 * 使用 withFileLock 串行化并发的 read-modify-write，防止多个定时任务
 * 同时触发时因竞态条件导致 sessions 数据丢失。
 */
export async function updateGlobalState(
  cwd: string,
  sessionId: string,
  status: SessionStatus,
  title?: string,
  lastUserMessage?: string
): Promise<void> {
  // 防御：跳过不存在的路径（避免写入错误解码的 cwd）
  if (!existsSync(cwd)) {
    return;
  }

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

    // 兼容旧格式：isLoading → status
    for (const s of state.sessions) {
      if (!s.status) {
        const legacy = s as GlobalSession & { isLoading?: boolean };
        s.status = legacy.isLoading ? 'loading' : 'normal';
        delete legacy.isLoading;
      }
    }

    // 查找是否已存在
    const existingIndex = state.sessions.findIndex(
      s => s.cwd === cwd && s.sessionId === sessionId
    );

    // 保留现有字段（如果没有传入新的）
    const existing = existingIndex >= 0 ? state.sessions[existingIndex] : undefined;

    const newSession: GlobalSession = {
      cwd,
      sessionId,
      lastActive: Date.now(),
      status,
      title: title || existing?.title,
      lastUserMessage: lastUserMessage || existing?.lastUserMessage,
    };

    if (existingIndex >= 0) {
      state.sessions[existingIndex] = newSession;
    } else {
      state.sessions.push(newSession);
    }

    // 按 lastActive 降序排序
    state.sessions.sort((a, b) => b.lastActive - a.lastActive);

    // 只保留最近 MAX_SESSIONS 个
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);

    await writeJsonFile(GLOBAL_STATE_FILE, state);
  });
}

/**
 * 从 transcript 文件获取 session 标题
 */
export async function getSessionTitle(cwd: string, sessionId: string): Promise<string> {
  const filePath = getClaudeSessionPath(cwd, sessionId);

  if (!existsSync(filePath)) {
    return 'Untitled Session';
  }

  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let summary = '';
    const userMessages: string[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // 提取 summary
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
        }

        // 提取 user 消息文本
        if (entry.type === 'user') {
          const message = entry.message;
          if (message?.content) {
            if (typeof message.content === 'string') {
              userMessages.push(message.content);
            } else if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  userMessages.push(block.text);
                }
              }
            }
          }
        }
      } catch {
        // 忽略解析错误
      }
    }

    return generateTitle(summary, userMessages);
  } catch {
    return 'Untitled Session';
  }
}

/**
 * 从 transcript 文件获取最后一条用户消息
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const filePath = getClaudeSessionPath(cwd, sessionId);

  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lastUserMessage: string | undefined;

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // 提取 user 消息文本
        if (entry.type === 'user') {
          const message = entry.message;
          if (message?.content) {
            let text = '';
            if (typeof message.content === 'string') {
              text = message.content;
            } else if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  text = block.text;
                  break; // 只取第一个文本块
                }
              }
            }
            if (text) {
              // 过滤命令标签
              const filtered = filterCommandTags(text);
              // 检查是否是有效的用户消息
              if (filtered && isValidUserMessage(filtered)) {
                lastUserMessage = filtered;
              }
            }
          }
        }
      } catch {
        // 忽略解析错误
      }
    }

    return lastUserMessage;
  } catch {
    return undefined;
  }
}

/**
 * 过滤掉消息中的命令和系统标签
 */
function filterCommandTags(text: string): string {
  // 移除 <command-*> 标签及其内容
  let filtered = text.replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '');
  // 移除 <local-command-*> 标签及其内容
  filtered = filtered.replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '');
  // 移除多余空白
  filtered = filtered.trim();
  return filtered;
}

/**
 * 检查消息是否是有效的用户消息（非系统消息）
 */
function isValidUserMessage(text: string): boolean {
  // 过滤掉系统上下文消息
  if (text.startsWith('This session is being continued')) return false;
  if (text.startsWith('Caveat: The messages below')) return false;
  // 过滤空消息
  if (!text.trim()) return false;
  return true;
}

/**
 * 生成标题
 */
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
