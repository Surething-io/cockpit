// @cockpit/feature-explorer (client) — File explorer panel.
// Owns code-rendering UI (CodeViewer, DiffView, InteractiveMarkdownPreview,
// PreviewModal): rendering source code is explorer's domain responsibility,
// reused by feature-agent (chat) / feature-review / feature-skills.

// ============================================
// Top-level UI
// ============================================
export * from './FileBrowserModal';
export * from './FileTree';
export * from './GitFileTree';
export * from './CommitDetailPanel';
export * from './FileEditorModal';
export * from './GitWorktreeModal';
export * from './ReferencesPanel';
export * from './SearchResultsPanel';
export * from './QuickFileOpen';
export * from './HoverTooltip';
export * from './CodeLine';
export * from './CodeComment';
export * from './DiffMinimap';
export * from './ViewCommentCard';
export * from './DiffView';
export * from './CodeViewer';
export * from './InteractiveMarkdownPreview';
export * from './PreviewModal';
export * from './useLSP';

// ============================================
// Pure utilities (diff / format / icons)
// ============================================
export * from './diffAlgorithm';
export * from './compactDiff';
export * from './toolCallUtils';

// ============================================
// fileBrowser/ helpers (re-exported for callers in apps/cockpit/src that
// need the bare types/utils. Components used directly by FileBrowserModal
// don't need to be public — they're internal to this package.)
// FileNode (from FileTree), GitFileStatus (from GitFileTree), and
// isImageFile (from toolCallUtils) take priority over the same-named
// symbols in fileBrowser/{types,utils}, so we re-export selectively.
// ============================================
export type {
  FileContent,
  BlameLine,
  GitStatusResponse,
  GitDiffResponse,
  Branch,
  Commit,
  FileChange,
  FileDiff,
  TabType,
  SearchMatch,
  SearchResult,
  SearchResponse,
  FileBrowserModalProps,
} from './fileBrowser/types';
export {
  findNodeByPath,
  getTargetDirPath,
  buildTreeFromPaths,
  collectAllDirPaths,
  computeMatchedPaths,
  computeMatchedPathsFromIndex,
  formatRelativeTime,
  formatDateTime,
  NOOP,
  COMMITS_PER_PAGE,
} from './fileBrowser/utils';
export * from './fileBrowser/symbolIcon';
export * from './fileBrowser/blockDiffProjection';
export * from './fileBrowser/useBlockSelection';
export * from './fileBrowser/BranchSelector';
export * from './fileBrowser/BlockCommentBubbles';
export * from './fileBrowser/BlockDiffMinimap';
export * from './fileBrowser/BlockDiffViewer';
export * from './fileBrowser/FileImagePreview';
export * from './fileBrowser/FileTOCSection';
export * from './fileBrowser/FunctionHistoryDrawer';
export * from './fileBrowser/StatusDiffPane';

// ============================================
// Hooks
// ============================================
export * from './hooks/useFileTree';
export * from './hooks/useGitStatus';
export * from './hooks/useGitHistory';
export * from './hooks/useFileBlocks';
export * from './hooks/useLineHighlight';
export * from './hooks/useContentSearch';
