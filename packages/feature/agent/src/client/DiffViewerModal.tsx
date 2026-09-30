'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { useEffectQuery } from '@cockpit/effect-react';
import { Portal, blurActiveElement, ChangeClassChip, MenuContainerProvider } from '@cockpit/shared-ui';
import { classifyPath, classifyFiles, type ChangeClass } from '@cockpit/shared-utils';
import { COLUMN_HEADER_ROW } from './columnHeaderRow';
import { X, PanelLeft, Wrench, Maximize, Minimize, Layers } from 'lucide-react';
// Tech debt: DiffView / GitFileTree are generic renderers used by both
// file-browser and chat domains. Allowed by MODULES.md as transitional
// reverse import (agent → explorer is a declared supporting subdomain).
import {
  DiffView,
  DiffUnifiedView,
  DiffDensityToggle,
  DiffViewModeToggle,
  GitFileTree,
  buildGitFileTree,
  collectGitTreeDirPaths,
  ImageDiffView,
  InteractiveMarkdownPreview,
  HtmlPreviewModal,
  isMarkdownFile,
  isHtmlFile,
  formatAsHumanReadable,
  type GitFileNode,
} from '@cockpit/feature-explorer';
import {
  loadSnapshotDiffsForToolIds,
  loadSnapshotRangeDiff,
  type SnapshotDiffDto,
  type SnapshotFileDiffDto,
  type SnapshotRangeDiffDto,
} from './effect/snapshotClient';
import type { ToolCallInfo } from './types';
import { isMutatingToolName } from '../shared/toolMutation';
import { BASELINE_SHIFT_FILES, countLeadingBaselineShifts } from './baselineShift';

// Layout mirrors the Explorer "History" tab: a commit list on the left
// (one entry per tool call = one shadow-git snapshot commit), and a
// CommitDetailPanel-style right side (meta bar + GitFileTree + DiffView).
//
// Data source: shadow-git tool-call snapshots (/api/snapshots) — the REAL
// on-disk diff of each tool call, covering Bash & co. When no snapshot
// exists for the message (feature freshly enabled / history beyond
// retention), falls back to reconstructing pseudo-calls from Edit/Write
// tool parameters so the layout stays identical.

// ============================================
// Types
// ============================================

interface CallFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions?: number;
  deletions?: number;
  old_string: string;
  new_string: string;
  /** Binary or over-cap file — contents not viewable. */
  unviewable?: boolean;
  /** Binary image: rendered as before/after <img> instead of a text diff. */
  isImage?: boolean;
  /** Snapshot revisions holding the image; null = absent on that side. */
  oldRev?: string | null;
  newRev?: string | null;
  /** Changed in the same commit but NOT declared by the tool — likely another
   *  concurrent session / external process (best-effort attribution). */
  external?: boolean;
}

/** One tool call = one snapshot commit (or one legacy pseudo-call). */
interface CallEntry {
  key: string;
  shortHash?: string;
  /** Full snapshot commit hash — absent for legacy pseudo-calls. */
  hash?: string;
  /** Parent of this call's commit; null for a parentless day-root commit.
   *  The aggregate view's `base` is the FIRST call's parent, never its own
   *  hash — otherwise the first call's own changes drop out of the range. */
  parent?: string | null;
  /** Files the tool declared it would touch (empty for Bash & co.). */
  declared?: string[];
  toolName: string;
  subject: string;
  /** Full display text when the snapshot commit subject was shortened. */
  fullSubject?: string;
  /** Unix epoch seconds; absent for legacy pseudo-calls. */
  timestamp?: number;
  files: CallFile[];
  /** Reconstructed from tool parameters (fallback) — NOT a disk snapshot. */
  legacy?: boolean;
  /** Server capped the file list for this commit. */
  truncated?: boolean;
  /** Non-critical marker: EVERY file in this call is a test / docs file. */
  changeClass?: ChangeClass | null;
}

