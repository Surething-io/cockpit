import type { CodeComment } from '@/app/api/comments/route';
import i18n from '@/lib/i18n';

// ============================================
// Comment change event system
// ============================================

type CommentsChangeListener = () => void;
const listeners = new Set<CommentsChangeListener>();

/** Subscribe to comment change events */
export function subscribeCommentsChange(listener: CommentsChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Emit a comment change event (notify all subscribers to refresh) */
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
  note?: string; // Optional comment text
}

/**
 * Fetch all comments and read the corresponding code
 */
export async function fetchAllCommentsWithCode(cwd: string): Promise<CommentWithCode[]> {
  // 1. Fetch all comments
  const response = await fetch(`/api/comments?cwd=${encodeURIComponent(cwd)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch comments');
  }
  const data = await response.json();
  const comments: CodeComment[] = data.comments || [];

  if (comments.length === 0) {
    return [];
  }

  // 2. Group by file (skip comments with selectedText — no need to read the file)
  const commentsByFile = new Map<string, CodeComment[]>();
  for (const comment of comments) {
    if (comment.selectedText) continue; // Comments with selectedText do not need to read the file
    if (!commentsByFile.has(comment.filePath)) {
      commentsByFile.set(comment.filePath, []);
    }
    commentsByFile.get(comment.filePath)!.push(comment);
  }

  // 3. Read the content of each file
  const fileContents = new Map<string, string[]>();
  await Promise.all(
    Array.from(commentsByFile.keys()).map(async (filePath) => {
      try {
        const fileResponse = await fetch(
          `/api/files/text?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`
        );
        if (fileResponse.ok) {
          const fileData = await fileResponse.json();
          if (typeof fileData.content === 'string') {
            fileContents.set(filePath, fileData.content.split('\n'));
          }
        }
      } catch (err) {
        console.error(`Failed to read file ${filePath}:`, err);
      }
    })
  );

  // 4. Extract code for each comment
  const result: CommentWithCode[] = [];
  for (const comment of comments) {
    // For comments with selectedText, use selectedText directly as codeContent
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
 * Clear all comments
 */
export async function clearAllComments(cwd: string): Promise<boolean> {
  try {
    const response = await fetch(
      `/api/comments?cwd=${encodeURIComponent(cwd)}&all=true`,
      { method: 'DELETE' }
    );
    if (response.ok) {
      // Emit global refresh event
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
 * Build the message to send to AI
 * @param references All code references (historical comments + current selection)
 * @param question User question
 */
/** Virtual filePath prefix used for comments in AI message bubbles */
export const CHAT_COMMENT_FILE = '__chat__';

export function buildAIMessage(references: CodeReference[], question: string): string {
  const chatRefs = references.filter(r => r.filePath === CHAT_COMMENT_FILE);
  const fileRefs = references.filter(r => r.filePath !== CHAT_COMMENT_FILE);
  const parts: string[] = [];

  // File comments: keep existing format
  if (fileRefs.length > 0) {
    parts.push(`${i18n.t('comments.codeRef')}`, '');
    fileRefs.forEach((ref, index) => {
      parts.push(`[${index + 1}] ${ref.filePath}:${ref.startLine}-${ref.endLine}`);
      parts.push('```');
      parts.push(ref.codeContent);
      parts.push('```');
      if (ref.note) {
        parts.push(i18n.t('comments.note', { content: ref.note }));
      }
      parts.push('');
    });
  }

  // Chat comments: quote + comment
  for (const ref of chatRefs) {
    const quoted = ref.codeContent.split('\n').map(l => `> ${l}`).join('\n');
    parts.push(quoted);
    if (ref.note) {
      parts.push(ref.note);
    }
    parts.push('');
  }

  parts.push(i18n.t('comments.question', { question }));

  return parts.join('\n');
}
