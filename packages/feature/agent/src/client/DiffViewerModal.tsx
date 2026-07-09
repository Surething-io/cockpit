'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Effect } from 'effect';
import { useEffectQuery } from '@cockpit/effect-react';
import { Portal } from '@cockpit/shared-ui';
import { X, PanelLeft, Wrench } from 'lucide-react';
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
  InteractiveMarkdownPreview,
  isMarkdownFile,
  formatAsHumanReadable,
  type GitFileNode,
} from '@cockpit/feature-explorer';
import { loadSnapshotDiffsForToolIds, type SnapshotDiffDto } from './effect/snapshotClient';
import { classifyPath, classifyFiles, type ChangeClass } from './changeClass';
import type { ToolCallInfo } from './types';

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
  /** Changed in the same commit but NOT declared by the tool — likely another
   *  concurrent session / external process (best-effort attribution). */
  external?: boolean;
  /** Heuristic: this file is a test / docs file (null = regular code). */
  fileClass?: ChangeClass | null;
}

/** One tool call = one snapshot commit (or one legacy pseudo-call). */
interface CallEntry {
  key: string;
  shortHash?: string;
  toolName: string;
  subject: string;
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
  onClose: () => void;
}

// ============================================
// Data adapters
// ============================================

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
      toolName: d.commit.toolName ?? 'tool',
      subject: d.commit.subject,
      timestamp: d.commit.timestamp,
      truncated: d.truncated === true,
      changeClass: classifyFiles(d.files.map((f) => f.path)),
      files: d.files.map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        old_string: f.oldContent ?? '',
        new_string: f.newContent ?? '',
        unviewable: f.binary || (f.oldContent === null && f.newContent === null),
        // Attribution is best-effort: only meaningful when the tool declared
        // target files (Edit/Write); Bash declares nothing → no marking.
        external: declared.size > 0 && !declared.has(f.path),
        fileClass: classifyPath(f.path),
      })),
    };
  });
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
          files: [{ path, status: 'modified', old_string: input.old_string, new_string: input.new_string, fileClass: classifyPath(path) }],
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
          files: [{ path, status: 'added', old_string: '', new_string: input.content, fileClass: classifyPath(path) }],
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
  return fromSnapshots.length > 0 ? fromSnapshots : callsFromToolParams(toolCalls, cwd);
}

/**
 * Sum additions/deletions across a call's files. Returns null when NO file
 * carries line stats — i.e. legacy parameter-reconstructed calls, where we
 * show the file count only rather than a misleading +0 -0.
 */