interface DiffViewerModalProps {
  toolCalls: ToolCallInfo[];
  cwd?: string;
  sessionId?: string;
  /** Dispatch that produced the source message. Required to disambiguate
   *  engines whose tool ids restart each turn (codex `item_N`); absent on
   *  reloaded messages, which key on globally-unique `call_…` ids. */
  onClose: () => void;
  /** Selected text → project-wide search. When provided, the diff's
   *  selection toolbar renders the "Search" button (comment / send-to-AI
   *  are always available once `cwd` is present). */
  onContentSearch?: (query: string) => void;
  /**
   * Whether the host is currently giving this viewer the whole area.
   *
   * The toggle is a HOST capability, not a viewer one: what "full" means is a
   * fact about the surrounding layout, which this component deliberately knows
   * nothing about (it renders full-bleed into whatever box it is handed). So
   * the button appears only when a host passes `onToggleFullscreen` — the
   * Portal wrapper below is already full-screen and passes neither, which is
   * how it avoids shipping a control that would have nothing to do.
   */
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

// ============================================
// Data adapters
// ============================================

/**
 * One snapshot file diff → the viewer's CallFile shape. Shared by the
 * per-call and aggregate views so both render through the identical pipeline.
 *
 * `declared` null disables external-change attribution (see the aggregate
 * view: a union of declared files is only meaningful when every call in the
 * range declared its targets).
 */
function toCallFile(f: SnapshotFileDiffDto, declared: Set<string> | null): CallFile {
  return {
    path: f.path,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    old_string: f.oldContent ?? '',
    new_string: f.newContent ?? '',
    // An image is "unviewable" as TEXT but perfectly viewable as an image,
    // so it must not fall into the not-viewable branch.
    unviewable: !f.isImage && (f.binary || (f.oldContent === null && f.newContent === null)),
    isImage: f.isImage,
    oldRev: f.oldRev,
    newRev: f.newRev,
    // Attribution is best-effort: only meaningful when the tool declared
    // target files (Edit/Write); Bash declares nothing → no marking.
    external: declared !== null && declared.size > 0 && !declared.has(f.path),
  };
}

/** Snapshot commits → call entries (one per commit, files carry real diffs). */
function callsFromSnapshots(diffs: SnapshotDiffDto[]): CallEntry[] {
  return diffs.map((d) => {
    const declared = new Set(d.commit.toolFiles);
    return {
      // Key by tool_use id, not the commit hash: it's stable across refetches
      // AND identical to the legacy fallback's key, so a snapshot⇄legacy flip
      // never invalidates the user's selection. (listByToolIds only returns
      // commits that HAVE a toolId; hash is a defensive fallback.)
      key: d.commit.toolId ?? d.commit.hash,
      shortHash: d.commit.hash.slice(0, 7),
      hash: d.commit.hash,
      parent: d.commit.parent,
      declared: d.commit.toolFiles,
      toolName: d.commit.toolName ?? 'tool',
      subject: d.commit.subject,
      timestamp: d.commit.timestamp,
      truncated: d.truncated === true,
      changeClass: classifyFiles(d.files.map((f) => f.path)),
      files: d.files.map((f) => toCallFile(f, declared)),
    };
  });
}

/** Image bytes at a snapshot revision — the shadow repo, not the project's. */
const snapshotBlobUrl = (cwd: string, rev: string, filePath: string) =>
  `/api/snapshots/blob?cwd=${encodeURIComponent(cwd)}&rev=${encodeURIComponent(rev)}&file=${encodeURIComponent(filePath)}`;

function toolCallDetail(toolCall: ToolCallInfo | undefined): string | undefined {
  if (!toolCall) return undefined;
  const input = toolCall.input;
  if (typeof input.description === 'string' && input.description) return input.description;
  if (typeof input.command === 'string' && input.command) return input.command;
  if (typeof input.prompt === 'string' && input.prompt) return input.prompt;
  if (typeof input.file_path === 'string' && input.file_path) return input.file_path;
  if (typeof input.notebook_path === 'string' && input.notebook_path) return input.notebook_path;
  return undefined;
}

function hydrateFullSubjects(calls: CallEntry[], toolCalls: ToolCallInfo[]): CallEntry[] {
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]));
  return calls.map((call) => {
    const detail = toolCallDetail(toolCallById.get(call.key));
    if (!detail) return call;
    return { ...call, fullSubject: `[${call.toolName}] ${detail}` };
  });
}

function callSubject(call: CallEntry): string {
  return call.fullSubject || call.subject;
}

/** Keep enough tool input to identify a call without letting a pasted script
 *  take over the timeline or the diff toolbar. The complete value remains in
 *  the tooltip. */
function callSubjectPreview(call: CallEntry, maxChars: number, maxLines: number): string {
  const subject = callSubject(call);
  const lines = subject.split('\n');
  const lineLimited = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : subject;
  const preview = lineLimited.length > maxChars ? lineLimited.slice(0, maxChars) : lineLimited;
  const truncated = lines.length > maxLines || lineLimited.length > maxChars;
  return truncated ? `${preview.trimEnd()}…` : preview;
}

function toRelativePath(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return filePath;
}

/** Legacy fallback: one pseudo-call per Edit/Write, diff rebuilt from params. */
function callsFromToolParams(toolCalls: ToolCallInfo[], cwd?: string): CallEntry[] {
  const calls: CallEntry[] = [];
  for (const tc of toolCalls) {
    if (tc.name === 'Edit') {
      const input = tc.input as { file_path?: string; old_string?: string; new_string?: string };
      if (input.file_path && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        const path = toRelativePath(input.file_path, cwd);
        calls.push({
          key: tc.id,
          toolName: 'Edit',
          subject: `[Edit] ${path}`,
          legacy: true,
          changeClass: classifyPath(path),
          files: [{ path, status: 'modified', old_string: input.old_string, new_string: input.new_string }],
        });
      }
    } else if (tc.name === 'Write') {
      const input = tc.input as { file_path?: string; content?: string };
      if (input.file_path && typeof input.content === 'string') {
        const path = toRelativePath(input.file_path, cwd);
        calls.push({
          key: tc.id,
          toolName: 'Write',
          subject: `[Write] ${path}`,
          legacy: true,
          changeClass: classifyPath(path),
          files: [{ path, status: 'added', old_string: '', new_string: input.content }],
        });
      }
    }
  }
  return calls;
}

/**
 * Resolve the entries a message would actually display: prefer the real
 * shadow-git snapshots, fall back to Edit/Write parameter reconstruction.
 * Shared with MessageBubble's render-time emptiness check (called with empty
 * diffs) so the FileDiff icon and the modal agree on what counts as empty.
 */
export function resolveDiffCalls(
  diffs: SnapshotDiffDto[],
  toolCalls: ToolCallInfo[],
  cwd?: string,
): CallEntry[] {
  const fromSnapshots = callsFromSnapshots(diffs);
  const resolved = fromSnapshots.length > 0 ? fromSnapshots : callsFromToolParams(toolCalls, cwd);
  return hydrateFullSubjects(resolved, toolCalls);
}

