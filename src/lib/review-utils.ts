// ============================================
// Review ID Generators
// ============================================

import { createHash } from 'crypto';

function randomStr(len: number): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** Generate a stable review ID from a file path; the same file always returns the same ID */
export function generateReviewId(sourceFile: string): string {
  const hash = createHash('sha256').update(sourceFile).digest('hex').slice(0, 12);
  return `rv-${hash}`;
}

export function generateCommentId(): string {
  return `rc-${Date.now()}-${randomStr(7)}`;
}

export function generateReplyId(): string {
  return `rr-${Date.now()}-${randomStr(7)}`;
}

// ============================================
// Random Display Name
// ============================================

import i18n from '@/lib/i18n';

export function randomDisplayName(): string {
  const adjectives = i18n.t('reviewUtils.adjectives', { returnObjects: true }) as string[];
  const nouns = i18n.t('reviewUtils.nouns', { returnObjects: true }) as string[];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}${noun}`;
}

// ============================================
// Review Data Types
// ============================================

export interface CommentAnchor {
  startOffset: number;
  endOffset: number;
  selectedText: string;
}

export interface ReviewReply {
  id: string;
  author: string;
  authorId: string;
  content: string;
  createdAt: number;
  edited?: boolean;
}

export interface ReviewComment {
  id: string;
  author: string;
  authorId: string;
  content: string;
  anchor: CommentAnchor;
  createdAt: number;
  replies: ReviewReply[];
  edited?: boolean;
  closed?: boolean;
}

export interface ReviewData {
  id: string;
  title: string;
  content: string;
  sourceFile?: string;
  active: boolean;
  createdAt: number;
  updatedAt?: number;
  comments: ReviewComment[];
}
