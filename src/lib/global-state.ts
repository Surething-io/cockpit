import { GLOBAL_STATE_FILE, readJsonFile, writeJsonFile, getClaudeSessionPath } from './paths';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
}

interface GlobalState {
  sessions: GlobalSession[];
}

const MAX_SESSIONS = 10;

/**
 * 更新全局 session 状态
 */
export async function updateGlobalState(
  cwd: string,
  sessionId: string,
  isLoading: boolean,
  title?: string
): Promise<void> {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

  // 查找是否已存在
  const existingIndex = state.sessions.findIndex(
    s => s.cwd === cwd && s.sessionId === sessionId
  );

  // 保留现有 title（如果没有传入新的）
  const existingTitle = existingIndex >= 0 ? state.sessions[existingIndex].title : undefined;

  const newSession: GlobalSession = {
    cwd,
    sessionId,
    lastActive: Date.now(),
    isLoading,
    title: title || existingTitle,
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
 * 过滤掉消息中的命令标签
 */
function filterCommandTags(text: string): string {
  // 移除 <command-*> 标签及其内容
  let filtered = text.replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '');
  // 移除多余空白
  filtered = filtered.trim();
  return filtered;
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
