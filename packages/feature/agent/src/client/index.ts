// @cockpit/feature-agent (client) — Agent / Chat panel client-side entry

// Components
export { Chat } from './Chat';
export { ChatPanel } from './ChatPanel';
export { ChatInput } from './ChatInput';
export { ChatHeader } from './ChatHeader';
export { TokenUsageBar } from './TokenUsageBar';
export { ComposerSlotProvider, useComposerSlot } from './ComposerSlot';
export { MessageList, type MessageListHandle } from './MessageList';
export { MessageBubble } from './MessageBubble';
export { OllamaModelPicker } from './OllamaModelPicker';
export { EngineConfigPicker } from './EngineConfigPicker';
export { ProjectSessionsModal } from './ProjectSessionsModal';
export { RecentSessionsModal } from './RecentSessionsModal';
export { EngineBadge } from './EngineBadge';
export { BotBadge } from './BotBadge';
// Session DTOs (src/shared/sessionDto.ts) — re-exported here so feature-workspace
// reads the same declaration the server builds against.
export type {
  SessionStatus,
  SessionEngine,
  SessionListItem,
  GlobalSessionRecord,
  GlobalSessionInfo,
} from '../shared/sessionDto';
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
export { SessionNumberBadge, badgeStatus } from './SessionNumberBadge';
// Session-board parts reused by the Bots board (feature-workspace): its
// "sessions" tab lists the runs a Bot dispatched, with the same rows + preview.
export { SessionTranscriptPreview } from './SessionTranscriptPreview';
export { formatRelativeTime, statusLabelOf } from './SessionRowParts';
export { sortSessionsForDisplay } from './sessionOrder';
export { SessionCompleteToastContainer, showSessionCompleteToast } from './SessionCompleteToast';

// Chat ancillary UI
export { ScheduleTaskPopover } from './ScheduleTaskPopover';
export { QuickInstructionsPopover } from './QuickInstructionsPopover';
export { TokenStatsModal } from './TokenStatsModal';
export { SlashCommandMenu } from './SlashCommandMenu';
export { getSlashCommands, slashCommands, getMarkdown, type SlashCommand } from './slashCommands';
export { buildResumeCommand } from './resumeCommand';

// Engine queries the app integrator needs (workspace seeds a new ollama tab with this)
export { loadOllamaDefaultModel, loadRecentSessions, type RecentSessionInfo } from './effect/agentClient';

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
  BackgroundTaskInfo,
  RateLimitInfo,
  ChatEngine,
  EngineModelId,
  DeepseekModel,
  ClaudeModelId,
  ClaudeEffort,
  CodexModelId,
  CodexReasoningEffort,
} from './types';
