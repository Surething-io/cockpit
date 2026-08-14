// @cockpit/feature-agent (client) — Agent / Chat panel client-side entry

// Components
export { Chat } from './Chat';
export { ChatPanel } from './ChatPanel';
export { ChatInput } from './ChatInput';
export { ChatHeader } from './ChatHeader';
export { TokenUsageBar } from './TokenUsageBar';
export { MessageList, type MessageListHandle } from './MessageList';
export { MessageBubble } from './MessageBubble';
export { OllamaModelPicker } from './OllamaModelPicker';
export { EngineConfigPicker } from './EngineConfigPicker';
export { ProjectSessionsModal } from './ProjectSessionsModal';
export { RecentSessionsModal } from './RecentSessionsModal';
export { EngineBadge } from './EngineBadge';
export { EngineIcon, ENGINE_LABELS, ENGINE_IDS, type EngineAccentId } from './engineAccents';
export { TodoViewerModal } from './TodoViewerModal';
export { UserMessagesModal } from './UserMessagesModal';
export { AskQuestionViewerModal } from './AskQuestionViewerModal';
export { ToolCallModal } from './ToolCallModal';
export { DiffViewerModal, FileDiffViewer } from './DiffViewerModal';

// Mobile (/m) — recent-sessions list + single chat, no desktop 3-panel layout
export { MobileApp } from './mobile/MobileApp';

// Workspace sidebar contributions (chat-domain panels mounted by app's Workspace)
export { PinnedSessionsPanel } from './PinnedSessionsPanel';
export { ScheduledTasksPanel } from './ScheduledTasksPanel';
export { GlobalSessionMonitor, type GlobalSession } from './GlobalSessionMonitor';
export { SessionNumberBadge } from './SessionNumberBadge';
export { SessionCompleteToastContainer, showSessionCompleteToast } from './SessionCompleteToast';

// Chat ancillary UI
export { ScheduleTaskPopover } from './ScheduleTaskPopover';
export { QuickPromptsPopover } from './QuickPromptsPopover';
export { TokenStatsModal } from './TokenStatsModal';
export { SlashCommandMenu } from './SlashCommandMenu';
export { getSlashCommands, slashCommands, getMarkdown, type SlashCommand } from './slashCommands';
export { buildResumeCommand } from './resumeCommand';

// Context
export { ChatProvider, useChatContext, useChatContextOptional } from './ChatContext';

// Hooks
export { usePushSubscription, type PushPermission } from './usePushSubscription';
export { useChatHistory } from './useChatHistory';
export { useChatStream } from './useChatStream';
export { useChatSearch } from './useChatSearch';
export { usePinnedSessions } from './usePinnedSessions';
export { useScheduledTasks } from './useScheduledTasks';

// Wire contracts — shared with the server handlers, so any other package
// calling these endpoints is held to the same field names.
export type {
  PatchAction,
  TaskScopedAction,
  GlobalAction,
  ScheduledTaskPatchRequest,
  TaskScopedPatchRequest,
  MarkReadBySessionIdRequest,
  MarkAllReadRequest,
  ReorderRequest,
} from '../contract/scheduledTasks';

// Types
export type {
  MessageRole,
  ToolCallInfo,
  ImageMediaType,
  ImageInfo,
  MessageImage,
  ChatMessage,
  ChatSession,
  TokenUsage,
  ApiRetryInfo,
  RateLimitInfo,
  ChatEngine,
  EngineModelId,
  DeepseekModel,
  ClaudeModelId,
  ClaudeEffort,
  ClaudeContextWindow,
  CodexModelId,
  CodexReasoningEffort,
} from './types';
