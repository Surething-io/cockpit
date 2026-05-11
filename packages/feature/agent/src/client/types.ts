// Agent / Chat feature types
//
// Single source of truth for chat-specific types. Image types
// (ImageMediaType, ImageInfo, MessageImage) live in @cockpit/shared-utils
// since they're used by shared-ui's ImagePreview as well — re-exported
// here for callers that already import them from this package.

export type MessageRole = 'user' | 'assistant';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
}

// Re-export image types from shared-utils (single source of truth).
import type { ImageMediaType, ImageInfo, MessageImage } from '@cockpit/shared-utils';
export type { ImageMediaType, ImageInfo, MessageImage };

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

// Retry info (from SDK system/api_retry event)
export interface ApiRetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorStatus?: number;
  error?: string;
}

// Rate limit info (from SDK rate_limit_event)
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
}

// Chat engine / model selection types — used by useChatStream, ChatPanel,
// MessageList, etc. Migrated here from useTabState so the types live with
// the agent feature instead of a generic tab-state hook.
export type ChatEngine = 'claude' | 'claude2' | 'codex' | 'kimi' | 'ollama' | 'deepseek';
export type DeepseekModel = 'deepseek-v4-flash' | 'deepseek-v4-pro';
