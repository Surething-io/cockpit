// Agent / Chat feature types
//
// Single source of truth for chat-specific types. Image types
// (ImageMediaType, ImageInfo, MessageImage) live in @cockpit/shared-utils
// since they're used by shared-ui's ImagePreview as well — re-exported
// here for callers that already import them from this package.

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isLoading?: boolean;
  // Skill body loaded by this call (e.g. the Skill tool). Folded into the tool
  // call's expanded view instead of appearing as a separate user bubble.
  skillContent?: string;
}

// Ordered text/tool skeleton of an assistant turn — defined in shared/ because
// the history parsers (server) build it too. Re-exported here so client callers
// keep a single import site for chat types.
import type { MessagePart } from '../shared/assistantText';
export type { MessagePart };

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
  // Set on role:'system' rows — a harness event rendered as a muted one-line bar
  // (not a conversation bubble). `task-notification` shows the <summary> line;
  // `meta` covers skill image annotations / compact-summary notices.
  // `detail` is the full raw text (e.g. the complete <task-notification> block) —
  // shown in a modal when the one-line bar is clicked. `content` stays the summary.
  systemEvent?: { kind: 'task-notification' | 'meta'; status?: string; detail?: string };
  // #bg ephemeral ownership: which run created this LIVE `auto-*` bubble. The snapshot
  // replay is scoped to the current run, so the reconnect filter must only drop the current
  // run's own live bubbles — matching on this stops it from wiping a PRIOR run's continuation
  // bubbles (which the new run's snapshot will never rebuild). Absent on persisted/reloaded
  // messages (they carry real UUIDs and must never be filtered).
  runKey?: string;
  // Ordered text/tool skeleton of this turn (assistant rows only). Built by the
  // live reducer and the history parsers in lockstep with `content`; see
  // shared/assistantText.ts. `content` is derivable from it (deriveContent).
  parts?: MessagePart[];
  // Transient (never persisted): true when a tool_use has occurred since the
  // last text segment was appended to this assistant bubble. It is the ONE
  // segment-boundary decision, fed to both `content` (as joinAssistantText's
  // breakBefore) and `parts` (as appendTextPart's) so the two cannot disagree.
  // Maintained by the live reducer (applyStreamEvent) and the history parsers;
  // see shared/assistantText.ts.
  pendingTextBreak?: boolean;
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
export type ChatEngine = 'claude' | 'codex' | 'kimi' | 'ollama' | 'deepseek' | 'glm';
/**
 * A model id for the API-key engines (deepseek, kimi, glm). Deliberately a plain string, not a
 * union: the pickers fill their lists live from /api/<engine>/models, so any id the account
 * has can appear — including ones shipped after this release. The only server-side whitelist
 * is deepseek's SDK mode (engines/deepseek.ts ALLOWED_MODELS), whose Anthropic-compatible
 * endpoint has no listing API to validate against.
 */
export type EngineModelId = string;
/** @deprecated Use EngineModelId — kept so existing deepseek-named props still read naturally. */
export type DeepseekModel = EngineModelId;
/**
 * Execution mode — which loop actually drives the turn.
 * - `sdk`: `@anthropic-ai/claude-agent-sdk`'s `query()` (headless). claude (Agent SDK
 *   billing bucket) and deepseek/kimi/glm (their Anthropic-compatible endpoints). The default
 *   everywhere.
 * - `builtin`: Cockpit's own agent loop (server engines/builtinAgent) against the provider's
 *   OpenAI-compatible endpoint. deepseek, kimi and glm. NOT switchable mid-session: it keeps its
 *   own transcript store, so the UI locks the choice once a session has messages.
 */
export type ChatMode = 'sdk' | 'builtin';
