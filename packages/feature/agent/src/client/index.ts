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
export { DeepseekConfigPicker } from './DeepseekConfigPicker';
export { ProjectSessionsModal } from './ProjectSessionsModal';
export { TodoViewerModal } from './TodoViewerModal';
export { UserMessagesModal } from './UserMessagesModal';
export { AskQuestionViewerModal } from './AskQuestionViewerModal';
export { ToolCallModal } from './ToolCallModal';
export { DiffViewerModal } from './DiffViewerModal';

// Workspace sidebar contributions (chat-domain panels mounted by app's Workspace)
export { PinnedSessionsPanel } from './PinnedSessionsPanel';
export { ScheduledTasksPanel } from './ScheduledTasksPanel';
export { GlobalSessionMonitor, type GlobalSession } from './GlobalSessionMonitor';
export { SessionCompleteToastContainer, showSessionCompleteToast } from './SessionCompleteToast';

// Chat ancillary UI
export { ScheduleTaskPopover } from './ScheduleTaskPopover';
export { TokenStatsModal } from './TokenStatsModal';
export { SlashCommandMenu } from './SlashCommandMenu';
export { getSlashCommands, slashCommands, getMarkdown, type SlashCommand } from './slashCommands';

// Context
export { ChatProvider, useChatContext, useChatContextOptional } from './ChatContext';

// Hooks
export { useChatHistory } from './useChatHistory';
export { useChatStream } from './useChatStream';
export { useChatSearch } from './useChatSearch';
export { usePinnedSessions } from './usePinnedSessions';
export { useScheduledTasks } from './useScheduledTasks';

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
  DeepseekModel,
  ChatMode,
} from './types';
