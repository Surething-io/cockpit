import type { CodeComment } from '@/app/api/comments/route';

// ============================================
// 评论变更事件系统
// ============================================

type CommentsChangeListener = () => void;
const listeners = new Set<CommentsChangeListener>();

/** 订阅评论变更事件 */
export function subscribeCommentsChange(listener: CommentsChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 触发评论变更事件（通知所有订阅者刷新） */
export function emitCommentsChange(): void {
  listeners.forEach(listener => listener());
}

// ============================================
// Types
// ============================================

export interface CommentWithCode extends CodeComment {
  codeContent: string;
}

export interface CodeReference {
  filePath: string;
  startLine: number;
  endLine: number;
  codeContent: string;
  note?: string; // 评论内容，可选
}

/**
 * 获取所有评论并读取对应代码
 */
export async function fetchAllCommentsWithCode(cwd: string): Promise<CommentWithCode[]> {
  // 1. 获取所有评论
  const response = await fetch(`/api/comments?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch comments');
  }
  const data = await response.json();
  const comments: CodeComment[] = data.comments || [];

  if (comments.length === 0) {
    return [];
  }

  // 2. 按文件分组（跳过有 selectedText 的评论，不需要读取文件）
  const commentsByFile = new Map<string, CodeComment[]>();
  for (const comment of comments) {
    if (comment.selectedText) continue; // 有 selectedText 的评论不需要读文件
    if (!commentsByFile.has(comment.filePath)) {
      commentsByFile.set(comment.filePath, []);
    }
    commentsByFile.get(comment.filePath)!.push(comment);
  }

  // 3. 读取每个文件的内容
  const fileContents = new Map<string, string[]>();
  await Promise.all(
    Array.from(commentsByFile.keys()).map(async (filePath) => {
      try {
        const fileResponse = await fetch(
          `/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`
        );
        if (fileResponse.ok) {
          const fileData = await fileResponse.json();
          if (fileData.type === 'text' && fileData.content) {
            fileContents.set(filePath, fileData.content.split('\n'));
          }
        }
      } catch (err) {
        console.error(`Failed to read file ${filePath}:`, err);
      }
    })
  );

  // 4. 为每个评论提取代码
  const result: CommentWithCode[] = [];
  for (const comment of comments) {
    // 有 selectedText 的评论直接用 selectedText 作为 codeContent
    if (comment.selectedText) {
      result.push({ ...comment, codeContent: comment.selectedText });
      continue;
    }
    const lines = fileContents.get(comment.filePath);
    let codeContent = '';
    if (lines) {
      const startIdx = Math.max(0, comment.startLine - 1);
      const endIdx = Math.min(lines.length, comment.endLine);
      codeContent = lines.slice(startIdx, endIdx).join('\n');
    }
    result.push({ ...comment, codeContent });
  }

  return result;
}

/**
 * 清空所有评论
 */
export async function clearAllComments(cwd: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/comments?cwd=${encodeURIComponent(cwd)}&all=true`,
      { method: 'DELETE' }
    );
    if (response.ok) {
      // 触发全局刷新事件
      emitCommentsChange();
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to clear comments:', err);
    return false;
  }
}

/**
 * 构建发送到 AI 的消息
 * @param references 所有代码引用（历史评论 + 当前选中）
 * @param question 用户问题
 */
/** 虚拟 filePath 前缀，用于 AI 消息气泡中的评论 */
export const CHAT_COMMENT_FILE = '__chat__';

export function buildAIMessage(references: CodeReference[], question: string): string {
  const chatRefs = references.filter(r => r.filePath === CHAT_COMMENT_FILE);
  const fileRefs = references.filter(r => r.filePath !== CHAT_COMMENT_FILE);
  const parts: string[] = [];

  // 文件评论：保持原有格式
  if (fileRefs.length > 0) {
    parts.push('代码引用:', '');
    fileRefs.forEach((ref, index) => {
      parts.push(`[${index + 1}] ${ref.filePath}:${ref.startLine}-${ref.endLine}`);
      parts.push('```');
      parts.push(ref.codeContent);
      parts.push('```');
      if (ref.note) {
        parts.push(`备注: ${ref.note}`);
      }
      parts.push('');
    });
  }

  // 聊天评论：引用 + 评论
  for (const ref of chatRefs) {
    const quoted = ref.codeContent.split('\n').map(l => `> ${l}`).join('\n');
    parts.push(quoted);
    if (ref.note) {
      parts.push(ref.note);
    }
    parts.push('');
  }

  parts.push(`问题: ${question}`);

  return parts.join('\n');
}
