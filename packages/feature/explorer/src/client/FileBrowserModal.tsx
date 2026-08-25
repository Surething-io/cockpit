'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Portal } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  saveFile,
  loadFileClipboard,
  saveFileClipboard,
  pasteFiles,
  deleteFiles,
  loadFilesInit,
  loadFileIndex,
  loadRecentFiles,
  fetchFileText,
} from './effect/filesClient';
import {
  fetchGitStatus,
  fetchCommits,
} from './effect/gitClient';
import { CommitDetailPanel } from './CommitDetailPanel';
import { DiffView, DiffUnifiedView } from '@cockpit/feature-explorer';
import { DiffDensityToggle } from './DiffDensityToggle';
import { DiffViewModeToggle } from './DiffViewModeToggle';
import { toast, confirm } from '@cockpit/shared-ui';
import { FileTree, type GitStatusMap, type GitStatusCode } from './FileTree';
import { GitFileTree, buildGitFileTree, collectFilesUnderNode } from './GitFileTree';
import { MenuContainerProvider } from '@cockpit/shared-ui';
import { CodeViewer } from '@cockpit/feature-explorer';
import { isMarkdownFile, isHtmlFile, isJsonFile, isCsvFile, isSkillFile, formatAsHumanReadable, THEME_JSON_COLORS, JsonCollapseContext } from './toolCallUtils';
import { CsvTableView } from './CsvTableView';
import { ExternalLink, BookmarkPlus, SquareTerminal } from 'lucide-react';
import { toExternalBrowserAppUrl, toLocalAppUrl } from '@cockpit/shared-utils';
import { useAddHtmlApp } from './htmlApps/useAddHtmlApp';
import { useAddSkill } from './skills/useAddSkill';
import { buildTreeFromPaths, collectAllDirPaths, mergeFileTree } from './fileBrowser/utils';
import { InteractiveMarkdownPreview } from '@cockpit/feature-explorer';
import { HtmlAppFrame } from './HtmlAppFrame';
import { ShareReviewToggle } from '@cockpit/feature-review';
import { type FileEditorHandle } from './FileEditorModal';
import { QuickFileOpen } from './QuickFileOpen';
import { useWebSocket } from '@cockpit/shared-ui';
import { usePageVisible } from '@cockpit/shared-ui';
import { useAIBridge } from '@cockpit/shared-ui';

import type { TabType, GitFileStatus, GitStatusResponse, FileBrowserModalProps, SearchResult, Commit } from './fileBrowser/types';
import type { FileNode } from './FileTree';
import type { RecentFileEntry } from '@/app/api/files/recent/route';
import { BlockViewer, type BlockViewerHeaderState } from './fileBrowser/BlockViewer';
import { BlockDiffViewer } from './fileBrowser/BlockDiffViewer';
import { StatusDiffPane } from './fileBrowser/StatusDiffPane';
import { getTargetDirPath, formatDateTime, isImageFile, NOOP, COMMITS_PER_PAGE } from './fileBrowser/utils';
import { GitImageDiffView } from './fileBrowser/GitImageDiffView';

import { BranchSelector } from './fileBrowser/BranchSelector';
import { FileImagePreview } from './fileBrowser/FileImagePreview';
import { FilePdfPreview } from './fileBrowser/FilePdfPreview';

import { useFileTree } from './hooks/useFileTree';
import { useContentSearch } from './hooks/useContentSearch';
import { useGitStatus } from './hooks/useGitStatus';
import { useGitHistory } from './hooks/useGitHistory';
import { useTreeFileDiff } from './hooks/useTreeFileDiff';
import { useLSPDefinition, useLSPHover, useLSPReferences, useLSPWarmup } from '@cockpit/feature-explorer';
import { useNavigationHistory } from '@cockpit/shared-ui';
import { useTranslation } from 'react-i18next';
import { useJsonSearch, JsonSearchBar } from '@cockpit/shared-ui';
import { getLanguageForFile } from '@cockpit/feature-explorer/server/lsp/types';
import { HoverTooltip } from './HoverTooltip';
import { ReferencesPanel } from './ReferencesPanel';
import { SearchResultsPanel } from './SearchResultsPanel';
import type { Location } from '@cockpit/feature-explorer/server/lsp/types';
import { useSwipeContext } from '@cockpit/shared-ui';

/**
 * Drag range for the left file-tree pane. The minimum is the width the pane
 * used to be hard-coded to (`w-80` = 320px), so the divider can only widen the
 * tree — dragging left just clamps back to the original layout.
 */
const TREE_WIDTH_MIN = 320;
const TREE_WIDTH_MAX = TREE_WIDTH_MIN * 1.5;

