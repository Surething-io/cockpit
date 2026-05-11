// @cockpit/shared-ui — cross-feature reusable presentation components / utilities

// Portal
export { Portal, PanelPortalProvider, usePanelPortalTarget } from './Portal';

// Toast / Confirm
export { ToastProvider, useToast, toast, confirm } from './Toast';

// i18n: shared-ui no longer exposes a translator IoC slot. Localized
// strings come from @cockpit/shared-i18n directly — see Toast.tsx /
// useJsonSearch.ts for usage.

// Theme
export * from './ThemeProvider';

// Markdown
export * from './MarkdownRenderer';

// Floating UI primitives
export * from './FloatingToolbar';

// File context menu primitives
export * from './FileContextMenu';

// Inline code input cards (comment / send-to-AI)
export * from './CodeInputCards';

// Image preview
export * from './ImagePreview';

// AIBridge — IoC slot for "send selected text to AI" used by non-chat features
export { AIBridgeProvider, useAIBridge, type AIBridge } from './AIBridge';

// Code highlighting (Shiki singleton + helpers)
export * from './codeHighlighter';

// Rehype plugin: inject source line numbers as data-source-* attrs
export { rehypeSourceLines } from './rehypeSourceLines';

// JSON content search (CSS Custom Highlight API + DOM Range mapping)
export { useJsonSearch, JsonSearchBar } from './useJsonSearch';

// Tooltip primitives
export { Tooltip } from './Tooltip';
export { TooltipProvider } from './TooltipProvider';

// File icon (extension-based mapping)
export { FileIcon, FolderIcon } from './FileIcon';

// Markdown table-of-contents sidebar
export { TocSidebar, extractToc, type TocItem } from './TocSidebar';

// Generic React hooks
export { useWebSocket } from './useWebSocket';
export { useViMode } from './useViMode';
export { usePageVisible } from './usePageVisible';

// Swipeable layout primitives (translateX-based 3-panel layout)
export {
  SwipeableViewContainer,
  SwipeableContent,
  ViewSwitcherBar,
  useSwipeContext,
  type ViewType,
} from './SwipeableViewContainer';
export { SwipeablePages } from './SwipeablePages';

// Generic in-memory file navigation history (back/forward stack for Cmd+Click jumps)
export { useNavigationHistory, type NavEntry } from './useNavigationHistory';