function callLineStats(call: CallEntry): { additions: number; deletions: number } | null {
  let hasStats = false;
  let additions = 0;
  let deletions = 0;
  for (const f of call.files) {
    if (f.additions !== undefined || f.deletions !== undefined) hasStats = true;
    additions += f.additions ?? 0;
    deletions += f.deletions ?? 0;
  }
  return hasStats ? { additions, deletions } : null;
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

/** Subdued chip marking a non-critical (test-only / docs-only) change. */
function ChangeClassChip({ cls }: { cls: ChangeClass }) {
  return (
    <span
      className={`text-[10px] px-1 py-px rounded flex-shrink-0 ${
        cls === 'test'
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400/80'
          : 'bg-sky-500/15 text-sky-600 dark:text-sky-400/80'
      }`}
    >
      {cls}
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

export function DiffViewerModal({ toolCalls, cwd, onClose }: DiffViewerModalProps) {
  const { t } = useTranslation();

  // Real on-disk diffs from the shadow-git snapshots, keyed by this message's
  // tool_use ids. cwd missing → skip straight to the legacy fallback.
  const toolIds = useMemo(() => toolCalls.map((tc) => tc.id).filter(Boolean), [toolCalls]);
  const toolIdsKey = toolIds.join(',');
  // Snapshots are written fire-and-forget after each tool_result — a modal
  // opened right after a tool finished can observe a PARTIALLY landed set.
  // When commits are missing for tools that almost certainly changed files
  // (Edit/Write family), refetch up to twice before settling.
  const [retryTick, setRetryTick] = useState(0);
  const snapshotsQ = useEffectQuery(
    cwd && toolIds.length > 0
      ? loadSnapshotDiffsForToolIds(cwd, toolIds)
      : Effect.succeed([] as SnapshotDiffDto[]),
    [cwd, toolIdsKey, retryTick],
  );
  const declaredWriteIds = useMemo(
    () =>
      toolCalls
        .filter((tc) => ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tc.name))
        .map((tc) => tc.id),
    [toolCalls],
  );
  useEffect(() => {
    if (snapshotsQ.status !== 'success' || retryTick >= 2) return;
    const landed = new Set(snapshotsQ.data.map((d) => d.commit.toolId));
    if (declaredWriteIds.some((id) => !landed.has(id))) {
      const t = setTimeout(() => setRetryTick((v) => v + 1), 2000);
      return () => clearTimeout(t);
    }
  }, [snapshotsQ, retryTick, declaredWriteIds]);

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
  // split/unified — pane-local, defaults to split (same non-persisted policy
  // as density). Unified mode has no compact/preview support (see render).
  const [viewMode, setViewMode] = useState<'split' | 'unified'>('split');
  // Rendered previews of the SNAPSHOT's post-change content (not the current
  // disk state — that's the point). Same overlay pattern as StatusDiffPane.
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
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
  const tree = useMemo<GitFileNode<CallFile>[]>(
    () => (displayCall ? buildGitFileTree(displayCall.files) : []),
    [displayCall],
  );
  const selectedFile = useMemo(
    () => displayCall?.files.find((f) => f.path === selectedFilePath) ?? null,
    [displayCall, selectedFilePath],
  );

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
    if (calls.length > 0 && selectedCallKey == null) {
      selectCall(calls[0]);
    }
  }, [calls, selectedCallKey, selectCall]);

  // ESC closes the innermost layer first: preview overlay → whole modal.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showMarkdownPreview) {
        setShowMarkdownPreview(false);
        return;
      }
      if (jsonPreview) {
        setJsonPreview(null);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, showMarkdownPreview, jsonPreview]);

  const totalFiles = useMemo(() => calls.reduce((n, c) => n + c.files.length, 0), [calls]);

  const centered = (text: string) => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      {text}
    </div>
  );

  const modalContent = (
    // Full-bleed: the three-pane layout (call list + file tree + diff) needs
    // every pixel — no floating-window margins on desktop either.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="relative bg-card shadow-xl w-full h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowLeft((s) => !s)}
              aria-label={t('diffViewer.toggleFileTree')}
              className={`p-1 rounded transition-colors ${
                showLeft ? 'text-foreground bg-accent' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              <PanelLeft className="w-4 h-4" />
            </button>
            <h3 className="text-sm font-medium text-foreground">
              {t('diffViewer.fileChanges', { count: totalFiles })}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body: call list | meta + file tree + diff (mirrors history tab) */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: one entry per tool call (= one snapshot commit) */}
          {showLeft && (
            <div className="w-60 flex-shrink-0 border-r border-border overflow-y-auto">
              {calls.map((call) => (
                <div
                  key={call.key}
                  onClick={() => selectCall(call)}
                  className={`px-3 py-2 border-b border-border cursor-pointer hover:bg-accent ${
                    selectedCallKey === call.key ? 'bg-brand/10' : ''
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {call.shortHash && (
                      <span className="font-mono text-xs text-brand">{call.shortHash}</span>
                    )}
                    {call.timestamp !== undefined && (
                      <span className="text-xs text-slate-9">{formatCallTime(call.timestamp)}</span>
                    )}
                    {call.changeClass && (
                      <span className="ml-auto">
                        <ChangeClassChip cls={call.changeClass} />
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-foreground truncate mt-0.5" data-tooltip={call.subject}>
                    {call.subject}
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
            ) : displayCall ? (
              <>
                {/* Meta bar */}
                <div className="flex items-center gap-3 px-4 py-2 border-b border-border text-xs text-muted-foreground">
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
                  {/* Description (commit subject). Takes the flexible middle and
                      truncates; full text on hover. min-w-0 lets it shrink so
                      the trailing toggles keep their space. */}
                  <span className="flex-1 min-w-0 truncate" data-tooltip={displayCall.subject}>
                    {displayCall.subject}
                  </span>
                  {displayCall.truncated && (
                    <span className="text-amber-500">{t('diffViewer.truncated')}</span>
                  )}
                  {displayCall.legacy && (
                    <span
                      className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      data-tooltip={t('diffViewer.reconstructedHint')}
                    >
                      {t('diffViewer.reconstructed')}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {/* 精简/全文 applies to both split and unified views. */}
                    <DiffDensityToggle value={density} onChange={setDensity} />
                    <DiffViewModeToggle value={viewMode} onChange={setViewMode} />
                  </div>
                </div>

                <div className="flex-1 flex overflow-hidden">
                  {/* File tree (reuses explorer's GitFileTree) */}
                  {showLeft && (
                    <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto overflow-x-hidden">
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
                        renderActions={(node) => {
                          if (node.isDirectory) return null;
                          const file = node.file as CallFile | undefined;
                          if (!file) return null;
                          return (
                            <>
                              {file.fileClass && <ChangeClassChip cls={file.fileClass} />}
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
                    </div>
                  )}

                  {/* Diff: split (side-by-side) or unified — toggled via the
                      meta bar. Unified has no compact/preview support. */}
                  <div className="flex-1 overflow-hidden">
                    {selectedFile ? (
                      selectedFile.unviewable ? (
                        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                          {t('diffViewer.notViewable')}
                        </div>
                      ) : viewMode === 'unified' ? (
                        <DiffUnifiedView
                          oldContent={selectedFile.old_string}
                          newContent={selectedFile.new_string}
                          filePath={selectedFile.path}
                          compact={density === 'compact'}
                        />
                      ) : (
                        <DiffView
                          oldContent={selectedFile.old_string}
                          newContent={selectedFile.new_string}
                          filePath={selectedFile.path}
                          isNew={selectedFile.status === 'added'}
                          isDeleted={selectedFile.status === 'deleted'}
                          cwd={cwd}
                          compact={density === 'compact'}
                          onPreview={
                            selectedFile.status === 'deleted'
                              ? undefined
                              : isMarkdownFile(selectedFile.path)
                                ? () => setShowMarkdownPreview(true)
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
                        {t('diffViewer.selectFileToView')}
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
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-2 md:p-4"
            onClick={() => setShowMarkdownPreview(false)}
          >
            <div
              className="bg-card rounded-lg shadow-xl w-full max-w-[95%] h-full flex flex-col"
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

        {/* JSON readable preview overlay. */}
        {jsonPreview && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-2 md:p-4"
            onClick={() => setJsonPreview(null)}
          >
            <div
              className="bg-card rounded-lg shadow-xl w-full max-w-[95%] h-full flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                <span className="text-sm text-muted-foreground font-mono truncate">{jsonPreview.filePath}</span>
                <button
                  onClick={() => setJsonPreview(null)}
                  className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-auto px-6 py-4 bg-[#0d1117]">
                <pre className="whitespace-pre-wrap break-words font-mono" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
                  {formatAsHumanReadable(jsonPreview.content)}
                </pre>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