function FileBrowserModalImpl({ onClose, cwd, initialTab = 'tree', tabSwitchTrigger, initialSearchQuery, searchQueryTrigger, fileOpenRequest }: FileBrowserModalProps) {
  const { t } = useTranslation();
  const aiBridge = useAIBridge();
  // "Explain this" — tree context menu (file) and LSP hover card (symbol)
  // both just push a localized one-liner into the active chat. Paths stay
  // project-relative: that's what every producer here already holds, and
  // the agent resolves them against the same cwd.
  const handleExplainFile = useCallback((path: string) => {
    aiBridge?.sendMessage(t('explain.fileMessage', { path }));
  }, [aiBridge, t]);
  // Git surfaces ask about the *change*, not the file, and each names its own
  // range so the agent picks the right git command instead of reading the
  // working-tree copy. Untracked files go through the working-tree wording
  // too: `git diff` comes back empty and the agent falls back to reading the
  // file, which beats threading per-row status down to the context menu.
  const handleExplainStaged = useCallback((path: string) => {
    aiBridge?.sendMessage(t('explain.stagedFileMessage', { path }));
  }, [aiBridge, t]);
  const handleExplainUnstaged = useCallback((path: string) => {
    aiBridge?.sendMessage(t('explain.unstagedFileMessage', { path }));
  }, [aiBridge, t]);
  const addHtmlApp = useAddHtmlApp();
  const addSkill = useAddSkill();
  const { activeView, onViewChange } = useSwipeContext();
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  // Editor mode in the right panel of tree / search / recent tabs:
  //   'code' = the usual CodeViewer for the selected file
  //   'map'  = full-panel architecture diagram, with the selected file's
  //            module highlighted. Clicking a different file in the tree
  //            updates the highlight rather than switching back to code.
  const [editorMode, setEditorMode] = useState<'code' | 'map'>('code');
  // diffViewerMode (file | block) is owned by `<StatusDiffPane>` —
  // it's only meaningful in the status tab's diff pane and the JSX
  // that reads it lives there.
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; isDirectory: boolean; name: string } | null>(null);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  // CodeViewer currently visible line number (1-based), used to sync editor ↔ viewer position
  const visibleLineRef = useRef<number>(1);
  // Vi cursor position ref (0-based), continuously updated by CodeViewer
  const viStateRef = useRef<{ cursorLine: number; cursorCol: number } | null>(null);
  // Line number to jump to when returning from editor
  const [editorReturnLine, setEditorReturnLine] = useState<number | null>(null);
  // Editor ref and state (used to render save/close buttons in the top toolbar)
  const editorHandleRef = useRef<FileEditorHandle>(null);
  const [editorState, setEditorState] = useState({ isDirty: false, isSaving: false });
  const [showSearchPanel, setShowSearchPanel] = useState(false);
  const [jsonPreview, setJsonPreview] = useState<{ content: string; filePath: string } | null>(null);
  // 精简/全文 for the branch-compare diff — pane-local, defaults to compact.
  const [compareDensity, setCompareDensity] = useState<'compact' | 'full'>('compact');
  // split/unified for compare-mode diff — pane-local, defaults to unified, not
  // persisted (same policy as `compareDensity` and the other diff panes).
  const [compareViewMode, setCompareViewMode] = useState<'split' | 'unified'>('unified');
  // 精简/全文 + split/unified for the directory-tree viewer's diff mode —
  // pane-local and not persisted, same policy as the other diff panes.
  //
  // Density defaults to 'full' here, unlike every other pane. Those panes
  // answer "what changed in this batch", where changed-lines-only is the
  // point. The tree answers "let me read this file" — every other file in
  // the tree opens as full text, so a diff that opens as fragments is the
  // odd one out. The toggle still flips it back to compact.
  const [treeDiffDensity, setTreeDiffDensity] = useState<'compact' | 'full'>('full');
  const [treeDiffViewMode, setTreeDiffViewMode] = useState<'split' | 'unified'>('unified');
  // Width of the left file-tree pane, adjustable by dragging the divider.
  // Pane-local and deliberately NOT persisted: the range is only 320-480px, so
  // this is a transient "widen it to read a long path" tweak, not a stored
  // preference (same non-persistence policy as the diff panes above).
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH_MIN);
  const treeResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Mouse only: on touch, a horizontal drag belongs to the three-panel swipe
  // gesture, so we leave those pointers alone entirely.
  const handleTreeResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault(); // suppresses the text selection the drag would otherwise start
    treeResizeRef.current = { startX: e.clientX, startWidth: treeWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [treeWidth]);

  const handleTreeResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = treeResizeRef.current;
    if (!drag) return;
    const next = drag.startWidth + (e.clientX - drag.startX);
    setTreeWidth(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, next)));
  }, []);

  const handleTreeResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!treeResizeRef.current) return;
    treeResizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const jsonPreRef = useRef<HTMLPreElement>(null);
  const jsonSearch = useJsonSearch(jsonPreRef);
  const jsonPreviewPreRef = useRef<HTMLPreElement>(null);
  const jsonPreviewSearch = useJsonSearch(jsonPreviewPreRef);

  // ========== Hooks ==========
  const lspDefinition = useLSPDefinition(cwd);
  const lspHover = useLSPHover(cwd);
  const lspReferences = useLSPReferences(cwd);
  const navHistory = useNavigationHistory();

  const pageVisible = usePageVisible();
  const fileTree = useFileTree({ cwd });
  useLSPWarmup(cwd, fileTree.selectedPath);

  // Memoized JSON in-place preview text. formatAsHumanReadable is O(document
  // size); FileBrowserModal re-renders on unrelated events (e.g. a chat-tab
  // session switch re-renders the whole panel), so compute it only when the
  // JSON content actually changes rather than on every render.
  const jsonPreviewFormatted = useMemo(() => {
    const fc = fileTree.fileContent;
    const path = fileTree.selectedPath;
    if (!fc || fc.type !== 'text' || typeof fc.content !== 'string' || !path || !isJsonFile(path)) return null;
    return formatAsHumanReadable(fc.content, THEME_JSON_COLORS);
  }, [fileTree.fileContent, fileTree.selectedPath]);

  // Collapse-all / expand-all command for the JSON preview. Broadcast through
  // JsonCollapseContext rather than passed into formatAsHumanReadable, so
  // pressing the button does not invalidate the memo above and re-format the
  // whole document. Each press bumps `version`, which supersedes any per-entry
  // clicks made since the previous press.
  const [jsonCollapse, setJsonCollapse] = useState<{ version: number; collapsed: boolean }>({ version: 0, collapsed: false });
  // Every file opens expanded — a fresh document should not inherit the fold
  // state of the previous one.
  useEffect(() => {
    setJsonCollapse(c => (c.collapsed ? { version: c.version + 1, collapsed: false } : c));
  }, [fileTree.selectedPath]);

  const contentSearch = useContentSearch({ cwd, onSearchComplete: () => setShowSearchPanel(true) });
  const gitStatus = useGitStatus({ cwd, addToRecentFiles: fileTree.addToRecentFiles });

  // Set of project-relative paths with uncommitted changes — drives the
  // architecture map's AI-session activity overlay (yellow indicators on
  // modules / files / file detail headers).
  const changedFilePathSet = useMemo(() => {
    const out = new Set<string>();
    if (gitStatus.status) {
      for (const f of gitStatus.status.staged) out.add(f.path);
      for (const f of gitStatus.status.unstaged) out.add(f.path);
    }
    return out;
  }, [gitStatus.status]);

  /**
   * Per-path git status lookup — feeds the BlockDiffViewer header
   * badge so it can reflect whatever file the user is currently
   * viewing, including pin-jumps to other files. We pick "unstaged"
   * over "staged" when a file appears in BOTH (rare but possible:
   * staged a hunk, then made more changes), because the unstaged
   * portion is the more actionable signal during review.
   */
  const fileGitStatusMap = useMemo(() => {
    const out = new Map<string, 'staged' | 'unstaged'>();
    if (gitStatus.status) {
      for (const f of gitStatus.status.staged) out.set(f.path, 'staged');
      for (const f of gitStatus.status.unstaged) out.set(f.path, 'unstaged');
    }
    return out;
  }, [gitStatus.status]);
  const gitHistory = useGitHistory({ cwd, addToRecentFiles: fileTree.addToRecentFiles });

  // Compare mode has no commit pair to name — the head side is hardcoded to
  // HEAD server-side (branch-diff.ts). Spell the range two-dot: the route runs
  // `git diff <base> HEAD`, so `<base>..HEAD` matches it and `<base>...HEAD`
  // (merge-base, a real PR diff) would hand the agent a different diff.
  const handleExplainCompare = useCallback((path: string) => {
    aiBridge?.sendMessage(t('explain.compareFileMessage', { base: gitHistory.compareBaseBranch, path }));
  }, [aiBridge, t, gitHistory.compareBaseBranch]);

  // ========== Vi Mode Callbacks ==========
  /** True when the next entry into edit mode was caused by a vi normal-mode
   *  mutation (yyp / dd / x / …) — the editor should open already-dirty since
   *  the in-memory buffer differs from disk. */
  const viMutationPendingDirtyRef = useRef(false);

  const handleViContentMutate = useCallback((newContent: string) => {
    fileTree.setFileContent(prev =>
      prev?.type === 'text' ? { ...prev, content: newContent } : prev
    );
    // Vi commands that change content auto-promote the viewer into edit mode so
    // the change is treated as an unsaved edit (Save button, switch-prompt, …).
    if (!fileTree.showEditor) {
      viMutationPendingDirtyRef.current = true;
      fileTree.setShowEditor(true);
    }
  }, [fileTree]);

  // After auto-entering edit mode from a vi mutation, flip the editor's dirty
  // flag (CodeViewer's enter-edit effect would otherwise reset it to false).
  // Parent useEffects run after child useEffects, so by the time this fires the
  // editor handle has been set up and its own init effect has already run.
  useEffect(() => {
    if (fileTree.showEditor && viMutationPendingDirtyRef.current) {
      editorHandleRef.current?.markDirty();
      viMutationPendingDirtyRef.current = false;
    }
  }, [fileTree.showEditor]);

  const handleViEnterInsert = useCallback((_cursorLine: number) => {
    // Don't overwrite visibleLineRef — keep the current viewport scroll position.
    // visibleLineRef already tracks the first visible line in the virtual scroller,
    // which the editor init effect uses for both scroll and cursor placement.
    fileTree.setShowEditor(true);
  }, [fileTree]);

  const handleViSave = useCallback(async () => {
    if (!fileTree.fileContent || fileTree.fileContent.type !== 'text' || !fileTree.fileContent.content) return;
    const exit = await BrowserRuntime.runPromiseExit(
      saveFile({
        cwd,
        path: fileTree.selectedPath!,
        content: fileTree.fileContent.content,
      })
    );
    try {
      if (exit._tag === 'Failure' || !exit.value.ok) {
        throw new Error('Failed to save file');
      }
      const mtime = (exit.value.data as { mtime?: number } | null)?.mtime;
      if (mtime) {
        fileTree.setFileContent(prev =>
          prev?.type === 'text' ? { ...prev, mtime } : prev
        );
      }
      toast(t('toast.savedSuccess'), 'success');
    } catch {
      toast(t('toast.saveFailed'), 'error');
    }
  }, [cwd, fileTree]);

  // ========== Save current position to recent files before switching ==========
  const saveCurrentFilePosition = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const scrollLine = visibleLineRef.current;
    const cursor = viStateRef.current;
    if (scrollLine > 0) {
      fileTree.updateRecentFilePosition(
        fileTree.selectedPath,
        scrollLine,
        cursor ? cursor.cursorLine + 1 : scrollLine,  // 0-based → 1-based (convert)
        cursor ? cursor.cursorCol + 1 : 1,
      );
    }
  }, [fileTree]);

  /** Wrap handleSelectFile: when switching to a different file while in edit
   *  mode, prompt to save if the editor is dirty, otherwise exit edit mode and
   *  continue with the switch. Always saves the current file's scroll position. */
  const handleSelectFileWithSave = useCallback(async (path: string, lineNumber?: number) => {
    const isDifferent = path !== fileTree.selectedPath;

    if (isDifferent && fileTree.showEditor) {
      if (editorState.isDirty) {
        const ok = await confirm(t('fileBrowser.saveBeforeSwitch'), {
          confirmText: t('fileBrowser.saveAndSwitch'),
          cancelText: t('common.cancel'),
        });
        if (!ok) return; // stay on current file, keep edit mode
        await editorHandleRef.current?.save();
        // Save may have failed (conflict / network) — CodeViewer keeps isDirty=true; bail out.
        if (editorHandleRef.current?.isDirty) return;
      }
      // Clean (or just saved) → exit edit mode before switching.
      fileTree.setShowEditor(false);
    }

    if (isDifferent) {
      saveCurrentFilePosition();
    }
    fileTree.handleSelectFile(path, lineNumber);
  }, [fileTree, saveCurrentFilePosition, editorState.isDirty, t]);

  // ========== Search results: build an independent tree from search result paths (no lazy-loaded dir tree) ==========
  const searchData = useMemo(() => {
    const results = contentSearch.contentSearchResults;
    if (results.length === 0) return { files: [] as import('./fileBrowser/types').FileNode[], expandDirs: new Set<string>(), matchMap: new Map<string, SearchResult>() };

    const matchMap = new Map<string, SearchResult>();
    const filePaths: string[] = [];
    for (const r of results) {
      matchMap.set(r.path, r);
      filePaths.push(r.path);
    }

    // Build a full tree directly from search result file paths, similar to the recent files tab strategy
    const files = buildTreeFromPaths(filePaths);
    const expandDirs = new Set(collectAllDirPaths(files));

    return { files, expandDirs, matchMap };
  }, [contentSearch.contentSearchResults]);

  // Search tree expanded paths — fully expanded by default after search completes
  const [searchTreeExpanded, setSearchTreeExpanded] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSearchTreeExpanded(searchData.expandDirs);
  }, [searchData.expandDirs]);

  const handleSearchTreeToggle = useCallback((path: string) => {
    setSearchTreeExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderSearchActions = useCallback((node: { path: string; isDirectory: boolean }) => {
    if (node.isDirectory) return null;
    const result = searchData.matchMap.get(node.path);
    if (!result) return null;
    return <span className="text-xs text-muted-foreground">{result.matches.length}</span> as ReactNode;
  }, [searchData.matchMap]);

  const showSearchResults = showSearchPanel && contentSearch.contentSearchResults.length > 0;

  // Search results scope toggle: 'selected' shows only the tree-selected file's
  // matches, 'all' shows every result. Reset to 'selected' whenever a new search
  // completes.
  const [searchResultScope, setSearchResultScope] = useState<'selected' | 'all'>('selected');
  useEffect(() => {
    setSearchResultScope('selected');
  }, [contentSearch.contentSearchResults]);

  // ========== LSP handlers (depend on fileTree) ==========
  const isLSPSupported = fileTree.selectedPath ? getLanguageForFile(fileTree.selectedPath) !== null : false;
  /** Whether the visible hover card was opened from a diff surface. */
  const [lspHoverInDiff, setLspHoverInDiff] = useState(false);

  const handleLSPCmdClick = useCallback(async (line: number, column: number) => {
    if (!fileTree.selectedPath || !isLSPSupported) return;

    const definitions = await lspDefinition.goToDefinition(fileTree.selectedPath, line, column);
    if (definitions.length === 0) return;

    const def = definitions[0];
    // tsserver returns absolute paths; convert to relative (relative to cwd)
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = def.file.startsWith(cwdPrefix)
      ? def.file.slice(cwdPrefix.length)
      : def.file;

    // Push current position to navigation history before jumping
    navHistory.push({
      filePath: fileTree.selectedPath,
      lineNumber: visibleLineRef.current,
    });

    if (relativePath === fileTree.selectedPath) {
      // Same file: scroll to target line
      fileTree.setTargetLineNumber(def.line);
    } else {
      handleSelectFileWithSave(relativePath, def.line);
    }
  }, [fileTree, cwd, isLSPSupported, lspDefinition, navHistory]);

  // Shared entry point for every hover surface. `inDiff` only affects the
  // card's action row: "find references" switches to the search tab, which
  // would tear down the diff the user is reading, so diff-sourced cards
  // offer just search + explain.
  const runLSPTokenHover = useCallback((
    path: string | null | undefined,
    inDiff: boolean,
    line: number,
    column: number,
    rect: { x: number; y: number },
  ) => {
    if (!path || getLanguageForFile(path) === null) return;
    setLspHoverInDiff(inDiff);
    lspHover.onTokenMouseEnter(path, line, column, rect);
  }, [lspHover]);

  const handleLSPTokenHover = useCallback((line: number, column: number, rect: { x: number; y: number }) => {
    if (!isLSPSupported) return;
    runLSPTokenHover(fileTree.selectedPath, false, line, column, rect);
  }, [fileTree.selectedPath, isLSPSupported, runLSPTokenHover]);

  const handleLSPReferenceSelect = useCallback((ref: Location) => {
    const cwdPrefix = cwd.endsWith('/') ? cwd : cwd + '/';
    const relativePath = ref.file.startsWith(cwdPrefix)
      ? ref.file.slice(cwdPrefix.length)
      : ref.file;

    // Push current position to navigation history before jumping
    if (fileTree.selectedPath) {
      navHistory.push({ filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current });
    }

    if (relativePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(ref.line);
    } else {
      handleSelectFileWithSave(relativePath, ref.line);
    }
  }, [fileTree, cwd, navHistory]);

  // ========== gitStatusMap (depends on both useFileTree and useGitStatus) ==========
  const gitStatusMap = useMemo<GitStatusMap | null>(() => {
    if (!gitStatus.status) return null;
    const map = new Map<string, GitStatusCode>();

    const toStatusCode = (s: GitFileStatus['status']): GitStatusCode => {
      switch (s) {
        case 'modified': return 'M';
        case 'added': return 'A';
        case 'deleted': return 'D';
        case 'renamed': return 'R';
        // Untracked folds into 'A': anything git surfaces here already survived
        // .gitignore, so from the tree's point of view it is a new file. Matches
        // the changes tab (GitFileTree's StatusIcon), which never split the two.
        case 'untracked': return 'A';
        default: return 'M';
      }
    };

    for (const file of gitStatus.status.staged) {
      map.set(file.path, toStatusCode(file.status));
    }
    for (const file of gitStatus.status.unstaged) {
      map.set(file.path, toStatusCode(file.status));
    }

    return map;
  }, [gitStatus.status]);

  /** New path -> pre-rename path. Only staged entries carry `oldPath` (git only
   *  detects renames once they are in the index), and it is what lets a renamed
   *  file diff against its real HEAD content instead of looking wholly new. */
  const renameOldPaths = useMemo(() => {
    if (!gitStatus.status) return null;
    const map = new Map<string, string>();
    for (const f of gitStatus.status.staged) {
      if (f.status === 'renamed' && f.oldPath) map.set(f.path, f.oldPath);
    }
    return map;
  }, [gitStatus.status]);

  /** Stable across renders — DiffView / DiffUnifiedView are memo'd heavy
   *  renderers, and an inline arrow here would re-render them on every
   *  unrelated FileBrowserModal update. */
  const handleDiffContentSearch = useCallback((query: string) => {
    setActiveTab('search');
    contentSearch.setContentSearchQuery(query);
    contentSearch.performContentSearch(query);
  }, [contentSearch.setContentSearchQuery, contentSearch.performContentSearch]);

  // ========== Directory-tree viewer diff mode ==========
  // Clicking a modified file in the tree opens its diff instead of the plain
  // viewer; the header's exit button flips back to full text. Scoped to the
  // tree tab at the render sites below — search / recent keep the plain viewer.
  const treeDiff = useTreeFileDiff({
    cwd,
    selectedPath: fileTree.selectedPath,
    gitStatusMap,
    renameOldPaths,
    isText: fileTree.fileContent?.type === 'text',
    refreshKey: fileTree.fileContent?.mtime,
  });
  // Diff mode owns the whole viewer: the header's reading-mode buttons (blame /
  // edit / preview / code map) are hidden while it is on, so this one flag
  // gates both the toolbar and the main area.
  const treeDiffActive = activeTab === 'tree' && treeDiff.showDiff;

  // ========== Set menu container after mount ==========
  useEffect(() => {
    setMenuContainer(menuContainerRef.current);
  }, []);

  // ========== Update activeTab when initialTab changes ==========
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, tabSwitchTrigger]);

  // ========== Handle external search query (from Chat) ==========
  useEffect(() => {
    if (initialSearchQuery) {
      setActiveTab('search');
      contentSearch.setContentSearchQuery(initialSearchQuery);
      contentSearch.performContentSearch(initialSearchQuery);
    }
  }, [searchQueryTrigger]);  

  // ========== Tab Switch Handler ==========
  const handleTabChange = useCallback((tab: TabType) => {
    setActiveTab(tab);
    fileTree.setBlameSelectedCommit(null);
    // Refresh commits when switching to the history tab as a fallback (prevents stale data from missed watch events)
    if (tab === 'history' && gitHistory.selectedBranch) {
      gitHistory.loadCommits(gitHistory.selectedBranch);
    }
  }, [fileTree, gitHistory.selectedBranch, gitHistory.loadCommits]);

  // ========== Navigation History: Go Back / Go Forward ==========
  const handleNavBack = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const current = { filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current };
    const target = navHistory.goBack(current);
    if (!target) return;
    if (target.filePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(target.lineNumber);
    } else {
      handleSelectFileWithSave(target.filePath, target.lineNumber);
    }
  }, [fileTree, navHistory]);

  const handleNavForward = useCallback(() => {
    if (!fileTree.selectedPath) return;
    const current = { filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current };
    const target = navHistory.goForward(current);
    if (!target) return;
    if (target.filePath === fileTree.selectedPath) {
      fileTree.setTargetLineNumber(target.lineNumber);
    } else {
      handleSelectFileWithSave(target.filePath, target.lineNumber);
    }
  }, [fileTree, navHistory]);

  // ========== Copy / Paste Handlers ==========
  const handleCopyFile = useCallback(async (path: string) => {
    const fileName = path.split('/').pop() || path;
    const exit = await BrowserRuntime.runPromiseExit(
      saveFileClipboard({ cwd, path })
    );
    if (exit._tag === 'Success') {
      toast(t('toast.copiedName', { name: fileName }), 'success');
    } else {
      toast(t('toast.copyFailed'), 'error');
    }
  }, [cwd, t]);

  const handlePaste = useCallback(async (targetDir: string) => {
    // Read the file path from the system clipboard
    const clipExit = await BrowserRuntime.runPromiseExit(loadFileClipboard());
    if (clipExit._tag !== 'Success' || !(clipExit.value as { path?: string }).path) {
      toast(t('toast.noFileToPaste'), 'info');
      return;
    }
    const sourcePath = (clipExit.value as { path: string }).path;

    const pasteExit = await BrowserRuntime.runPromiseExit(
      pasteFiles<{ newName?: string; error?: string }>({
        cwd,
        targetDir,
        sourceAbsPath: sourcePath,
      })
    );
    if (pasteExit._tag === 'Success') {
      toast(t('toast.pastedFile', { name: pasteExit.value.newName }), 'success');
      fileTree.loadDirectory(targetDir);
      fileTree.loadFileIndex();
    } else {
      // Surface the underlying body.error
      const failure = pasteExit.cause._tag === 'Fail' ? pasteExit.cause.error : null;
      const inner = failure?.cause;
      const msg = inner instanceof Error ? inner.message : t('toast.pasteFailed');
      toast(msg, 'error');
    }
  }, [cwd, fileTree, t]);

  // ========== Keyboard Shortcuts ==========
  const lastEscTimeRef = useRef<number>(0);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle shortcuts when Explorer panel is active (except ESC which always works)
      const isExplorerActive = activeView === 'explorer';

      // Ctrl+- → Go Back / Ctrl+Shift+- → Go Forward
      // Use e.code to detect the physical key, avoiding Shift turning '-' into '_'
      // Intercept on all panels to keep behavior consistent; only act when Explorer is active.
      if (e.ctrlKey && !e.metaKey && e.code === 'Minus') {
        e.preventDefault();
        if (!isExplorerActive) return;
        if (e.shiftKey) {
          handleNavForward();
        } else {
          handleNavBack();
        }
        return;
      }

      // Cmd+P / Ctrl+P → Quick file open
      // Works from any panel: switch to Explorer if needed, then open Quick Open.
      // Prevents the browser print dialog from leaking through on Agent/Console panels.
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!isExplorerActive) {
          onViewChange('explorer');
          setShowQuickOpen(true);
        } else {
          setShowQuickOpen(prev => !prev);
        }
        return;
      }

      // Cmd+C → copy selected file to system clipboard (only in tree/recent tab and not inside an input)
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'c' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        const sel = window.getSelection()?.toString();
        if ((activeTab === 'tree' || activeTab === 'recent') && fileTree.selectedPath && !sel && tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          handleCopyFile(fileTree.selectedPath);
          return;
        }
      }

      // Cmd+V → paste into the directory of the selected file
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'v') {
        const tag = (e.target as HTMLElement)?.tagName;
        if ((activeTab === 'tree' || activeTab === 'recent') && tag !== 'INPUT' && tag !== 'TEXTAREA' && !(e.target as HTMLElement)?.isContentEditable) {
          e.preventDefault();
          handlePaste(getTargetDirPath(fileTree.selectedPath, fileTree.files));
          return;
        }
      }

      // Cmd+F in JSON readable mode → open JSON search
      if (isExplorerActive && (e.metaKey || e.ctrlKey) && e.key === 'f') {
        if (jsonPreview) {
          e.preventDefault();
          jsonPreviewSearch.open();
          return;
        }
        if (fileTree.previewMarkdown && fileTree.selectedPath && isJsonFile(fileTree.selectedPath)) {
          e.preventDefault();
          jsonSearch.open();
          return;
        }
      }

      if (isExplorerActive && e.key === 'Escape') {
        // Close quick open first
        if (showQuickOpen) {
          setShowQuickOpen(false);
          return;
        }

        // Close JSON search bar first
        if (jsonPreviewSearch.isVisible) {
          jsonPreviewSearch.close();
          return;
        }
        if (jsonSearch.isVisible) {
          jsonSearch.close();
          return;
        }
        // jsonPreview modal → close modal
        if (jsonPreview) {
          setJsonPreview(null);
          return;
        }

        const now = Date.now();
        if (now - lastEscTimeRef.current < 3000) {
          return;
        }
        lastEscTimeRef.current = now;

        // Close bottom panel first
        if (lspReferences.visible) {
          lspReferences.closeReferences();
        } else if (showSearchPanel) {
          setShowSearchPanel(false);
        } else if (fileTree.blameSelectedCommit) {
          fileTree.setBlameSelectedCommit(null);
        } else if (fileTree.showBlame) {
          fileTree.setShowBlame(false);
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, fileTree.showBlame, fileTree.blameSelectedCommit, fileTree, showQuickOpen, lspReferences.visible, lspReferences.closeReferences, showSearchPanel, handleNavBack, handleNavForward, jsonSearch, jsonPreview, jsonPreviewSearch, activeTab, handleCopyFile, handlePaste, activeView, onViewChange]);

  // ========== Initial Data Load (once on mount) ==========
  useEffect(() => {
    fileTree.loadFiles();
    fileTree.loadFileIndex();
    fileTree.loadRecentFiles();
    gitStatus.fetchStatus();
    gitHistory.loadBranches();
     
  }, []);

  // Listen for external git operations (e.g., ChatInput's stage button) to trigger a refresh
  useEffect(() => {
    const handler = () => { gitStatus.fetchStatus(); };
    window.addEventListener('git-status-changed', handler);
    return () => window.removeEventListener('git-status-changed', handler);
  }, [gitStatus.fetchStatus]);

  // Refresh data once when the iframe becomes visible again (changes may be missed while WS is paused)
  const prevVisibleRef = useRef(pageVisible);
  useEffect(() => {
    if (pageVisible && !prevVisibleRef.current) {
      fileTree.loadFiles();
      fileTree.loadFileIndex();
      fileTree.loadRecentFiles();
      gitStatus.fetchStatus();
      gitHistory.loadBranches();
    }
    prevVisibleRef.current = pageVisible;
   
  }, [pageVisible]);

  // Load commits when branch changes
  useEffect(() => {
    if (gitHistory.selectedBranch) {
      gitHistory.loadCommits(gitHistory.selectedBranch);
    }
  }, [gitHistory.selectedBranch, gitHistory.loadCommits]);

  // ========== Auto-select first recent file when switching to tree/recent tab ==========
  const prevTabRef = useRef<TabType>(activeTab);
  // A file link also switches `activeTab` to tree. On the following render the
  // recent-file effect would otherwise mistake that programmatic transition
  // for a normal status/history → tree switch and overwrite the explicit file.
  const skipNextRecentAutoSelectRef = useRef(false);
  useEffect(() => {
    const prevTab = prevTabRef.current;
    prevTabRef.current = activeTab;

    if (activeTab === 'tree' && skipNextRecentAutoSelectRef.current) {
      skipNextRecentAutoSelectRef.current = false;
      return;
    }

    if ((activeTab === 'tree' || activeTab === 'recent') && fileTree.recentFiles.length > 0) {
      const isFromOtherTab = prevTab === 'status' || prevTab === 'history';
      const firstRecentPath = fileTree.recentFiles[0].path;
      const needsUpdate = !fileTree.selectedPath || (isFromOtherTab && fileTree.selectedPath !== firstRecentPath);

      if (needsUpdate) {
        fileTree.setShouldScrollToSelected(true);
        handleSelectFileWithSave(firstRecentPath);
      }
    }
  }, [activeTab, fileTree.recentFiles, fileTree.selectedPath, handleSelectFileWithSave, fileTree]);

  // ========== Auto-sync via SSE file watching ==========
  // Use ref to store the latest values, avoiding SSE callbacks depending on frequently changing state
  const selectedBranchRef = useRef(gitHistory.selectedBranch);
  selectedBranchRef.current = gitHistory.selectedBranch;
  const selectedPathRef = useRef(fileTree.selectedPath);
  selectedPathRef.current = fileTree.selectedPath;
  const fileContentTypeRef = useRef(fileTree.fileContent?.type);
  fileContentTypeRef.current = fileTree.fileContent?.type;

  const handleWatchMessage = useCallback(async (msg: unknown) => {
    try {
      const { data: events } = msg as { type: string; data: Array<{ type: 'file' | 'git' }> };
      // This socket also carries `graphProgress` frames, whose `data` is an
      // object — without the array check every frame threw into the catch
      // below (harmless but ~10 console errors/second during an index build).
      if (!Array.isArray(events)) return;

      const hasGitChange = events.some(ev => ev.type === 'git');
      const hasFileChange = events.some(ev => ev.type === 'file');

      const promises: Promise<void>[] = [];

      if (hasFileChange || hasGitChange) {
        promises.push(
          BrowserRuntime.runPromise(loadFilesInit<FileNode>(cwd))
            .then(data => {
              if (data.error) return;
              // Merge instead of replace: `/api/files/init` only fills children
              // for dirs in the persisted expandedPaths file, so a wholesale
              // replace would drop children for any dir the client expanded
              // in-memory (in particular search-mode `searchTreeExpandedPaths`,
              // which is never persisted). That visible "collapse" is what
              // causes the directory-tree flicker while files keep changing.
              // See `mergeFileTree` jsdoc for the per-node semantics.
              fileTree.setFiles(prev => mergeFileTree((data.files ?? []) as FileNode[], prev));
            })
            .catch(() => {})
        );
        promises.push(
          BrowserRuntime.runPromise(loadFileIndex(cwd))
            .then(data => { if (data.paths) fileTree.setFileIndex(data.paths as string[]); })
            .catch(() => {})
        );
        promises.push(
          BrowserRuntime.runPromise(loadRecentFiles<RecentFileEntry>(cwd))
            .then(data => { fileTree.setRecentFiles((data.files ?? []) as RecentFileEntry[]); })
            .catch(() => {})
        );
      }

      if (hasGitChange || hasFileChange) {
        promises.push(
          BrowserRuntime.runPromise(fetchGitStatus(cwd))
            .then((statusData) => {
              const typed = statusData as unknown as GitStatusResponse;
              gitStatus.setStatus(typed);
              const staged = buildGitFileTree(typed.staged);
              const unstaged = buildGitFileTree(typed.unstaged);
              gitStatus.setStagedTree(staged);
              gitStatus.setUnstagedTree(unstaged);
              // Do NOT mutate fold state here — useGitStatus derives expandedPaths from
              // (allTreeDirs − userCollapsedPaths), so a refetch can never re-expand a
              // folder the user just collapsed.
            })
            .catch(() => {})
        );
        // Refresh the currently viewed diff
        gitStatus.refreshDiff();

        if (hasGitChange) {
          // Sync BranchSelector when the branch changes
          gitHistory.loadBranches();
        }
        // Refresh commits list (needed for git events like commit/rebase/merge and file change events)
        const branch = selectedBranchRef.current;
        if (branch) {
          promises.push(
            BrowserRuntime.runPromise(fetchCommits(cwd, branch, COMMITS_PER_PAGE))
              .then(data => {
                const newCommits = (data.commits ?? []) as Commit[];
                gitHistory.setCommits(newCommits);
                gitHistory.setHasMoreCommits(newCommits.length >= COMMITS_PER_PAGE);
              })
              .catch(() => {})
          );
        }
      }

      const currentPath = selectedPathRef.current;
      const currentType = fileContentTypeRef.current;
      if (currentPath && currentType === 'text') {
        promises.push(
          BrowserRuntime.runPromise(fetchFileText(cwd, currentPath))
            .then(result => {
              const data = result.ok ? result.data : null;
              if (data && typeof data.content === 'string') {
                fileTree.setFileContent({
                  type: 'text',
                  content: data.content,
                  size: data.size,
                  mtime: data.mtimeMs,
                  ...(data.isSymlink ? { isSymlink: true, symlinkTarget: data.symlinkTarget } : {}),
                });
              }
            })
            .catch(() => {})
        );
      }

      await Promise.all(promises);
    } catch (err) {
      console.error('File watch handler error:', err);
    }
  // fileTree/gitStatus/gitHistory are stable object references returned by hooks and do not change frequently
   
  }, [cwd]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: handleWatchMessage,
    enabled: pageVisible,  // Pause file watching for hidden iframes to avoid unnecessary concurrent requests
  });

  // ========== Helper: locate in tree ==========
  const locateInTree = useCallback((filePath: string) => {
    // Select + load content + expand parent dirs (with the edit-mode save guard),
    // then bring the tree into view. handleSelectFile (via handleSelectFileWithSave)
    // already sets selectedPath, expands parents AND loads file content — the latter
    // is the piece the old locate path was missing, which left the right pane showing
    // a stale file after switching to the tree.
    handleSelectFileWithSave(filePath);
    fileTree.setShouldScrollToSelected(true);
    setActiveTab('tree');
  }, [fileTree, handleSelectFileWithSave]);

  const selectFileWithSaveRef = useRef(handleSelectFileWithSave);
  useEffect(() => {
    selectFileWithSaveRef.current = handleSelectFileWithSave;
  }, [handleSelectFileWithSave]);
  const lastFileOpenNonceRef = useRef<number | null>(null);
  const { setPreviewMarkdown, setShouldScrollToSelected } = fileTree;

  useEffect(() => {
    if (!fileOpenRequest) return;
    // `loadFiles` hydrates the persisted expansion state. Let it finish before
    // selecting a deep file so that hydration cannot overwrite the parent
    // directories expanded by handleSelectFile.
    if (fileTree.isLoadingFiles) return;
    if (lastFileOpenNonceRef.current === fileOpenRequest.nonce) return;
    lastFileOpenNonceRef.current = fileOpenRequest.nonce;
    skipNextRecentAutoSelectRef.current = true;
    setEditorMode('code');
    setActiveTab('tree');
    if (fileOpenRequest.lineNumber != null) setPreviewMarkdown(false);
    selectFileWithSaveRef.current(fileOpenRequest.path, fileOpenRequest.lineNumber);
    setShouldScrollToSelected(true);
  }, [fileOpenRequest, fileTree.isLoadingFiles, setPreviewMarkdown, setShouldScrollToSelected]);

  // ========== Code Map header slots (shared by the plain and diff variants) ==========
  // Both map variants take over the whole right panel, so their header is the
  // only toolbar the user has. These two slots are what keep it at parity with
  // the code-mode toolbar; defining them once means the plain map and the diff
  // map can never drift apart.

  /** Left slot: copy-abs-path + locate-in-tree, driven by BlockViewer's LIVE
   *  focal so they follow pin navigation instead of acting on the path the
   *  host knew at mount time. */
  const mapHeaderExtraLeft = useCallback(({ focalFile }: BlockViewerHeaderState) =>
    focalFile && (
      <>
        <button
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(`${cwd}/${focalFile}`);
            toast(t('common.copiedPath'));
          }}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
          title={t('common.copyAbsPath')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            locateInTree(focalFile);
          }}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
          title={t('fileBrowser.locateInTree')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" strokeWidth={2} />
            <circle cx="12" cy="12" r="3" strokeWidth={2} />
            <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
          </svg>
        </button>
      </>
    ),
  [cwd, locateInTree, t]);

  /** Right slot: the diff switch (and, while diff is on, the 精简/全文 density
   *  switch). Diff and map are INDEPENDENT toggles — this is the diff one, in
   *  map mode, so all four combinations stay reachable from either side.
   *
   *  Hidden unless focal is still the tree-selected file: `useTreeFileDiff` is
   *  keyed on `selectedPath`, so after a pin-jump the button would silently
   *  toggle a file the user has navigated away from. */
  const mapHeaderExtraRight = useCallback(({ focalFile }: BlockViewerHeaderState) => {
    if (activeTab !== 'tree' || !treeDiff.canDiff) return null;
    if (focalFile !== fileTree.selectedPath) return null;
    return (
      <>
        {treeDiff.showDiff && (
          <DiffDensityToggle value={treeDiffDensity} onChange={setTreeDiffDensity} />
        )}
        <button
          onClick={treeDiff.toggleDiff}
          className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
            treeDiff.showDiff ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-hover'
          }`}
          title={treeDiff.showDiff ? t('fileBrowser.exitDiff') : t('fileBrowser.viewDiff')}
        >
          {t('common.diff')}
        </button>
      </>
    );
  }, [activeTab, treeDiff.canDiff, treeDiff.showDiff, treeDiff.toggleDiff, fileTree.selectedPath, treeDiffDensity, t]);

  // One-shot anchor to scroll to after a markdown-link cross-file navigation.
  const [mdLinkAnchor, setMdLinkAnchor] = useState<string | null>(null);

  // Open a local .md link target in-place: load + preview it, highlight it in
  // the file tree, and (if the link had a #anchor) scroll there after render.
  const handleOpenMarkdownLink = useCallback((targetRel: string, anchor: string | null) => {
    fileTree.setPreviewMarkdown(true);     // defensive — ensure in-place preview
    locateInTree(targetRel);               // load + select + expand + scroll → tree highlight
    setMdLinkAnchor(anchor);
    if (anchor) {
      // Clear after the target preview's scroll effect (~80ms) has consumed it,
      // so later re-renders of the same file don't re-scroll.
      setTimeout(() => setMdLinkAnchor(null), 400);
    }
  }, [fileTree, locateInTree]);

  return (
    <MenuContainerProvider container={menuContainer}>
      <div ref={menuContainerRef} className="bg-card w-full h-full flex flex-col relative">
        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel */}
          <div
            className="flex-shrink-0 flex flex-col overflow-hidden"
            style={{ width: treeWidth }}
          >
            {/* Tabs */}
            <div className="flex border-b border-border">
              <button
                onClick={() => handleTabChange('tree')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'tree'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.directoryTree')}
              </button>
              <button
                onClick={() => handleTabChange('search')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'search'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.searchTab')}
              </button>
              <button
                onClick={() => handleTabChange('recent')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'recent'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.recentTab')}
              </button>
              <button
                onClick={() => handleTabChange('status')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'status'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.changesTab')}
              </button>
              <button
                onClick={() => handleTabChange('history')}
                className={`flex-1 px-2 py-2 text-sm font-medium transition-colors ${
                  activeTab === 'history'
                    ? 'text-brand border-b-2 border-brand'
                    : 'text-muted-foreground hover:text-foreground dark:hover:text-foreground'
                }`}
              >
                {t('fileBrowser.historyTab')}
              </button>
            </div>

            {/* Tab-specific content above list */}
            {activeTab === 'tree' && (
              <div className="p-2 border-b border-border flex items-center gap-2">
                <div className="flex-1 relative">
                  <input
                    ref={fileTree.searchInputRef}
                    type="text"
                    value={fileTree.searchQuery}
                    onChange={e => fileTree.setSearchQuery(e.target.value)}
                    placeholder={t('fileBrowser.searchFiles')}
                    className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  {fileTree.searchQuery && (
                    <button
                      onClick={() => {
                        fileTree.setSearchQuery('');
                        fileTree.searchInputRef.current?.focus();
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                      title={t('fileBrowser.clear')}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
                {/* Exact directory match toggle */}
                <button
                  onClick={() => fileTree.setSearchDirExact(v => !v)}
                  className={`px-1 py-0.5 rounded transition-colors text-xs font-mono font-bold border ${
                    fileTree.searchExactMatch
                      ? 'border-brand text-brand bg-brand/10'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-hover'
                  }`}
                  title={fileTree.searchExactMatch ? t('fileBrowser.exactMatchOn') : t('fileBrowser.exactMatchOff')}
                >
                  ab
                </button>
                {/* Action button group */}
                <div className="flex items-center gap-0.5">
                  {/* Refresh */}
                  <button
                    onClick={() => fileTree.loadFiles()}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
                    title={t('fileBrowser.refreshTree')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  {/* Collapse all */}
                  <button
                    onClick={() => fileTree.searchTreeExpandedPaths ? fileTree.setSearchTreeExpandedPaths(new Set()) : fileTree.setExpandedPaths(new Set())}
                    className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
                    title={t('fileBrowser.collapseAll')}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'search' && (
              <div className="p-2 border-b border-border space-y-2">
                <div className="flex gap-2">
                  <div className="flex-1 relative">
                    <input
                      ref={contentSearch.contentSearchInputRef}
                      type="text"
                      value={contentSearch.contentSearchQuery}
                      onChange={e => contentSearch.setContentSearchQuery(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          contentSearch.performContentSearch(contentSearch.contentSearchQuery);
                        }
                      }}
                      placeholder={t('fileBrowser.searchFileContent')}
                      className="w-full px-3 py-1.5 pr-7 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    {contentSearch.contentSearchQuery && (
                      <button
                        onClick={() => {
                          contentSearch.setContentSearchQuery('');
                          contentSearch.contentSearchInputRef.current?.focus();
                        }}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                        title={t('fileBrowser.clear')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => contentSearch.performContentSearch(contentSearch.contentSearchQuery)}
                    disabled={contentSearch.isSearching || !contentSearch.contentSearchQuery.trim()}
                    className="px-3 py-1.5 text-sm bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {contentSearch.isSearching ? '...' : t('common.search')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.caseSensitive}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, caseSensitive: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.caseSensitive')}</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.wholeWord}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, wholeWord: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.wholeWord')}</span>
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={contentSearch.searchOptions.regex}
                      onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, regex: e.target.checked }))}
                      className="w-3 h-3"
                    />
                    <span className="text-muted-foreground">{t('fileBrowser.regex')}</span>
                  </label>
                  <input
                    type="text"
                    value={contentSearch.searchOptions.fileType}
                    onChange={e => contentSearch.setSearchOptions(prev => ({ ...prev, fileType: e.target.value }))}
                    placeholder={t('fileBrowser.fileTypes')}
                    className="w-24 px-2 py-0.5 text-xs border border-border rounded bg-card text-foreground"
                  />
                </div>
              </div>
            )}

            {activeTab === 'history' && (
              <div className="p-3 border-b border-border">
                {gitHistory.compareMode ? (
                  /* Compare mode: two rows — HEAD (read-only) + base (selector) */
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-border rounded bg-secondary text-foreground flex items-center gap-2">
                        <svg className="w-4 h-4 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        <span className="truncate">{gitHistory.branches?.current || 'HEAD'}</span>
                        <span className="text-xs text-green-11 flex-shrink-0">HEAD</span>
                      </div>
                      <button
                        onClick={() => gitHistory.toggleCompareMode(false)}
                        className="flex-shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors bg-brand text-white"
                        title={t('fileBrowser.compareModeOff')}
                      >
                        {t('fileBrowser.compareMode')}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground flex-shrink-0 pl-1">vs</span>
                      <div className="flex-1 min-w-0">
                        <BranchSelector
                          branches={gitHistory.branches}
                          selectedBranch={gitHistory.compareBaseBranch}
                          onSelect={(branch) => {
                            gitHistory.setCompareBaseBranch(branch);
                            gitHistory.loadCompareFiles(branch);
                          }}
                          isLoading={gitHistory.isLoadingBranches}
                          pinnedBranches={['origin/main', ...(gitHistory.upstreamBranch && gitHistory.upstreamBranch !== 'origin/main' ? [gitHistory.upstreamBranch] : [])]}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* Normal mode: single branch selector */
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <BranchSelector
                        branches={gitHistory.branches}
                        selectedBranch={gitHistory.selectedBranch}
                        onSelect={(branch) => {
                          gitHistory.setSelectedBranch(branch);
                        }}
                        isLoading={gitHistory.isLoadingBranches}
                        pinnedBranches={['origin/main', ...(gitHistory.upstreamBranch && gitHistory.upstreamBranch !== 'origin/main' ? [gitHistory.upstreamBranch] : [])]}
                      />
                    </div>
                    <button
                      onClick={() => gitHistory.toggleCompareMode(true)}
                      className="flex-shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg transition-colors text-muted-foreground hover:text-foreground hover:bg-hover border border-border"
                      title={t('fileBrowser.compareModeOn')}
                    >
                      {t('fileBrowser.compareMode')}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* List Content - use CSS show/hide to avoid component remounting */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {/* Tree Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'tree' ? '' : 'hidden'}`}>
                {/* New file input box */}
                {fileTree.creatingItem && (
                  <div className="px-2 py-1.5 border-b border-border flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {fileTree.creatingItem.parentPath ? t('fileBrowser.createFileIn', { path: fileTree.creatingItem.parentPath }) : t('fileBrowser.createFile')}
                    </span>
                    <input
                      type="text"
                      autoFocus
                      placeholder={t('fileBrowser.fileName')}
                      className="flex-1 px-2 py-1 text-sm border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      onCompositionStart={() => { composingRef.current = true; }}
                      onCompositionEnd={() => { composingRef.current = false; }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          if (composingRef.current) return;
                          const name = (e.target as HTMLInputElement).value.trim();
                          if (!name) return;
                          const parentPath = fileTree.creatingItem!.parentPath;
                          const fullPath = parentPath ? `${parentPath}/${name}` : name;
                          const exit = await BrowserRuntime.runPromiseExit(
                            saveFile({ cwd, path: fullPath, content: '' })
                          );
                          if (exit._tag === 'Success' && exit.value.ok) {
                            toast(t('toast.createdFile', { name }), 'success');
                            fileTree.setCreatingItem(null);
                            fileTree.loadDirectory(parentPath);
                            fileTree.loadFileIndex();
                            if (parentPath) {
                              fileTree.setExpandedPaths(prev => new Set([...prev, parentPath]));
                            }
                            handleSelectFileWithSave(fullPath);
                          } else if (exit._tag === 'Success') {
                            // res.ok = false but the request itself did not fail — surface the backend error
                            const errorMsg = (exit.value.data as { error?: string } | null)?.error;
                            toast(errorMsg || t('toast.createFailed'), 'error');
                          } else {
                            toast(t('toast.createFailed'), 'error');
                          }
                        } else if (e.key === 'Escape') {
                          fileTree.setCreatingItem(null);
                        }
                      }}
                      onBlur={() => fileTree.setCreatingItem(null)}
                    />
                  </div>
                )}
                {fileTree.isLoadingFiles ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
                ) : fileTree.fileError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{fileTree.fileError}</div>
                ) : (
                  <FileTree
                    files={fileTree.files}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.effectiveExpandedPaths}
                    matchedPaths={fileTree.matchedPaths}
                    gitStatusMap={gitStatusMap}
                    loadingDirs={fileTree.loadingDirs}
                    onSelect={(path) => {
                      fileTree.setShouldScrollToSelected(false);
                      handleSelectFileWithSave(path);
                    }}
                    onToggle={fileTree.handleToggle}
                    cwd={cwd}
                    shouldScrollToSelected={fileTree.shouldScrollToSelected}
                    onScrolledToSelected={() => fileTree.setShouldScrollToSelected(false)}
                    onCreateFile={(dirPath) => fileTree.setCreatingItem({ type: 'file', parentPath: dirPath })}
                    onDelete={(path, isDir, name) => setDeleteConfirm({ path, isDirectory: isDir, name })}
                    onRefresh={() => fileTree.loadFiles()}
                    onCopyFile={handleCopyFile}
                    onPaste={handlePaste}
                    onExplain={aiBridge ? handleExplainFile : undefined}
                    explainDisabled={aiBridge?.isLoading}
                  />
                )}
              </div>

              {/* Search Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'search' ? '' : 'hidden'}`}>
                {contentSearch.isSearching ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : contentSearch.searchError ? (
                  <div className="p-4 text-center text-red-11 text-sm">{contentSearch.searchError}</div>
                ) : contentSearch.contentSearchResults.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {contentSearch.contentSearchQuery ? t('fileBrowser.noContentSearchResults') : t('fileBrowser.enterKeywordToSearch')}
                  </div>
                ) : (
                  <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
                    {/* Search statistics */}
                    {contentSearch.searchStats && (
                      <div className="px-3 py-1.5 text-xs text-muted-foreground border-b border-border flex-shrink-0">
                        {t('fileBrowser.nFilesNMatches', { files: contentSearch.searchStats.totalFiles, matches: contentSearch.searchStats.totalMatches })}
                        {contentSearch.searchStats.truncated && <span className="text-amber-11 ml-1">({t('fileBrowser.resultsTruncated')})</span>}
                      </div>
                    )}
                    {/* Search result directory tree — built from search result paths */}
                    <FileTree
                      files={searchData.files}
                      selectedPath={fileTree.selectedPath}
                      expandedPaths={searchTreeExpanded}
                      onSelect={(path) => {
                        const result = searchData.matchMap.get(path);
                        handleSelectFileWithSave(path, result?.matches[0]?.lineNumber);
                        if (!showSearchPanel) setShowSearchPanel(true);
                      }}
                      onToggle={handleSearchTreeToggle}
                      cwd={cwd}
                      onExplain={aiBridge ? handleExplainFile : undefined}
                      explainDisabled={aiBridge?.isLoading}
                      renderActions={renderSearchActions}
                      className="flex-1 overflow-y-auto py-1 min-w-max"
                    />
                  </div>
                )}
              </div>

              {/* Recent Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'recent' ? '' : 'hidden'}`}>
                {fileTree.recentFiles.length === 0 ? (
                  <div className="p-4 text-center text-muted-foreground text-sm">
                    {t('fileBrowser.noRecentFiles')}
                  </div>
                ) : (
                  <FileTree
                    files={fileTree.recentFilesTree}
                    selectedPath={fileTree.selectedPath}
                    expandedPaths={fileTree.recentTreeDirPaths}
                    onSelect={handleSelectFileWithSave}
                    onToggle={NOOP}
                    cwd={cwd}
                    onExplain={aiBridge ? handleExplainFile : undefined}
                    explainDisabled={aiBridge?.isLoading}
                  />
                )}
              </div>

              {/* Status Tab — direct files list (the legacy "Changes"
                  sub-mode that surfaced symbol-level diffs was retired
                  along with ChangesView; symbol-level diffing now lives
                  inside DiffView itself as a Block toggle). */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'status' ? '' : 'hidden'}`}>
                {gitStatus.statusLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : gitStatus.statusError ? (
                  <div className="flex-1 flex items-center justify-center p-4">
                    <span className="text-red-11 text-sm">{gitStatus.statusError}</span>
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    {/* Staged Section */}
                    <div className="border-b border-border">
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-muted-foreground">
                            {t('fileBrowser.stagingArea', { count: gitStatus.status?.staged.length || 0 })}
                          </span>
                          <button
                            onClick={() => gitStatus.fetchStatus()}
                            className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
                            title={t('fileBrowser.refreshChanges')}
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>
                        </div>
                        {(gitStatus.status?.staged.length || 0) > 0 && (
                          <button
                            onClick={gitStatus.handleUnstageAll}
                            className="text-sm text-amber-11 hover:text-amber-10 hover:underline"
                          >
                            {t('fileBrowser.unstageAll')}
                          </button>
                        )}
                      </div>
                      <GitFileTree
                        files={gitStatus.stagedTree}
                        selectedPath={gitStatus.statusSelectedFile?.type === 'staged' ? gitStatus.statusSelectedFile.file.path : null}
                        expandedPaths={gitStatus.stagedExpandedPaths}
                        onSelect={(node) => node.file && gitStatus.handleStatusFileSelect(node.file as GitFileStatus, 'staged')}
                        onToggle={gitStatus.handleStagedToggle}
                        cwd={cwd}
                        emptyMessage={t('fileBrowser.noStagedFiles')}
                        className="py-1"
                        onExplain={aiBridge ? handleExplainStaged : undefined}
                        explainDisabled={aiBridge?.isLoading}
                        renderActions={(node) => {
                          if (node.isDirectory) {
                            const files = collectFilesUnderNode(node);
                            if (files.length === 0) return null;
                            return (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleUnstageFiles(files.map(f => f.path));
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 dark:hover:bg-amber-9/20 rounded transition-all"
                                title={t('fileBrowser.unstageNFiles', { count: files.length })}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                                </svg>
                              </button>
                            );
                          }
                          return (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                gitStatus.handleUnstage(node.path);
                              }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 dark:hover:bg-amber-9/20 rounded transition-all"
                              title={t('fileBrowser.unstageFile')}
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                              </svg>
                            </button>
                          );
                        }}
                      />
                    </div>

                    {/* Unstaged Section */}
                    <div>
                      <div className="flex items-center justify-between px-3 py-2 bg-secondary">
                        <span className="text-sm font-medium text-muted-foreground">
                          {t('fileBrowser.workspace', { count: gitStatus.status?.unstaged.length || 0 })}
                        </span>
                        {(gitStatus.status?.unstaged.length || 0) > 0 && (
                          <div className="flex items-center gap-2">
                            <button
                              onClick={gitStatus.handleDiscardAll}
                              className="text-sm text-red-11 hover:text-red-10 hover:underline"
                            >
                              {t('fileBrowser.discardAll')}
                            </button>
                            <button
                              onClick={gitStatus.handleStageAll}
                              className="text-sm text-green-11 hover:text-green-10 hover:underline"
                            >
                              {t('fileBrowser.stageAll')}
                            </button>
                          </div>
                        )}
                      </div>
                      <GitFileTree
                        files={gitStatus.unstagedTree}
                        selectedPath={gitStatus.statusSelectedFile?.type === 'unstaged' ? gitStatus.statusSelectedFile.file.path : null}
                        expandedPaths={gitStatus.unstagedExpandedPaths}
                        onSelect={(node) => node.file && gitStatus.handleStatusFileSelect(node.file as GitFileStatus, 'unstaged')}
                        onToggle={gitStatus.handleUnstagedToggle}
                        cwd={cwd}
                        emptyMessage={t('fileBrowser.noUnstagedChanges')}
                        className="py-1"
                        onExplain={aiBridge ? handleExplainUnstaged : undefined}
                        explainDisabled={aiBridge?.isLoading}
                        renderActions={(node) => {
                          if (node.isDirectory) {
                            const files = collectFilesUnderNode(node);
                            if (files.length === 0) return null;
                            const fileObjects = files.map(f => f.file as GitFileStatus).filter(Boolean);
                            return (
                              <div className="flex items-center gap-0.5">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    gitStatus.handleDiscardFiles(fileObjects);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-red-11 hover:text-red-10 hover:bg-red-9/10 dark:hover:bg-red-9/20 rounded transition-all"
                                  title={t('fileBrowser.discardNFiles', { count: files.length })}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                  </svg>
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    gitStatus.handleStageFiles(files.map(f => f.path));
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 text-green-11 hover:text-green-10 hover:bg-green-9/10 dark:hover:bg-green-9/20 rounded transition-all"
                                  title={t('fileBrowser.stageNFiles', { count: files.length })}
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                  </svg>
                                </button>
                              </div>
                            );
                          }
                          if (!node.file) return null;
                          return (
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleDiscardFile(node.file as GitFileStatus);
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-red-11 hover:text-red-10 hover:bg-red-9/10 dark:hover:bg-red-9/20 rounded transition-all"
                                title={t('fileBrowser.discardChanges')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                                </svg>
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  gitStatus.handleStage(node.path);
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-green-11 hover:text-green-10 hover:bg-green-9/10 dark:hover:bg-green-9/20 rounded transition-all"
                                title={t('fileBrowser.stageFile')}
                              >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                                </svg>
                              </button>
                            </div>
                          );
                        }}
                      />
                    </div>

                  </div>
                )}
              </div>

              {/* History Tab */}
              <div className={`flex-1 flex flex-col min-h-0 ${activeTab === 'history' ? '' : 'hidden'}`}>
                {gitHistory.historyError ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-16 h-16 mx-auto text-foreground-faint mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <p className="text-muted-foreground">{gitHistory.historyError}</p>
                    </div>
                  </div>
                ) : gitHistory.compareMode ? (
                  /* Compare mode: show file changes list on the left (replaces commit list) */
                  <div className="flex-1 overflow-y-auto overflow-x-hidden">
                    {gitHistory.isLoadingCompareFiles ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.loadingDiff')}</div>
                    ) : gitHistory.compareFiles.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.noDiffFiles')}</div>
                    ) : (
                      <>
                        <div className="px-3 py-2 border-b border-border">
                          <span className="text-xs text-muted-foreground">
                            {t('fileBrowser.nFilesChanged', { count: gitHistory.compareFiles.length, branch: gitHistory.compareBaseBranch })}
                          </span>
                        </div>
                        <GitFileTree
                          files={gitHistory.compareFileTree}
                          expandedPaths={gitHistory.compareExpandedPaths}
                          onToggle={gitHistory.handleCompareToggle}
                          selectedPath={gitHistory.compareSelectedFile?.path || null}
                          onSelect={(node) => {
                            if (node.file) {
                              gitHistory.handleSelectCompareFile(node.file as import('./fileBrowser/types').FileChange);
                            }
                          }}
                          cwd={cwd}
                          showChanges={true}
                          onExplain={aiBridge ? handleExplainCompare : undefined}
                          explainDisabled={aiBridge?.isLoading}
                        />
                      </>
                    )}
                  </div>
                ) : (
                  <div
                    ref={gitHistory.commitListRef}
                    className="flex-1 overflow-y-auto"
                    onScroll={gitHistory.handleCommitListScroll}
                  >
                    {gitHistory.isLoadingCommits ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.loadingCommits')}</div>
                    ) : gitHistory.commits.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground text-sm">{t('fileBrowser.noCommits')}</div>
                    ) : (
                      <>
                        {gitHistory.commits.map(commit => (
                          <div
                            key={commit.hash}
                            onClick={() => gitHistory.handleSelectCommit(commit)}
                            className={`px-3 py-2 border-b border-border cursor-pointer hover:bg-hover ${
                              gitHistory.selectedCommit?.hash === commit.hash ? 'bg-brand/10' : ''
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs text-brand">{commit.shortHash}</span>
                              <span className="text-xs text-foreground-subtle" data-tooltip={commit.date}>
                                {commit.relativeDate} · {formatDateTime(commit.date)}
                              </span>
                            </div>
                            <div className="text-sm text-foreground truncate mt-0.5" data-tooltip={commit.subject}>{commit.subject}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{commit.author}</div>
                          </div>
                        ))}
                        {gitHistory.isLoadingMore && (
                          <div className="p-3 text-center">
                            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                          </div>
                        )}
                        {!gitHistory.hasMoreCommits && gitHistory.commits.length > 0 && (
                          <div className="p-3 text-center text-xs text-foreground-subtle">
                            {t('fileBrowser.allLoaded', { count: gitHistory.commits.length })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Divider — 5px hit area around a 1px line, drag to resize the tree */}
          <div
            onPointerDown={handleTreeResizeStart}
            onPointerMove={handleTreeResizeMove}
            onPointerUp={handleTreeResizeEnd}
            onPointerCancel={handleTreeResizeEnd}
            className="w-[5px] flex-shrink-0 relative cursor-col-resize group"
          >
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-brand transition-colors" />
          </div>

          {/* Right Panel */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* File Browser / Recent / Search - Right Panel */}
            {(activeTab === 'tree' || activeTab === 'search' || activeTab === 'recent') && (
              fileTree.blameSelectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => fileTree.setBlameSelectedCommit(null)}
                  commit={fileTree.blameSelectedCommit}
                  cwd={cwd}
                  embedded={true}
                  initialFilePath={fileTree.selectedPath || undefined}
                  onContentSearch={(query) => {
                    setActiveTab('search');
                    contentSearch.setContentSearchQuery(query);
                    contentSearch.performContentSearch(query);
                  }}
                />
              ) : editorMode === 'map' ? (
                // Code Map takes over the right panel. The left file tree
                // stays visible — clicking a file there auto-expands the
                // path in the map and pans to the file node.
                //
                // Diff and map are INDEPENDENT toggles, so this branch has
                // two variants: with diff on, the chip canvas gets the diff
                // overlay (BlockDiffViewer); with it off, the plain map. The
                // header slots are shared, so the diff switch and the file
                // controls sit in the same place either way.
                //
                // Falling back to the plain map while `treeDiff.diff` is still
                // in flight costs a remount when it lands. Accepted: the
                // alternative is a projection built from empty content, which
                // renders the whole file as added.
                treeDiffActive && treeDiff.diff ? (
                  <BlockDiffViewer
                    cwd={cwd}
                    filePath={treeDiff.diff.filePath}
                    oldContent={treeDiff.diff.oldContent}
                    newContent={treeDiff.diff.newContent}
                    isNew={treeDiff.diff.isNew}
                    isDeleted={treeDiff.diff.isDeleted}
                    changedFiles={changedFilePathSet}
                    // Cross-file pin jumps re-fetch the neighbour's staged /
                    // unstaged diff, while the anchor file above is HEAD ->
                    // worktree. Deliberate: it matches the changes tab, and
                    // unifying it would mean threading a diff-type through
                    // BlockDiffViewer for a case that only differs when a file
                    // is partially staged.
                    fileGitStatusMap={fileGitStatusMap}
                    compact={treeDiffDensity === 'compact'}
                    enableComments
                    onSwitchToCode={() => setEditorMode('code')}
                    onContentSearch={handleDiffContentSearch}
                    headerExtraLeft={mapHeaderExtraLeft}
                    headerExtraRight={mapHeaderExtraRight}
                  />
                ) : (
                  <BlockViewer
                    cwd={cwd}
                    highlightedFilePath={fileTree.selectedPath}
                    changedFiles={changedFilePathSet}
                    onSwitchToCode={() => setEditorMode('code')}
                    enableComments
                    onContentSearch={handleDiffContentSearch}
                    headerExtraLeft={mapHeaderExtraLeft}
                    headerExtraRight={mapHeaderExtraRight}
                  />
                )
              ) : fileTree.selectedPath ? (
                <>
                  <div className="px-4 py-2 border-b border-border flex-shrink-0 flex items-center justify-between">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-sm text-muted-foreground truncate">
                        {fileTree.selectedPath}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigator.clipboard.writeText(`${cwd}/${fileTree.selectedPath}`);
                          toast(t('common.copiedPath'));
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
                        title={t('common.copyAbsPath')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      {/* Locate button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          locateInTree(fileTree.selectedPath!);
                        }}
                        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
                        title={t('fileBrowser.locateInTree')}
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <circle cx="12" cy="12" r="10" strokeWidth={2} />
                          <circle cx="12" cy="12" r="3" strokeWidth={2} />
                          <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                        </svg>
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {fileTree.showEditor ? (
                        <>
                          {/* Edit mode: save + close */}
                          {editorState.isDirty && (
                            <span className="text-xs text-amber-11">{t('fileBrowser.unsaved')}</span>
                          )}
                          <button
                            onClick={() => editorHandleRef.current?.save()}
                            disabled={!editorState.isDirty || editorState.isSaving}
                            className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                              editorState.isDirty && !editorState.isSaving
                                ? 'bg-brand text-white hover:bg-brand/90'
                                : 'bg-secondary text-muted-foreground cursor-not-allowed'
                            }`}
                          >
                            {editorState.isSaving ? (
                              <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              t('common.save')
                            )}
                          </button>
                          <button
                            onClick={() => editorHandleRef.current?.close()}
                            className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                            title={t('fileBrowser.closeEdit')}
                          >
                            {t('fileBrowser.closeBtn')}
                          </button>
                        </>
                      ) : treeDiffActive ? (
                        <>
                          {/* Diff mode: diff-shape controls, the map switch, and
                              the way out. The single-view reading modes (blame /
                              preview / edit) stay absent — each is its own take
                              on the file and combining them with the diff
                              projection multiplies states for no gain.
                              Code Map is the exception: diff and map are
                              independent axes, so it stays reachable and simply
                              carries the diff overlay across. */}
                          <DiffDensityToggle value={treeDiffDensity} onChange={setTreeDiffDensity} />
                          <DiffViewModeToggle value={treeDiffViewMode} onChange={setTreeDiffViewMode} />
                          {!isMarkdownFile(fileTree.selectedPath) && !isHtmlFile(fileTree.selectedPath) && !isJsonFile(fileTree.selectedPath) && !isCsvFile(fileTree.selectedPath) && (
                            <button
                              onClick={() => setEditorMode('map')}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                              title={t('blockViewer.viewerToggle.toBlock')}
                            >
                              {t('common.codeMap')}
                            </button>
                          )}
                          <button
                            onClick={treeDiff.toggleDiff}
                            className="px-1.5 py-0.5 text-xs rounded transition-colors bg-brand text-white"
                          >
                            {t('fileBrowser.exitDiff')}
                          </button>
                        </>
                      ) : (
                        <>
                          {/* View mode order: share · readable/preview · blame · copy · codemap · edit */}
                          {/* Diff — only for files git reports as modified/renamed,
                              and only on the tree tab. Same toggle the diff-mode
                              header exits with, so the two directions are one
                              button in two states. */}
                          {activeTab === 'tree' && treeDiff.canDiff && (
                            <button
                              onClick={treeDiff.toggleDiff}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                              title={t('fileBrowser.viewDiff')}
                            >
                              {t('common.diff')}
                            </button>
                          )}
                          {/* Share first — markdown only. Style left unchanged (this component
                              is shared with the agent-chat / diff-view preview headers). */}
                          {fileTree.fileContent?.type === 'text' && isMarkdownFile(fileTree.selectedPath) && (
                            <ShareReviewToggle
                              content={fileTree.fileContent.content || ''}
                              sourceFile={
                                fileTree.selectedPath && cwd && fileTree.selectedPath.startsWith(cwd)
                                  ? fileTree.selectedPath.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1)
                                  : (fileTree.selectedPath || '')
                              }
                            />
                          )}
                          {/* Collapse / expand every foldable long-text value in the JSON
                              preview at once. Only foldable *strings* fold (see
                              isMultilineValue) — objects and arrays always render in full,
                              so this is not a JSON-tree collapse. Shown only while the JSON
                              preview is actually on screen, i.e. not in blame view. */}
                          {fileTree.fileContent?.type === 'text' && isJsonFile(fileTree.selectedPath) && fileTree.previewMarkdown && !fileTree.showBlame && (
                            <div className="flex items-center gap-0.5 rounded border border-border overflow-hidden">
                              {([true, false] as const).map((collapsed) => (
                                <button
                                  key={String(collapsed)}
                                  // Always bumps version, even when this side is already
                                  // active — that's how you re-assert the command after
                                  // individually clicking a few entries open.
                                  onClick={(e) => { e.stopPropagation(); setJsonCollapse(c => ({ version: c.version + 1, collapsed })); }}
                                  className={`px-2 py-0.5 text-xs transition-colors ${
                                    jsonCollapse.collapsed === collapsed ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-hover'
                                  }`}
                                >
                                  {t(collapsed ? 'fileBrowser.collapseAllJson' : 'fileBrowser.expandAllJson')}
                                </button>
                              ))}
                            </div>
                          )}
                          {fileTree.fileContent?.type === 'text' && (isMarkdownFile(fileTree.selectedPath) || isHtmlFile(fileTree.selectedPath) || isJsonFile(fileTree.selectedPath) || isCsvFile(fileTree.selectedPath)) && (() => {
                            // Preview toggle: ON → main area renders the md / html / json
                            // / csv preview in-place (replacing CodeViewer). HTML uses its OWN
                            // flag (previewHtml, default OFF) so an interactive+SDK preview
                            // never auto-renders — the click is the trust gesture. md/json
                            // keep the shared, default-on previewMarkdown flag, and so does csv.
                            const isHtml = isHtmlFile(fileTree.selectedPath);
                            const on = isHtml ? fileTree.previewHtml : fileTree.previewMarkdown;
                            const toggle = () => isHtml ? fileTree.setPreviewHtml(v => !v) : fileTree.setPreviewMarkdown(v => !v);
                            return (
                              <button
                                onClick={toggle}
                                className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                                  on ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-hover'
                                }`}
                              >
                                {on ? t('fileBrowser.exitPreview') : t('common.preview')}
                              </button>
                            );
                          })()}
                          {/* Register this SKILL.md in the skills registry (skills.json) — the
                              markdown analogue of the HTML button below. Only for files literally
                              named SKILL.md, since parseSkillMd derives the `/slash` trigger from
                              the parent directory. Same relative → absolute step as HTML. */}
                          {fileTree.fileContent?.type === 'text' && isSkillFile(fileTree.selectedPath || '') && (() => {
                            const sp = fileTree.selectedPath || '';
                            const abs = sp.startsWith('/') ? sp : cwd ? `${cwd.replace(/\/$/, '')}/${sp}` : sp;
                            return (
                              <button
                                onClick={() => addSkill(abs)}
                                className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover flex items-center"
                                title={t('skills.addTooltip')}
                              >
                                <BookmarkPlus className="w-3.5 h-3.5" />
                              </button>
                            );
                          })()}
                          {/* Add this HTML to the global HTML-apps registry (html.json), and
                              open it in a Console bubble. Both shown for HTML in BOTH preview and
                              non-preview mode. selectedPath is project-root-relative → absolutize
                              (registry stores absolute paths; the bubble is projectCwd-independent). */}
                          {fileTree.fileContent?.type === 'text' && isHtmlFile(fileTree.selectedPath) && (() => {
                            const sp = fileTree.selectedPath || '';
                            const abs = sp.startsWith('/') ? sp : cwd ? `${cwd.replace(/\/$/, '')}/${sp}` : sp;
                            return (
                              <>
                                <button
                                  onClick={() => addHtmlApp(abs)}
                                  className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover flex items-center"
                                  title={t('htmlApps.addTooltip')}
                                >
                                  <BookmarkPlus className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => window.dispatchEvent(new CustomEvent('console-open-browser', { detail: { url: abs } }))}
                                  className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover flex items-center"
                                  title={t('common.openInConsole')}
                                >
                                  <SquareTerminal className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => {
                                    const appUrl = toLocalAppUrl(abs);
                                    window.open(toExternalBrowserAppUrl(appUrl, window.location.origin), '_blank');
                                  }}
                                  className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover flex items-center"
                                  title={t('browser.openInNewWindow')}
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>
                              </>
                            );
                          })()}
                          {fileTree.fileContent?.type === 'text' && !((fileTree.previewMarkdown && (isMarkdownFile(fileTree.selectedPath) || isJsonFile(fileTree.selectedPath) || isCsvFile(fileTree.selectedPath))) || (fileTree.previewHtml && isHtmlFile(fileTree.selectedPath))) && (
                            <button
                              onClick={fileTree.handleToggleBlame}
                              disabled={fileTree.isLoadingBlame}
                              className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                                fileTree.showBlame
                                  ? 'bg-brand text-white'
                                  : 'text-muted-foreground hover:bg-hover'
                              } disabled:opacity-50`}
                              title={t('fileBrowser.viewBlame')}
                            >
                              {fileTree.isLoadingBlame ? (
                                <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                              ) : (
                                'Blame'
                              )}
                            </button>
                          )}
                          {/* Edit — semi-stable (hidden only in md-preview submode), so it sits
                              left of the always-present Copy / Code Map right-edge anchors. */}
                          {fileTree.fileContent?.type === 'text' && !((fileTree.previewMarkdown && (isMarkdownFile(fileTree.selectedPath) || isJsonFile(fileTree.selectedPath) || isCsvFile(fileTree.selectedPath))) || (fileTree.previewHtml && isHtmlFile(fileTree.selectedPath))) && (
                            <button
                              onClick={() => fileTree.setShowEditor(true)}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                              title={t('fileBrowser.editFile')}
                            >
                              {t('common.edit')}
                            </button>
                          )}
                          {/* Copy file content — always present; anchored at the right edge next to Code Map. */}
                          {fileTree.fileContent?.type === 'text' && fileTree.fileContent.content && (
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(fileTree.fileContent!.content!);
                                toast(t('toast.copiedFileContent'));
                              }}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                              title={t('fileBrowser.copyFileContent')}
                            >
                              {t('common.copy')}
                            </button>
                          )}
                          {/* Code Map view — peers with Edit / Blame as a
                              third reading mode. Click to flip the right
                              panel into BlockViewer's decomposed view; the
                              BlockViewer header itself has the reverse
                              "Code" button to come back. We don't render
                              an "active" state here because this button is
                              physically gone when Code Map mode is on.
                              Hidden for markdown — code-structure map is
                              meaningless for prose. */}
                          {fileTree.fileContent?.type === 'text' && !isMarkdownFile(fileTree.selectedPath) && !isHtmlFile(fileTree.selectedPath) && !isJsonFile(fileTree.selectedPath) && !isCsvFile(fileTree.selectedPath) && (
                            <button
                              onClick={() => setEditorMode('map')}
                              className="px-1.5 py-0.5 text-xs rounded transition-colors text-muted-foreground hover:bg-hover"
                              title={t('blockViewer.viewerToggle.toBlock')}
                            >
                              {t('common.codeMap')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {fileTree.isLoadingContent ? (
                      <div className="h-full flex items-center justify-center">
                        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                      </div>
                    ) : fileTree.fileContent ? (
                      fileTree.fileContent.type === 'text' && typeof fileTree.fileContent.content === 'string' ? (
                        // Diff mode wins over every other viewer projection —
                        // it is an explicit (or auto-applied) mode, not a submode.
                        treeDiffActive ? (
                          treeDiff.isLoadingDiff && !treeDiff.diff ? (
                            <div className="h-full flex items-center justify-center">
                              <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                            </div>
                          ) : treeDiff.diff ? (
                            treeDiffViewMode === 'unified' ? (
                              <DiffUnifiedView
                                oldContent={treeDiff.diff.oldContent}
                                newContent={treeDiff.diff.newContent}
                                filePath={treeDiff.diff.filePath}
                                cwd={cwd}
                                enableComments={true}
                                compact={treeDiffDensity === 'compact'}
                                onContentSearch={handleDiffContentSearch}
                                onTokenHover={(line, column, rect) => runLSPTokenHover(treeDiff.diff?.filePath, true, line, column, rect)}
                                onTokenHoverLeave={lspHover.onTokenMouseLeave}
                                onTokenHoverCancel={lspHover.clearHover}
                              />
                            ) : (
                              <DiffView
                                oldContent={treeDiff.diff.oldContent}
                                newContent={treeDiff.diff.newContent}
                                filePath={treeDiff.diff.filePath}
                                isNew={treeDiff.diff.isNew}
                                isDeleted={treeDiff.diff.isDeleted}
                                cwd={cwd}
                                enableComments={true}
                                compact={treeDiffDensity === 'compact'}
                                onContentSearch={handleDiffContentSearch}
                                onTokenHover={(line, column, rect) => runLSPTokenHover(treeDiff.diff?.filePath, true, line, column, rect)}
                                onTokenHoverLeave={lspHover.onTokenMouseLeave}
                                onTokenHoverCancel={lspHover.clearHover}
                              />
                            )
                          ) : (
                            <div className="h-full flex items-center justify-center text-muted-foreground">
                              <div className="text-center">
                                <p>{t('fileBrowser.diffLoadFailed')}</p>
                                <button
                                  onClick={treeDiff.toggleDiff}
                                  className="mt-2 text-brand hover:underline text-sm"
                                >
                                  {t('fileBrowser.exitDiff')}
                                </button>
                              </div>
                            </div>
                          )
                        ) : fileTree.showBlame && fileTree.blameError ? (
                          <div className="h-full flex items-center justify-center text-muted-foreground">
                            <div className="text-center">
                              <p className="text-red-11">{fileTree.blameError}</p>
                              <button
                                onClick={() => fileTree.setShowBlame(false)}
                                className="mt-2 text-brand hover:underline text-sm"
                              >
                                {t('fileBrowser.backToPreview')}
                              </button>
                            </div>
                          </div>
                        ) : fileTree.showBlame && fileTree.blameLines.length === 0 && fileTree.isLoadingBlame ? (
                          <div className="h-full flex items-center justify-center">
                            <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
                          </div>
                        ) : (fileTree.previewMarkdown && isJsonFile(fileTree.selectedPath) && !fileTree.showBlame) ? (
                          // In-place JSON preview — same toggle UX as markdown/html.
                          // Reuses the tool-list human-readable renderer, but with the
                          // theme-aware palette so it follows light/dark (bg + tokens).
                          <div className="h-full flex flex-col bg-background text-foreground">
                            <JsonSearchBar search={jsonSearch} />
                            <div className="flex-1 overflow-auto px-6 py-4">
                              <pre ref={jsonPreRef} className="whitespace-pre-wrap break-words font-mono" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
                                <JsonCollapseContext.Provider value={jsonCollapse}>
                                  {jsonPreviewFormatted}
                                </JsonCollapseContext.Provider>
                              </pre>
                            </div>
                          </div>
                        ) : (fileTree.previewMarkdown && isCsvFile(fileTree.selectedPath) && !fileTree.showBlame) ? (
                          // In-place CSV/TSV table — same toggle UX as markdown/json;
                          // turning the preview off falls through to CodeViewer, which
                          // is the raw delimited source.
                          <CsvTableView
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            className="h-full"
                          />
                        ) : (fileTree.previewMarkdown && isMarkdownFile(fileTree.selectedPath) && !fileTree.showBlame) ? (
                          // In-place markdown preview replaces CodeViewer when the global
                          // toggle is on. `embedded` drops the inner header (host toolbar
                          // owns filePath + ShareReviewToggle + the toggle).
                          <div className="h-full flex flex-col">
                            <InteractiveMarkdownPreview
                              content={fileTree.fileContent.content}
                              filePath={fileTree.selectedPath}
                              cwd={cwd}
                              embedded
                              onLocalMdLink={handleOpenMarkdownLink}
                              scrollToAnchor={mdLinkAnchor}
                            />
                          </div>
                        ) : (fileTree.previewHtml && isHtmlFile(fileTree.selectedPath) && !fileTree.showBlame) ? (
                          // In-place HTML preview — only when the user explicitly turned
                          // on the HTML Preview toggle (previewHtml, default off). That
                          // click is the trust gesture, so the preview gets the bash SDK.
                          <HtmlAppFrame
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            cwd={cwd}
                            onContentSearch={(query) => {
                              setActiveTab('search');
                              contentSearch.setContentSearchQuery(query);
                              contentSearch.performContentSearch(query);
                            }}
                          />
                        ) : (
                          <CodeViewer
                            ref={editorHandleRef}
                            content={fileTree.fileContent.content}
                            filePath={fileTree.selectedPath}
                            cwd={cwd}
                            enableComments={true}
                            scrollToLine={editorReturnLine ?? fileTree.targetLineNumber}
                            scrollToLineAlign={editorReturnLine != null ? 'start' : fileTree.targetScrollAlign}
                            onScrollToLineComplete={() => {
                              setEditorReturnLine(null);
                              fileTree.setTargetLineNumber(null);
                            }}
                            highlightKeyword={activeTab === 'search' ? contentSearch.contentSearchQuery : null}
                            visibleLineRef={visibleLineRef}
                            viStateRef={viStateRef}
                            initialCursorLine={fileTree.initialCursorLine}
                            initialCursorCol={fileTree.initialCursorCol}
                            onInitialCursorSet={() => {
                              fileTree.setInitialCursorLine(null);
                              fileTree.setInitialCursorCol(null);
                            }}
                            onCmdClick={isLSPSupported ? handleLSPCmdClick : undefined}
                            onTokenHover={isLSPSupported ? handleLSPTokenHover : undefined}
                            onTokenHoverLeave={isLSPSupported ? lspHover.onTokenMouseLeave : undefined}
                            onTokenHoverCancel={isLSPSupported ? lspHover.clearHover : undefined}
                            blameLines={fileTree.showBlame && fileTree.blameLines.length > 0 ? fileTree.blameLines : undefined}
                            inlineBlameLines={fileTree.blameLines.length > 0 ? fileTree.blameLines : undefined}
                            onSelectCommit={fileTree.setBlameSelectedCommit}
                            editable={fileTree.showEditor}
                            initialMtime={fileTree.fileContent.mtime}
                            onEditorClose={(currentLine) => {
                              fileTree.setShowEditor(false);
                              setEditorReturnLine(currentLine);
                            }}
                            onSaved={() => {
                              const line = visibleLineRef.current ?? 1;
                              fileTree.loadFileContent(fileTree.selectedPath!);
                              fileTree.setShowEditor(false);
                              setEditorReturnLine(line);
                            }}
                            onEditorStateChange={setEditorState}
                            viMode={true}
                            onContentMutate={handleViContentMutate}
                            onEnterInsertMode={handleViEnterInsert}
                            onViSave={handleViSave}
                            onContentSearch={(query) => {
                              setActiveTab('search');
                              contentSearch.setContentSearchQuery(query);
                              contentSearch.performContentSearch(query);
                            }}
                          />
                        )
                      ) : fileTree.fileContent.type === 'image' && fileTree.selectedPath ? (
                        <FileImagePreview
                          cwd={cwd}
                          path={fileTree.selectedPath}
                          refreshKey={fileTree.fileContent.mtime}
                          alt={fileTree.selectedPath}
                        />
                      ) : fileTree.fileContent.type === 'pdf' && fileTree.selectedPath ? (
                        // Themed, virtualized PDF preview (pdf.js). Follows the app
                        // theme and only renders visible pages for smooth scrolling.
                        // Bytes stream from /api/files/read; `refreshKey` (mtime)
                        // reloads on file change and busts the byte cache.
                        <FilePdfPreview
                          cwd={cwd}
                          path={fileTree.selectedPath}
                          refreshKey={fileTree.fileContent.mtime}
                        />
                      ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground">
                          <div className="text-center">
                            <svg className="w-16 h-16 mx-auto text-foreground-faint mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                            </svg>
                            <p>{fileTree.fileContent.message || t('fileBrowser.cannotPreview')}</p>
                          </div>
                        </div>
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground">
                        {t('fileBrowser.selectFileToPreview')}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-muted-foreground">
                  <div className="text-center">
                    <svg className="w-16 h-16 mx-auto text-foreground-faint mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <p>{t('fileBrowser.selectFileToPreview')}</p>
                  </div>
                </div>
              )
            )}

            {/* Status - Right Panel — diff pane lives in its own
                component so `diffViewerMode` state is encapsulated
                and FileBrowserModal isn't responsible for the 250+
                lines of toolbar / DiffView / BlockDiffViewer / modal
                JSX. */}
            {activeTab === 'status' && (
              gitStatus.statusSelectedFile && gitStatus.statusDiff ? (
                <StatusDiffPane
                  cwd={cwd}
                  selected={gitStatus.statusSelectedFile}
                  diff={gitStatus.statusDiff}
                  showMarkdownPreview={gitStatus.showStatusDiffPreview}
                  setShowMarkdownPreview={gitStatus.setShowStatusDiffPreview}
                  changedFiles={changedFilePathSet}
                  fileGitStatusMap={fileGitStatusMap}
                  onContentSearch={(query) => {
                    setActiveTab('search');
                    contentSearch.setContentSearchQuery(query);
                    contentSearch.performContentSearch(query);
                  }}
                  locateInTree={locateInTree}
                  jsonPreview={jsonPreview}
                  setJsonPreview={setJsonPreview}
                  jsonPreviewSearch={jsonPreviewSearch}
                  jsonPreviewPreRef={jsonPreviewPreRef}
                  onTokenHover={(line, column, rect) => runLSPTokenHover(gitStatus.statusDiff?.filePath, true, line, column, rect)}
                  onTokenHoverLeave={lspHover.onTokenMouseLeave}
                  onTokenHoverCancel={lspHover.clearHover}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-foreground-subtle">
                  <span>{t('fileBrowser.selectFileToViewDiff')}</span>
                </div>
              )
            )}

            {/* History - Right Panel */}
            {activeTab === 'history' && !gitHistory.historyError && (
              gitHistory.compareMode ? (
                /* Compare mode: right panel shows diff only */
                gitHistory.isLoadingCompareDiff ? (
                  <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                    {t('fileBrowser.loadingDiffContent')}
                  </div>
                ) : gitHistory.compareFileDiff ? (
                  <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Images render as before/after previews, so the diff
                        toggles have nothing to act on — hide them. */}
                    {!isImageFile(gitHistory.compareFileDiff.filePath) && (
                      <div className="flex items-center justify-end gap-2 px-3 py-1.5 border-b border-border flex-shrink-0">
                        <DiffDensityToggle value={compareDensity} onChange={setCompareDensity} />
                        <DiffViewModeToggle value={compareViewMode} onChange={setCompareViewMode} />
                      </div>
                    )}
                    <div className="flex-1 overflow-hidden">
                      {isImageFile(gitHistory.compareFileDiff.filePath) ? (
                        <GitImageDiffView
                          cwd={cwd}
                          filePath={gitHistory.compareFileDiff.filePath}
                          oldRev={
                            gitHistory.compareFileDiff.oldRev ??
                            (gitHistory.compareFileDiff.isNew ? null : gitHistory.compareBaseBranch)
                          }
                          newRev={
                            gitHistory.compareFileDiff.newRev ??
                            (gitHistory.compareFileDiff.isDeleted ? null : 'HEAD')
                          }
                        />
                      ) : compareViewMode === 'unified' ? (
                        <DiffUnifiedView
                          oldContent={gitHistory.compareFileDiff.oldContent}
                          newContent={gitHistory.compareFileDiff.newContent}
                          filePath={gitHistory.compareFileDiff.filePath}
                          cwd={cwd}
                          enableComments={true}
                          compact={compareDensity === 'compact'}
                          onPreview={
                            !gitHistory.compareFileDiff.isDeleted && gitHistory.compareFileDiff.filePath.endsWith('.json')
                              ? () => setJsonPreview({ content: gitHistory.compareFileDiff!.newContent, filePath: gitHistory.compareFileDiff!.filePath })
                              : undefined
                          }
                          previewLabel={t('common.readable')}
                          onContentSearch={(query) => {
                            setActiveTab('search');
                            contentSearch.setContentSearchQuery(query);
                            contentSearch.performContentSearch(query);
                          }}
                        />
                      ) : (
                        <DiffView
                          oldContent={gitHistory.compareFileDiff.oldContent}
                          newContent={gitHistory.compareFileDiff.newContent}
                          filePath={gitHistory.compareFileDiff.filePath}
                          isNew={gitHistory.compareFileDiff.isNew}
                          isDeleted={gitHistory.compareFileDiff.isDeleted}
                          cwd={cwd}
                          enableComments={true}
                          compact={compareDensity === 'compact'}
                          onPreview={
                            !gitHistory.compareFileDiff.isDeleted && gitHistory.compareFileDiff.filePath.endsWith('.json')
                              ? () => setJsonPreview({ content: gitHistory.compareFileDiff!.newContent, filePath: gitHistory.compareFileDiff!.filePath })
                              : undefined
                          }
                          previewLabel={t('common.readable')}
                          onContentSearch={(query) => {
                            setActiveTab('search');
                            contentSearch.setContentSearchQuery(query);
                            contentSearch.performContentSearch(query);
                          }}
                        />
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-foreground-subtle">
                    <span>{gitHistory.compareFiles.length > 0 ? t('fileBrowser.selectFileToViewDiff') : t('fileBrowser.clickCompareToLoad')}</span>
                  </div>
                )
              ) : gitHistory.selectedCommit ? (
                <CommitDetailPanel
                  isOpen={true}
                  onClose={() => gitHistory.setSelectedCommit(null)}
                  commit={gitHistory.selectedCommit}
                  cwd={cwd}
                  embedded={true}
                  onContentSearch={(query) => {
                    setActiveTab('search');
                    contentSearch.setContentSearchQuery(query);
                    contentSearch.performContentSearch(query);
                  }}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-foreground-subtle">
                  <span>{t('fileBrowser.selectCommitToView')}</span>
                </div>
              )
            )}
          </div>
        </div>

        {/* Quick File Open (Cmd+P) */}
        {showQuickOpen && (
          <QuickFileOpen
            files={fileTree.files}
            fileIndex={fileTree.fileIndex}
            recentFiles={fileTree.recentFilePaths}
            onSelectFile={(path) => {
              handleSelectFileWithSave(path);
              fileTree.setShouldScrollToSelected(true);
              setActiveTab('tree');
            }}
            onClose={() => setShowQuickOpen(false)}
          />
        )}
        {/* Bottom panel - search results / references, split equally when both are visible */}
        {(showSearchResults || lspReferences.visible) && (
          <div className={`flex ${lspReferences.visible && showSearchResults ? '' : 'flex-col'}`}>
            {showSearchResults && (
              <div className={lspReferences.visible ? 'flex-1 min-w-0 border-r border-border' : ''}>
                <SearchResultsPanel
                  results={contentSearch.contentSearchResults}
                  loading={contentSearch.isSearching}
                  totalMatches={contentSearch.searchStats?.totalMatches ?? 0}
                  onSelect={(path, lineNumber) => {
                    // Push current position to navigation history before jumping
                    if (fileTree.selectedPath) {
                      navHistory.push({ filePath: fileTree.selectedPath, lineNumber: visibleLineRef.current });
                    }
                    // Leave Code Map mode so CodeViewer (which owns scrollToLine)
                    // remounts and jumps to the matched line. In map mode the
                    // right panel renders BlockViewer, which ignores the target
                    // line, so the click would otherwise appear to do nothing.
                    setEditorMode('code');
                    handleSelectFileWithSave(path, lineNumber);
                  }}
                  onClose={() => setShowSearchPanel(false)}
                  scope={searchResultScope}
                  onScopeChange={setSearchResultScope}
                  selectedPath={fileTree.selectedPath}
                />
              </div>
            )}
            {lspReferences.visible && (
              <div className={showSearchResults ? 'flex-1 min-w-0' : ''}>
                <ReferencesPanel
                  references={lspReferences.references}
                  loading={lspReferences.loading}
                  onSelect={handleLSPReferenceSelect}
                  onClose={lspReferences.closeReferences}
                />
              </div>
            )}
          </div>
        )}
      </div>
      {/* Tooltips for `data-tooltip` attributes are rendered globally by
          the app-root <TooltipProvider /> — no per-modal rendering needed. */}
      {/* Delete confirmation dialog */}
      {deleteConfirm && <Portal>
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-scrim" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-card border border-border rounded-lg shadow-lv3 p-4 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-medium text-foreground mb-2">{t('fileBrowser.confirmDelete')}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t('fileBrowser.confirmDeleteMessage', { name: deleteConfirm.name }).split(/<\/?file>/g).map((part, i) =>
                i === 1 ? <span key={i} className="font-mono text-foreground">{part}</span> : part
              )}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 text-sm rounded border border-border hover:bg-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={async () => {
                  const { path, name } = deleteConfirm;
                  setDeleteConfirm(null);
                  const exit = await BrowserRuntime.runPromiseExit(
                    deleteFiles({ cwd, path })
                  );
                  if (exit._tag === 'Success') {
                    toast(t('toast.movedToTrash', { name }), 'success');
                    const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
                    fileTree.loadDirectory(parentDir);
                    fileTree.loadFileIndex();
                    if (fileTree.selectedPath === path) {
                      handleSelectFileWithSave('');
                    }
                  } else {
                    // Surface the underlying body.error
                    const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
                    const inner = failure?.cause;
                    const msg = inner instanceof Error ? inner.message : t('toast.deleteFailed');
                    toast(msg, 'error');
                  }
                }}
                className="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      </Portal>}
      {/* LSP HoverTooltip - portaled inside menuContainer, using absolute positioning */}
      {lspHover.hoverInfo && menuContainer && createPortal(
        <HoverTooltip
          ref={lspHover.setTooltipEl}
          displayString={lspHover.hoverInfo.displayString}
          documentation={lspHover.hoverInfo.documentation}
          x={lspHover.hoverInfo.x}
          y={lspHover.hoverInfo.y}
          container={menuContainer}
          onMouseEnter={lspHover.onCardMouseEnter}
          onMouseLeave={lspHover.onCardMouseLeave}
          onFindReferences={lspHoverInDiff ? undefined : () => {
            const { filePath, line, column } = lspHover.hoverInfo!;
            lspHover.clearHover();
            lspReferences.findReferences(filePath, line, column);
          }}
          onSearch={(keyword) => {
            lspHover.clearHover();
            setActiveTab('search');
            contentSearch.setContentSearchQuery(keyword);
            contentSearch.performContentSearch(keyword);
          }}
          onExplain={aiBridge ? (name) => {
            // LSP hover gives a point (line/column), not a span — the
            // signature payload carries no end line. One line number is
            // enough for the agent to find the symbol in the file.
            const { filePath, line } = lspHover.hoverInfo!;
            lspHover.clearHover();
            aiBridge.sendMessage(t('explain.symbolMessage', { name, path: filePath, lines: String(line) }));
          } : undefined}
          explainDisabled={aiBridge?.isLoading}
        />,
        menuContainer,
      )}
    </MenuContainerProvider>
  );
}

// Memoized: the Explorer panel is always mounted alongside Chat/Console, so a
// chat-tab/session switch re-renders TabManager. With stable props (cwd + the
// trigger counters, and a stabilized onClose) memo keeps that switch from
// re-rendering the entire file browser + preview subtree.
export const FileBrowserModal = React.memo(FileBrowserModalImpl);
