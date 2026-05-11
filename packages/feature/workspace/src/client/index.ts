// @cockpit/feature-workspace — application integrator.
// By convention, this is the one feature package that consumes ALL other
// feature packages (Agent, Explorer, Console, Comments, Review, Skills) to
// build the multi-feature workspace UI. Other features should use other
// features only when there's a clear "supporting subdomain" relationship
// (e.g. agent uses explorer for code rendering).
//
// Layering rule (2-layer): feature-* → shared-*. Features may import other
// features (acyclic). Shared packages cannot import features. See
// CLAUDE.md / MODULES.md.

// ============================================
// Application shell
// ============================================
export { Workspace } from './Workspace';
export { ProjectSidebar, type ProjectInfo } from './ProjectSidebar';
export { ProjectItem } from './ProjectItem';
export { EmptyState } from './EmptyState';

// ============================================
// Per-project tab orchestrator (mounts feature-agent / feature-explorer /
// feature-console panels in a 3-panel swipe layout)
// ============================================
export { TabManager } from './TabManager';
export { TabManagerTopBar } from './TabManagerTopBar';
export { TabBar } from './TabBar';
export { useTabState } from './useTabState';

// ============================================
// Application bootstrap providers
// ============================================
export { Providers } from './Providers';
export { I18nProvider } from './I18nProvider';

// ============================================
// Application-level modals
// ============================================
export { SettingsModal } from './SettingsModal';
export { NoteModal } from './NoteModal';
export { NoteToolbar } from './NoteToolbar';
export { SessionBrowser } from './SessionBrowser';
