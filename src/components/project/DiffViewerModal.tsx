'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../shared/Portal';
import { X, ChevronRight, ChevronDown, FileText } from 'lucide-react';
import { DiffView, DiffUnifiedView } from './DiffView';
import type { ToolCallInfo } from '@/types/chat';

// ============================================
// Types
// ============================================

interface FileChange {
  filePath: string;
  /** Unique identifier to distinguish multiple changes to the same file */
  uid: string;
  type: 'edit' | 'write';
  old_string: string;
  new_string: string;
}

interface TreeNode {
  name: string;
  fullPath: string;
  isFile: boolean;
  children: TreeNode[];
  change?: FileChange;
}

interface DiffViewerModalProps {
  toolCalls: ToolCallInfo[];
  cwd?: string;
  onClose: () => void;
}

// ============================================
// Extract Edit/Write changes from toolCalls
// ============================================

function toRelativePath(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    const rel = filePath.slice(cwd.length);
    return rel.startsWith('/') ? rel.slice(1) : rel;
  }
  return filePath;
}

function extractFileChanges(toolCalls: ToolCallInfo[], cwd?: string): FileChange[] {
  const changes: FileChange[] = [];
  let idx = 0;

  for (const tc of toolCalls) {
    if (tc.name === 'Edit') {
      const input = tc.input as { file_path?: string; old_string?: string; new_string?: string };
      if (input.file_path && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        changes.push({
          filePath: toRelativePath(input.file_path, cwd),
          uid: `change-${idx++}`,
          type: 'edit',
          old_string: input.old_string,
          new_string: input.new_string,
        });
      }
    } else if (tc.name === 'Write') {
      const input = tc.input as { file_path?: string; content?: string };
      if (input.file_path && typeof input.content === 'string') {
        changes.push({
          filePath: toRelativePath(input.file_path, cwd),
          uid: `change-${idx++}`,
          type: 'write',
          old_string: '',
          new_string: input.content,
        });
      }
    }
  }

  return changes;
}

// ============================================
// Build directory tree
// ============================================

function buildTree(changes: FileChange[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const change of changes) {
    const parts = change.filePath.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      const fullPath = parts.slice(0, i + 1).join('/');

      if (isFile) {
        // File nodes are not deduplicated; create a new node for each change
        const node: TreeNode = { name, fullPath, isFile: true, children: [], change };
        current.push(node);
      } else {
        // Reuse directory nodes
        let node = current.find(n => n.name === name && !n.isFile);
        if (!node) {
          node = { name, fullPath, isFile: false, children: [] };
          current.push(node);
        }
        current = node.children;
      }
    }
  }

  return root;
}

// Find common prefix depth, skip levels with only a single subdirectory
function collapseTree(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (!node.isFile && node.children.length === 1 && !node.children[0].isFile) {
      // Merge single-child directory
      const child = node.children[0];
      const merged: TreeNode = {
        ...child,
        name: node.name + '/' + child.name,
        children: collapseTree(child.children),
      };
      return merged;
    }
    return { ...node, children: collapseTree(node.children) };
  });
}

// ============================================
// Directory tree node component
// ============================================

