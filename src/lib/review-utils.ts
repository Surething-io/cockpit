// ============================================
// Review ID Generators
// ============================================

import { createHash } from 'crypto';

function randomStr(len: number): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

/** 根据文件路径生成固定的 review ID，同一文件始终返回同一 ID */
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

const adjectives = [
  '快乐', '勇敢', '安静', '明亮', '温柔',
  '灵巧', '自由', '清澈', '飞翔', '悠闲',
  '活泼', '聪慧', '淡定', '机敏', '从容',
  '坚定', '爽朗', '和煦', '奔放', '沉稳',
];

const animals = [
  '熊猫', '海豚', '白鹤', '雪豹', '云雀',
  '松鼠', '飞鱼', '梅花鹿', '青鸟', '银狐',
  '猫头鹰', '蜻蜓', '萤火虫', '海龟', '蝴蝶',
  '金丝猴', '丹顶鹤', '羚羊', '燕子', '企鹅',
];

export function randomDisplayName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  return `${adj}${animal}`;
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
