// 消息类型定义

export type MessageRole = 'user' | 'assistant';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
}

// 支持的图片 MIME 类型
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

// 图片信息（前端状态管理用）
export interface ImageInfo {
  id: string;           // 唯一标识
  data: string;         // base64 数据（不含前缀）
  preview: string;      // 完整的 data URL（用于预览）
  media_type: ImageMediaType;  // 图片 MIME 类型
}

// 消息中的图片（用于历史记录和 API）
export interface MessageImage {
  type: 'base64';
  media_type: ImageMediaType;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  images?: MessageImage[];  // 消息中的图片
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  timestamp?: string;  // 消息创建时间（ISO 格式）
}

export interface ChatSession {
  id: string | null;
  messages: ChatMessage[];
}

// Token 使用信息
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}