/**
 * Sum additions/deletions across a call's files. Returns null when NO file
 * carries line stats — i.e. legacy parameter-reconstructed calls, where we
 * show the file count only rather than a misleading +0 -0.
 */
function fileLineStats(files: CallFile[]): { additions: number; deletions: number } | null {
  let hasStats = false;
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (f.additions !== undefined || f.deletions !== undefined) hasStats = true;
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return hasStats ? { additions, deletions } : null;
}

function callLineStats(call: CallEntry): { additions: number; deletions: number } | null {
  return fileLineStats(call.files);
}

/** Compact "+X -Y" line-stat badge (green adds / red dels). */
function LineStatsBadge({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="flex items-center gap-1 font-mono">
      <span className="text-green-11">+{additions}</span>
      <span className="text-red-11">-{deletions}</span>
    </span>
  );
}

/** e.g. "07-09 01:24" (year prefixed when not this year) — mirrors history tab. */
function formatCallTime(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const base = `${mm}-${dd} ${hh}:${mi}`;
  return date.getFullYear() === now.getFullYear() ? base : `${date.getFullYear()}-${base}`;
}

// ============================================
// DiffViewerModal
// ============================================

export function FileDiffViewer({ toolCalls, cwd, sessionId, onClose, onContentSearch, fullscreen, onToggleFullscreen }: DiffViewerModalProps) {
  const { t } = useTranslation();

  // Portal target for DiffView's floating selection toolbar (comment /
  // send-to-AI / search). DiffView reads it via `useMenuContainer()`, so
  // without our own provider the hook resolves to null and the toolbar
  // never mounts. Nothing above this viewer provides one: it renders as its
  // own column in the agent panel, or inside DiffViewerModal's Portal.
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const [menuContainer, setMenuContainer] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setMenuContainer(menuContainerRef.current);
  }, []);

  // Real on-disk diffs from the shadow-git snapshots, keyed by this message's
  // tool_use ids. cwd missing → skip straight to the legacy fallback.
  const toolIds = useMemo(() => toolCalls.map((tc) => tc.id).filter(Boolean), [toolCalls]);
  const toolIdsKey = toolIds.join(',');
  // Snapshots are written fire-and-forget after each tool_result — a modal
  // opened right after a tool finished can observe a PARTIALLY landed set.
  // When commits are missing for tools that almost certainly changed files
  // (Edit/Write family), refetch up to twice before settling.
  const [retryTick, setRetryTick] = useState(0);
  // A streaming message adds tool ids over time; each new one needs its own
  // retry budget, or its late-landing snapshot is never picked up.
  useEffect(() => { setRetryTick(0); }, [toolIdsKey]);
  const snapshotsQ = useEffectQuery(
    cwd && toolIds.length > 0
      ? loadSnapshotDiffsForToolIds(cwd, toolIds, sessionId)
      : Effect.succeed([] as SnapshotDiffDto[]),
    [cwd, sessionId, toolIdsKey, retryTick],
  );
  const snapshotBackedIds = useMemo(
    () =>
      toolCalls
        .filter((tc) => isMutatingToolName(tc.name))
        .map((tc) => tc.id),
    [toolCalls],
  );
  useEffect(() => {
    if (snapshotsQ.status !== 'success' || retryTick >= 2) return;
    const landed = new Set(snapshotsQ.data.map((d) => d.commit.toolId));
    if (snapshotBackedIds.some((id) => !landed.has(id))) {
      const t = setTimeout(() => setRetryTick((v) => v + 1), 2000);
      return () => clearTimeout(t);
    }
  }, [snapshotsQ, retryTick, snapshotBackedIds]);

  // Keep the last non-empty result while a refetch is in flight — the retry
  // must not flash the whole modal back to the loading state.
  const lastGoodRef = useRef<CallEntry[]>([]);
  const loading = snapshotsQ.status === 'loading' && lastGoodRef.current.length === 0;
  const calls = useMemo<CallEntry[]>(() => {
    if (snapshotsQ.status === 'success') {
      const resolved = resolveDiffCalls(snapshotsQ.data, toolCalls, cwd);
      if (resolved.length > 0) lastGoodRef.current = resolved;
      return resolved;
    }
    if (snapshotsQ.status === 'loading' && lastGoodRef.current.length > 0) {
      return lastGoodRef.current;
    }
    if (snapshotsQ.status === 'loading') return [];
    // Query failed → legacy parameter-based reconstruction.
    return callsFromToolParams(toolCalls, cwd);
  }, [snapshotsQ, toolCalls, cwd]);

  // 汇总 — one net diff across every call instead of one call at a time.
  // Pane-local like the density / view-mode toggles; opening the viewer always
  // starts per-call, because "what did THIS call do" is the common question.
  const [aggregate, setAggregate] = useState(false);
  // Escape hatch for the file-count heuristic below: a genuine wide codemod
  // looks exactly like a branch switch by size alone, so the user can always
  // pull the skipped calls back in. One switch for both views, so the call
  // list and the aggregate never disagree about what the turn consists of.
  const [includeBaselineShifts, setIncludeBaselineShifts] = useState(false);

  // Snapshot-backed calls, oldest first — the only ones a range can span
  // (legacy pseudo-calls are rebuilt from tool parameters and have no commit).
  const hashedCalls = useMemo(() => calls.filter((c) => c.hash), [calls]);
  // base..head for the aggregate view. `base` is the OLDEST call's PARENT so
  // that call's own changes are inside the range; null means the range starts
  // at the empty tree (parentless day-root commit).
  // Leading baseline shifts, counted regardless of whether they are currently
  // being skipped — the meta bar needs the number either way to offer the undo.
  const leadingBaselineShifts = useMemo(
    () => countLeadingBaselineShifts(hashedCalls),
    [hashedCalls],
  );
  // The calls the aggregate actually spans.
  const spannedCalls = useMemo(
    () => (includeBaselineShifts ? hashedCalls : hashedCalls.slice(leadingBaselineShifts)),
    [hashedCalls, includeBaselineShifts, leadingBaselineShifts],
  );
  // The per-call list hides the same leading shifts: opening the viewer on a
  // 200-file branch switch buries the calls the user came to look at.
  const listedCalls = useMemo(() => {
    if (includeBaselineShifts || leadingBaselineShifts === 0) return calls;
    const hidden = new Set(hashedCalls.slice(0, leadingBaselineShifts).map((c) => c.key));
    return calls.filter((c) => !hidden.has(c.key));
  }, [calls, hashedCalls, includeBaselineShifts, leadingBaselineShifts]);
  // base..head for the aggregate view. `base` is the OLDEST spanned call's
  // PARENT so that call's own changes are inside the range; null means the
  // range starts at the empty tree (parentless day-root commit).
  //
  // One spanned call is enough once a shift was skipped — "everything except
  // the branch switch" is a real answer even when it is a single call.
  const range = useMemo(() => {
    if (spannedCalls.length === 0) return null;
    if (spannedCalls.length < 2 && leadingBaselineShifts === 0) return null;
    return {
      base: spannedCalls[0].parent ?? null,
      head: spannedCalls[spannedCalls.length - 1].hash as string,
    };
  }, [spannedCalls, leadingBaselineShifts]);
  // Shown from two calls up (aggregating a single call would just restate it),
  // disabled when those calls carry no snapshots to diff between.
  const canShowAggregate = Boolean(cwd) && calls.length >= 2;
  const aggregateDisabled = range === null;
  // A shrinking call list (message re-render / refetch) can invalidate the
  // range while the aggregate view is open — fall back rather than strand it.
  useEffect(() => {
    if (aggregate && !range) setAggregate(false);
  }, [aggregate, range]);

  const rangeQ = useEffectQuery(
    aggregate && cwd && range
      ? loadSnapshotRangeDiff(cwd, range.base, range.head)
      : Effect.succeed(null as SnapshotRangeDiffDto | null),
    [aggregate, cwd, range?.base ?? '', range?.head ?? ''],
  );
  // Attribution across a range only holds when EVERY call declared its
  // targets: one Bash (which declares nothing) makes the union meaningless
  // and would mislabel that Bash's own writes as someone else's.
  const declaredUnion = useMemo(() => {
    if (spannedCalls.length === 0) return null;
    if (spannedCalls.some((c) => !c.declared || c.declared.length === 0)) return null;
    return new Set(spannedCalls.flatMap((c) => c.declared as string[]));
  }, [spannedCalls]);
  const aggregateFiles = useMemo<CallFile[]>(() => {
    if (rangeQ.status !== 'success' || !rangeQ.data) return [];
    return rangeQ.data.files.map((f) => toCallFile(f, declaredUnion));
  }, [rangeQ, declaredUnion]);
  const aggregateTruncated = rangeQ.status === 'success' && rangeQ.data?.truncated === true;
  const aggregateLoading = aggregate && rangeQ.status === 'loading';
  const aggregateFailed = aggregate && rangeQ.status === 'error';

  const [selectedCallKey, setSelectedCallKey] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  // Collapsible left side (commit list + file tree) — defaults open on
  // desktop, collapsed on narrow screens.
  const [showLeft, setShowLeft] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 768,
  );
  // 精简/全文 — pane-local, defaults to compact (same as StatusDiffPane).
  const [density, setDensity] = useState<'compact' | 'full'>('compact');
  // split/unified — pane-local, defaults to unified (same non-persisted policy
  // as density). Both views support compact / preview / comments / search.
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('unified');
  // Rendered previews of the SNAPSHOT's post-change content (not the current
  // disk state — that's the point). Same overlay pattern as StatusDiffPane.
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  // HTML preview overlay. Content here is AI-produced (this viewer only shows
  // mutating tool-call snapshots), so the preview is TRUSTED (bash SDK enabled).
  const [showHtmlPreview, setShowHtmlPreview] = useState(false);
  const [jsonPreview, setJsonPreview] = useState<{ content: string; filePath: string } | null>(null);

  const selectedCall = useMemo(
    () => calls.find((c) => c.key === selectedCallKey) ?? null,
    [calls, selectedCallKey],
  );
  // Hold the last resolved selection. A refetch that momentarily can't resolve
  // the selected key (transient empty / mid-write) must NOT unmount the right
  // pane — that destroys the DiffView scroll container and loses scrollTop.
  // We render `displayCall` so the pane stays mounted with the last-good call.
  const lastSelectedCallRef = useRef<CallEntry | null>(null);
  useEffect(() => {
    if (selectedCall) lastSelectedCallRef.current = selectedCall;
  }, [selectedCall]);
  const displayCall = selectedCall ?? lastSelectedCallRef.current;
  // What the tree and the diff pane render: one call's files, or the whole
  // range's net change. Everything downstream is mode-agnostic from here.
  const activeFiles = useMemo<CallFile[]>(
    () => (aggregate ? aggregateFiles : (displayCall?.files ?? [])),
    [aggregate, aggregateFiles, displayCall],
  );
  const tree = useMemo<GitFileNode<CallFile>[]>(
    () => buildGitFileTree(activeFiles),
    [activeFiles],
  );
  const selectedFile = useMemo(
    () => activeFiles.find((f) => f.path === selectedFilePath) ?? null,
    [activeFiles, selectedFilePath],
  );
  const activeStats = useMemo(() => fileLineStats(activeFiles), [activeFiles]);

  const selectCall = useCallback((call: CallEntry) => {
    setSelectedCallKey(call.key);
    setSelectedFilePath(call.files[0]?.path ?? null);
    setExpandedPaths(new Set(collectGitTreeDirPaths(buildGitFileTree(call.files))));
  }, []);

  // Initial selection ONLY: pick the first call once the (async) list first
  // arrives. Deliberately does NOT re-pick when the selected key isn't found —
  // that used to yank the user off their commit (and reset file + scroll) every
  // time the list refreshed while the AI kept editing. With stable toolId keys
  // the selection survives refetches; if it's ever truly gone the pane falls
  // back to the last-good render (displayCall) instead of jumping to the top.
  useEffect(() => {
    if (listedCalls.length > 0 && selectedCallKey == null) {
      selectCall(listedCalls[0]);
    }
  }, [listedCalls, selectedCallKey, selectCall]);

  // The one exception to "never re-pick": the selected call got HIDDEN — the
  // user switched shifts back off, or a refetch brought in later calls that
  // turned the first one into a leading shift. It is still in `calls`, so the
  // pane would keep showing a call the list no longer has.
  useEffect(() => {
    if (selectedCallKey == null || listedCalls.length === 0) return;
    if (listedCalls.some((c) => c.key === selectedCallKey)) return;
    if (!calls.some((c) => c.key === selectedCallKey)) return;
    selectCall(listedCalls[0]);
  }, [calls, listedCalls, selectedCallKey, selectCall]);

  // A mode switch swaps the whole file set. Deliberately only re-selects when
  // the current path is GONE: a file edited in this call is usually present in
  // the aggregate too, and staying on it makes 汇总 read as "same file, whole
  // turn" rather than a jump back to the top of the list.
  useEffect(() => {
    if (activeFiles.length === 0) return;
    if (selectedFilePath && activeFiles.some((f) => f.path === selectedFilePath)) return;
    setSelectedFilePath(activeFiles[0].path);
  }, [activeFiles, selectedFilePath]);

  // Entering 汇总 expands the whole tree (same as the Explorer compare mode):
  // the range spans more directories than any single call, so a collapsed
  // tree would hide most of what the user switched over to see.
  useEffect(() => {
    if (!aggregate || aggregateFiles.length === 0) return;
    setExpandedPaths(new Set(collectGitTreeDirPaths(buildGitFileTree(aggregateFiles))));
  }, [aggregate, aggregateFiles]);

  // ESC closes the innermost layer first: preview overlay → whole modal.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showMarkdownPreview) {
        setShowMarkdownPreview(false);
        return;
      }
      if (showHtmlPreview) {
        setShowHtmlPreview(false);
        return;
      }
      if (jsonPreview) {
        setJsonPreview(null);
        return;
      }
      // Blur the trigger so it doesn't keep a stuck focus ring after ESC.
      blurActiveElement();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, showMarkdownPreview, showHtmlPreview, jsonPreview]);

  const totalFiles = useMemo(
    () => listedCalls.reduce((n, c) => n + c.files.length, 0),
    [listedCalls],
  );

  const centered = (text: string) => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      {text}
    </div>
  );

  return (
    // Full-bleed panel: fills its host container (its column in the agent
    // panel, or the DiffViewerModal backdrop). The three-pane layout (call list
    // + file tree + diff) needs every pixel.
    //
    // The root is `relative` and doubles as the floating-toolbar portal target
    // (see MenuContainerProvider above): FloatingToolbar positions itself
    // container-relative, so the container must span this whole panel.
    <MenuContainerProvider container={menuContainer}>
    <div
      ref={menuContainerRef}
      className="relative bg-card shadow-lv3 w-full h-full flex flex-col rounded-lg"
      onClick={(e) => e.stopPropagation()}
    >
        {/* Header.

            Controls sit on the LEFT, macOS-window style, and that is a
            deliberate reversal. The pointer lives over the diff — the file
            tree, the gutter, the selection toolbar are all on the left half —
            so a ✕ pinned to the far right corner charged a full-width mouse
            trip for the single most common action (dismiss this viewer).
            Closing is now the shortest travel on the bar, not the longest. */}
        <div className={`${COLUMN_HEADER_ROW} px-3`}>
          <div className="flex items-center gap-1">
            {/* Close first, at the very edge: the macOS red-dot position, so
                the muscle memory people already have lands on it. */}
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              title={t('common.close')}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            {/* The conventional fullscreen affordance (corner brackets), on
                purpose: it is the glyph people already read as "make this big"
                without a tooltip. Strictly it overstates the action — this takes
                over the pane row and leaves the tab bar and panel switcher in
                place — but an accurate-but-unfamiliar icon costs a hover on
                every use, and being read correctly at a glance is worth more
                than being literal about which axis moves. */}
            {onToggleFullscreen && (
              <button
                onClick={onToggleFullscreen}
                aria-label={fullscreen ? t('diffViewer.exitFull') : t('diffViewer.expandFull')}
                title={fullscreen ? t('diffViewer.exitFull') : t('diffViewer.expandFull')}
                aria-pressed={fullscreen === true}
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
              >
                {fullscreen
                  ? <Minimize className="w-4 h-4" />
                  : <Maximize className="w-4 h-4" />}
              </button>
            )}
            {/* 汇总: the whole turn's net diff. A two-state toggle (same shape
                as the Explorer history tab's 对比) — no selection step, no
                confirm: one click loads, one click returns. */}
            {canShowAggregate && (
              <button
                onClick={() => setAggregate((v) => !v)}
                disabled={aggregateDisabled}
                aria-pressed={aggregate}
                title={
                  aggregateDisabled
                    ? t('diffViewer.aggregateUnavailable')
                    : aggregate
                      ? t('diffViewer.aggregateOff')
                      : t('diffViewer.aggregateOn')
                }
                className={`ml-0.5 px-2 py-0.5 text-xs rounded border transition-colors ${
                  aggregateDisabled
                    ? 'border-border text-foreground-subtle opacity-60 cursor-not-allowed'
                    : aggregate
                      ? 'bg-brand text-white border-brand'
                      : 'border-border text-muted-foreground hover:text-foreground hover:bg-hover'
                }`}
              >
                {t('diffViewer.aggregate')}
              </button>
            )}
          </div>
          {/* Separates "what happens to this viewer" from "what it shows". */}
          <div className="w-px h-4 bg-border flex-shrink-0" />
          <button
            onClick={() => setShowLeft((s) => !s)}
            aria-label={t('diffViewer.toggleFileTree')}
            className={`p-1 rounded transition-colors flex-shrink-0 ${
              showLeft ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-hover'
            }`}
          >
            <PanelLeft className="w-4 h-4" />
          </button>
          {/* The two counts differ on purpose: per-call sums every call's
              files (a file touched 5 times counts 5), aggregate counts the
              distinct files left changed. Labelling the aggregate keeps the
              drop from reading as lost data. */}
          <h3 className="text-sm font-medium text-foreground truncate">
            {aggregate
              ? t('diffViewer.fileChangesAggregate', { count: activeFiles.length })
              : t('diffViewer.fileChanges', { count: totalFiles })}
          </h3>
        </div>

        {/* Body: call list | meta + file tree + diff (mirrors history tab) */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: one entry per tool call (= one snapshot commit). Gone in
              aggregate mode — there is no per-call axis left to navigate, and
              the file tree beside it becomes the only list (mirrors the
              Explorer compare mode replacing its commit list). */}
          {showLeft && !aggregate && (
            <div className="w-60 flex-shrink-0 border-r border-border overflow-y-auto">
              {/* Same never-silently rule as the aggregate bar: say what is
                  hidden and offer it back in place. */}
              {leadingBaselineShifts > 0 && (
                <button
                  onClick={() => setIncludeBaselineShifts((v) => !v)}
                  data-tooltip={t('diffViewer.aggregateSkippedHint', {
                    threshold: BASELINE_SHIFT_FILES,
                  })}
                  className="w-full px-3 py-1.5 border-b border-border text-left text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 transition-colors"
                >
                  {includeBaselineShifts
                    ? t('diffViewer.callsBaselineShown', { count: leadingBaselineShifts })
                    : t('diffViewer.callsBaselineHidden', { count: leadingBaselineShifts })}
                </button>
              )}
              {listedCalls.map((call) => (
                <div
                  key={call.key}
                  onClick={() => selectCall(call)}
                  className={`px-3 py-2 border-b border-border cursor-pointer hover:bg-hover ${
                    selectedCallKey === call.key ? 'bg-brand/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {call.changeClass && <ChangeClassChip cls={call.changeClass} />}
                    {call.shortHash && (
                      <span className="font-mono text-xs text-brand">{call.shortHash}</span>
                    )}
                    {call.timestamp !== undefined && (
                      <span className="text-xs text-foreground-subtle">{formatCallTime(call.timestamp)}</span>
                    )}
                  </div>
                  <div className="text-sm text-foreground whitespace-pre-wrap break-words mt-0.5" data-tooltip={callSubject(call)}>
                    {callSubjectPreview(call, 320, 10)}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                    <span>{t('commitDetail.nChanges', { count: call.files.length })}</span>
                    {(() => {
                      const stats = callLineStats(call);
                      return stats && (stats.additions > 0 || stats.deletions > 0) ? (
                        <LineStatsBadge additions={stats.additions} deletions={stats.deletions} />
                      ) : null;
                    })()}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Right: meta bar + file tree + diff */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {loading ? (
              centered(t('diffViewer.loadingSnapshots'))
            ) : calls.length === 0 ? (
              centered(t('diffViewer.noChanges'))
            ) : aggregate || displayCall ? (
              <>
                {/* Meta bar */}
                <div className="flex items-center gap-3 px-4 py-2 border-b border-border text-xs text-muted-foreground">
                  {aggregate ? (
                    <>
                      {/* Tool name / hash / subject all describe a single
                          call, so the aggregate bar states the range instead:
                          how many files are left changed, by how many calls. */}
                      <span className="flex items-center gap-1 text-foreground">
                        <Layers className="w-3.5 h-3.5" />
                        {t('diffViewer.aggregateSummary', {
                          count: activeFiles.length,
                          calls: spannedCalls.length,
                        })}
                      </span>
                      {/* Never skip silently: the heuristic is a guess, so it
                          states what it dropped and offers the undo inline. */}
                      {leadingBaselineShifts > 0 && (
                        <button
                          onClick={() => setIncludeBaselineShifts((v) => !v)}
                          data-tooltip={t('diffViewer.aggregateSkippedHint', {
                            threshold: BASELINE_SHIFT_FILES,
                          })}
                          className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors"
                        >
                          {includeBaselineShifts
                            ? t('diffViewer.aggregateBaselineIncluded', { count: leadingBaselineShifts })
                            : t('diffViewer.aggregateBaselineSkipped', { count: leadingBaselineShifts })}
                        </button>
                      )}
                      {activeStats && (activeStats.additions > 0 || activeStats.deletions > 0) && (
                        <LineStatsBadge
                          additions={activeStats.additions}
                          deletions={activeStats.deletions}
                        />
                      )}
                      {aggregateTruncated && (
                        <span className="text-amber-11">{t('diffViewer.truncated')}</span>
                      )}
                    </>
                  ) : displayCall ? (
                    <>
                      <span className="flex items-center gap-1 text-foreground">
                        <Wrench className="w-3.5 h-3.5" />
                        {displayCall.toolName}
                      </span>
                      {displayCall.shortHash && (
                        <span className="font-mono text-brand">{displayCall.shortHash}</span>
                      )}
                      {displayCall.timestamp !== undefined && (
                        <span>{formatCallTime(displayCall.timestamp)}</span>
                      )}
                      {/* Description (commit subject). Keep a generous preview in
                          place; the complete command remains available on hover. */}
                      <span className="flex-1 min-w-0 whitespace-pre-wrap break-words" data-tooltip={callSubject(displayCall)}>
                        {callSubjectPreview(displayCall, 640, 6)}
                      </span>
                      {displayCall.truncated && (
                        <span className="text-amber-11">{t('diffViewer.truncated')}</span>
                      )}
                      {displayCall.legacy && (
                        <span
                          className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          data-tooltip={t('diffViewer.reconstructedHint')}
                        >
                          {t('diffViewer.reconstructed')}
                        </span>
                      )}
                    </>
                  ) : null}
                  <div className="ml-auto flex items-center gap-2">
                    {/* Both toggles are text-diff only — an image side-by-side
                        has no density and no unified form (same as the
                        commit-detail / branch-compare panes). */}
                    {!selectedFile?.isImage && (
                      <>
                        {/* 精简/全文 applies to both split and unified views. */}
                        <DiffDensityToggle value={density} onChange={setDensity} />
                        <DiffViewModeToggle value={viewMode} onChange={setViewMode} />
                      </>
                    )}
                  </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                  {/* File tree (reuses explorer's GitFileTree) */}
                  {showLeft && (
                    <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto overflow-x-hidden">
                      {aggregateLoading ? (
                        <div className="p-4 text-center text-muted-foreground text-sm">
                          {t('diffViewer.aggregateLoading')}
                        </div>
                      ) : (
                      <GitFileTree
                        files={tree as GitFileNode<unknown>[]}
                        selectedPath={selectedFilePath}
                        expandedPaths={expandedPaths}
                        onToggle={(path) =>
                          setExpandedPaths((prev) => {
                            const next = new Set(prev);
                            if (next.has(path)) next.delete(path);
                            else next.add(path);
                            return next;
                          })
                        }
                        onSelect={(node) => {
                          if (!node.isDirectory && node.file) {
                            setSelectedFilePath((node.file as CallFile).path);
                            // On narrow screens, collapse after picking so the diff gets full width.
                            if (typeof window !== 'undefined' && window.innerWidth < 768) setShowLeft(false);
                          }
                        }}
                        cwd={cwd || ''}
                        showChanges={true}
                        showChangeClass
                        renderActions={(node) => {
                          if (node.isDirectory) return null;
                          const file = node.file as CallFile | undefined;
                          if (!file) return null;
                          return (
                            <>
                              {file.external && (
                                <span
                                  className="w-1.5 h-1.5 rounded-full bg-purple-400 flex-shrink-0"
                                  data-tooltip={t('diffViewer.externalChange')}
                                />
                              )}
                            </>
                          );
                        }}
                      />
                      )}
                    </div>
                  )}

                  {/* Diff: split (side-by-side) or unified — toggled via the
                      meta bar. Both support compact / preview / comments /
                      search. */}
                  <div className="flex-1 overflow-hidden">
                    {selectedFile ? (
                      selectedFile.isImage ? (
                        <ImageDiffView
                          filePath={selectedFile.path}
                          oldSrc={
                            cwd && selectedFile.oldRev
                              ? snapshotBlobUrl(cwd, selectedFile.oldRev, selectedFile.path)
                              : null
                          }
                          newSrc={
                            cwd && selectedFile.newRev
                              ? snapshotBlobUrl(cwd, selectedFile.newRev, selectedFile.path)
                              : null
                          }
                        />
                      ) : selectedFile.unviewable ? (
                        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                          {t('diffViewer.notViewable')}
                        </div>
                      ) : viewMode === 'unified' ? (
                        <DiffUnifiedView
                          oldContent={selectedFile.old_string}
                          newContent={selectedFile.new_string}
                          filePath={selectedFile.path}
                          cwd={cwd}
                          // Same selection toolbar (comment / send-to-AI /
                          // search) as split — commentsEnabled still gates on a
                          // truthy cwd inside the view.
                          enableComments
                          onContentSearch={onContentSearch}
                          compact={density === 'compact'}
                          onPreview={
                            selectedFile.status === 'deleted'
                              ? undefined
                              : isMarkdownFile(selectedFile.path)
                                ? () => setShowMarkdownPreview(true)
                                : isHtmlFile(selectedFile.path)
                                  ? () => setShowHtmlPreview(true)
                                  : selectedFile.path.endsWith('.json')
                                    ? () => setJsonPreview({ content: selectedFile.new_string, filePath: selectedFile.path })
                                    : undefined
                          }
                          previewLabel={
                            selectedFile.path.endsWith('.json') ? t('common.readable') : t('common.preview')
                          }
                        />
                      ) : (
                        <DiffView
                          oldContent={selectedFile.old_string}
                          newContent={selectedFile.new_string}
                          filePath={selectedFile.path}
                          isNew={selectedFile.status === 'added'}
                          isDeleted={selectedFile.status === 'deleted'}
                          cwd={cwd}
                          // Enable the selection toolbar (comment / send-to-AI /
                          // search). `commentsEnabled` inside DiffView still
                          // requires a truthy cwd, so this is a no-op when the
                          // message has no project context.
                          enableComments
                          onContentSearch={onContentSearch}
                          compact={density === 'compact'}
                          onPreview={
                            selectedFile.status === 'deleted'
                              ? undefined
                              : isMarkdownFile(selectedFile.path)
                                ? () => setShowMarkdownPreview(true)
                                : isHtmlFile(selectedFile.path)
                                  ? () => setShowHtmlPreview(true)
                                  : selectedFile.path.endsWith('.json')
                                    ? () => setJsonPreview({ content: selectedFile.new_string, filePath: selectedFile.path })
                                    : undefined
                          }
                          previewLabel={
                            selectedFile.path.endsWith('.json') ? t('common.readable') : t('common.preview')
                          }
                        />
                      )
                    ) : (
                      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                        {aggregateLoading
                          ? t('diffViewer.aggregateLoading')
                          : aggregateFailed
                            ? t('diffViewer.aggregateFailed')
                            : /* Not "no changes": the calls DID change files,
                                 they just cancel out across the range (e.g.
                                 created then deleted, or edited back). */
                              aggregate && activeFiles.length === 0
                              ? t('diffViewer.aggregateEmpty')
                              : t('diffViewer.selectFileToView')}
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : (
              centered(t('diffViewer.selectFileToView'))
            )}
          </div>
        </div>

        {/* Markdown preview overlay — renders the SNAPSHOT's post-change
            content (read-only intent), same pattern as StatusDiffPane. */}
        {showMarkdownPreview && selectedFile && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-scrim p-2 md:p-4"
            onClick={() => setShowMarkdownPreview(false)}
          >
            <div
              className="bg-card rounded-lg shadow-lv3 w-full max-w-[95%] h-full flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <InteractiveMarkdownPreview
                content={selectedFile.new_string}
                filePath={selectedFile.path}
                cwd={cwd || ''}
                onClose={() => setShowMarkdownPreview(false)}
              />
            </div>
          </div>
        )}

        {/* HTML preview overlay — opening it is a user gesture → trusted. Its
            own Portal/fixed overlay, so no wrapper needed here. */}
        {showHtmlPreview && selectedFile && (
          <HtmlPreviewModal
            filePath={selectedFile.path}
            content={selectedFile.new_string}
            cwd={cwd}
            onClose={() => setShowHtmlPreview(false)}
            onContentSearch={onContentSearch}
          />
        )}

        {/* JSON readable preview overlay. */}
        {jsonPreview && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-scrim p-2 md:p-4"
            onClick={() => setJsonPreview(null)}
          >
            <div
              className="bg-card rounded-lg shadow-lv3 w-full max-w-[95%] h-full flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                <span className="text-sm text-muted-foreground font-mono truncate">{jsonPreview.filePath}</span>
                <button
                  onClick={() => setJsonPreview(null)}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto px-6 py-4 bg-secondary">
                <pre className="whitespace-pre-wrap break-words font-mono text-foreground" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
                  {formatAsHumanReadable(jsonPreview.content)}
                </pre>
              </div>
            </div>
          </div>
        )}
    </div>
    </MenuContainerProvider>
  );
}

// Backward-compatible full-screen modal wrapper. Used where there is no column
// to host the diff — e.g. SubagentTranscriptModal, which is itself a Portal
// modal and has no agent-panel layout to open a column in.
export function DiffViewerModal({ toolCalls, cwd, sessionId, onClose, onContentSearch }: DiffViewerModalProps) {
  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
        onClick={onClose}
      >
        <FileDiffViewer
          toolCalls={toolCalls}
          cwd={cwd}
          sessionId={sessionId}
          onClose={onClose}
          // Searching leaves this fullscreen modal — close it first so the
          // Explorer search results aren't hidden behind the backdrop
          // (mirrors HtmlPreviewModal's close-then-search handoff).
          onContentSearch={onContentSearch ? (query) => { onClose(); onContentSearch(query); } : undefined}
        />
      </div>
    </Portal>
  );
}