function TreeNodeItem({
  node,
  selectedUid,
  onSelect,
  depth = 0,
}: {
  node: TreeNode;
  selectedUid: string;
  onSelect: (change: FileChange) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(true);

  if (node.isFile && node.change) {
    const isSelected = selectedUid === node.change.uid;
    return (
      <button
        onClick={() => onSelect(node.change!)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs text-left rounded transition-colors ${
          isSelected
            ? 'bg-brand/15 text-brand'
            : 'text-foreground hover:bg-accent'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        data-tooltip={node.fullPath}
      >
        <FileText className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
        <span className="truncate">{node.name}</span>
        <span className={`ml-auto text-[10px] flex-shrink-0 ${
          node.change.type === 'write' ? 'text-green-500' : 'text-yellow-500'
        }`}>
          {node.change.type === 'write' ? 'new' : 'edit'}
        </span>
      </button>
    );
  }

  // Directory
  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && node.children.map((child, i) => (
        <TreeNodeItem
          key={child.isFile && child.change ? child.change.uid : `${child.fullPath}-${i}`}
          node={child}
          selectedUid={selectedUid}
          onSelect={onSelect}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

// ============================================
// DiffViewerModal
// ============================================

export function DiffViewerModal({ toolCalls, cwd, onClose }: DiffViewerModalProps) {
  const { t } = useTranslation();
  const changes = useMemo(() => extractFileChanges(toolCalls, cwd), [toolCalls, cwd]);
  const tree = useMemo(() => collapseTree(buildTree(changes)), [changes]);

  const [selected, setSelected] = useState<FileChange | null>(changes[0] || null);
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');
  const [hoverTooltip, setHoverTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // ========== data-tooltip event delegation ==========
  useEffect(() => {
    const container = sidebarRef.current;
    if (!container) return;
    const findTooltip = (target: EventTarget | null): string | null => {
      let el = target as HTMLElement | null;
      while (el && el !== container) {
        if (el.dataset.tooltip) return el.dataset.tooltip;
        el = el.parentElement;
      }
      return null;
    };
    const onOver = (e: MouseEvent) => {
      const text = findTooltip(e.target);
      setHoverTooltip(text ? { text, x: e.clientX, y: e.clientY } : null);
    };
    const onMove = (e: MouseEvent) => {
      setHoverTooltip(prev => {
        if (!prev) return null;
        const text = findTooltip(e.target);
        if (!text) return null;
        return { text, x: e.clientX, y: e.clientY };
      });
    };
    const onOut = (e: MouseEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      if (!related || !container.contains(related) || !findTooltip(related)) {
        setHoverTooltip(null);
      }
    };
    container.addEventListener('mouseover', onOver);
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseout', onOut);
    return () => {
      container.removeEventListener('mouseover', onOver);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseout', onOut);
    };
  }, []);

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (changes.length === 0) return null;

  // Extract filename for title
  const selectedFileName = selected ? selected.filePath.split('/').pop() : '';

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90vh] flex flex-col transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {t('diffViewer.fileChanges', { count: changes.length })}
            </h3>
          </div>
          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            <div className="flex items-center gap-1 bg-accent rounded p-0.5">
              <button
                onClick={() => setViewMode('unified')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  viewMode === 'unified'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Unified
              </button>
              <button
                onClick={() => setViewMode('split')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  viewMode === 'split'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Split
              </button>
            </div>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body: sidebar + diff */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left file tree */}
          <div ref={sidebarRef} className="w-56 flex-shrink-0 border-r border-border overflow-y-auto py-2">
            {tree.map((node, i) => (
              <TreeNodeItem
                key={node.isFile && node.change ? node.change.uid : `${node.fullPath}-${i}`}
                node={node}
                selectedUid={selected?.uid || ''}
                onSelect={setSelected}
              />
            ))}
          </div>

          {/* Right Diff */}
          <div className="flex-1 overflow-auto">
            {selected ? (
              viewMode === 'unified' ? (
                <DiffUnifiedView
                  oldContent={selected.old_string}
                  newContent={selected.new_string}
                  filePath={selected.filePath}
                />
              ) : (
                <DiffView
                  oldContent={selected.old_string}
                  newContent={selected.new_string}
                  filePath={selected.filePath}
                  isNew={selected.type === 'write'}
                />
              )
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                {t('diffViewer.selectFileToView')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <Portal>{modalContent}</Portal>
      {hoverTooltip && <Portal>
        <div
          className="fixed z-[9999] px-2 py-1 bg-popover text-popover-foreground text-xs font-mono rounded shadow-lg border border-brand whitespace-nowrap pointer-events-none"
          style={{ left: hoverTooltip.x + 12, top: hoverTooltip.y + 16 }}
        >
          {hoverTooltip.text}
        </div>
      </Portal>
      }
    </>
  );
}
