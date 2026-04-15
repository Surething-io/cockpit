// Message type definitions

export type MessageRole = 'user' | 'assistant';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
}

// Supported image MIME types
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

// Image info (for frontend state management)
export interface ImageInfo {
  id: string;           // Unique identifier
  data: string;         // base64 data (without prefix)
  preview: string;      // Full data URL (for preview)
  media_type: ImageMediaType;  // Image MIME type
}

// Images in messages (for history and API)
export interface MessageImage {
  type: 'base64';
  media_type: ImageMediaType;
  data: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  images?: MessageImage[];  // Images in the message
  toolCalls?: ToolCallInfo[];
  isStreaming?: boolean;
  timestamp?: string;  // Message creation time (ISO format)
}

export interface ChatSession {
  id: string | null;
  messages: ChatMessage[];
}

// Token usage info
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number;
}

// Rate limit info (from SDK rate_limit_event)
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}
