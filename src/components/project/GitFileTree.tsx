'use client';

import React, { useCallback, ReactNode } from 'react';
import { FileContextMenu, useFileContextMenu } from './FileContextMenu';
import { FileIcon } from '../shared/FileIcon';

// ============================================================================
// Types
// ============================================================================

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface GitFileNode<T = unknown> {
  name: string;
  path: string;
  isDirectory: boolean;
  children: GitFileNode<T>[];
  expanded?: boolean;
  // Git specific
  status?: GitFileStatus;
  additions?: number;
  deletions?: number;
  oldPath?: string; // for renamed files
  // Original file data for callbacks
  file?: T;
}

// ============================================================================
// Status Icon Component
// ============================================================================

function StatusIcon({ status }: { status: GitFileStatus }) {
  const config: Record<GitFileStatus, { label: string; className: string }> = {
    added: { label: 'A', className: 'text-green-11' },
    untracked: { label: 'A', className: 'text-green-11' },
    modified: { label: 'M', className: 'text-amber-11' },
    deleted: { label: 'D', className: 'text-red-11' },
    renamed: { label: 'R', className: 'text-brand' },
  };

  const { label, className } = config[status] || { label: '?', className: 'text-muted-foreground' };

  return <span className={`text-xs font-bold ${className}`}>{label}</span>;
}

// ============================================================================
// GitFileTreeItem Component
// ============================================================================

interface GitFileTreeItemProps {
  node: GitFileNode<unknown>;
  level: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (node: GitFileNode<unknown>) => void;
  onToggle: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDirectory: boolean) => void;
  showChanges?: boolean;
  renderActions?: (node: GitFileNode<unknown>) => ReactNode;
}

const GitFileTreeItem = React.memo(function GitFileTreeItem({
  node,
  level,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggle,
  onContextMenu,
  showChanges = false,
  renderActions,
}: GitFileTreeItemProps) {
  const isSelected = selectedPath === node.path;
  const isExpanded = expandedPaths.has(node.path);

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [node, onSelect, onToggle]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, node.path, node.isDirectory);
  }, [node.path, node.isDirectory, onContextMenu]);

  if (node.isDirectory) {
    return (
      <div>
        <div
          className="flex items-center gap-1 py-0.5 px-2 pr-3 hover:bg-accent cursor-pointer whitespace-nowrap group"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
        >
          <span className="text-slate-9 text-xs">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="text-sm text-foreground flex-1 truncate" data-tooltip={node.path}>{node.name}</span>
          {renderActions && renderActions(node)}
        </div>
        {isExpanded && node.children.map(child => (
          <GitFileTreeItem
            key={child.path}
            node={child}
            level={level + 1}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            onSelect={onSelect}
            onToggle={onToggle}
            onContextMenu={onContextMenu}
            showChanges={showChanges}
            renderActions={renderActions}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 px-2 pr-3 cursor-pointer whitespace-nowrap group ${
        isSelected ? 'bg-brand/10' : 'hover:bg-accent'
      }`}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <FileIcon name={node.name} size={16} className="flex-shrink-0" />
      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-brand' : 'text-foreground'}`} data-tooltip={node.path}>
        {node.name}
      </span>
      {node.status && <StatusIcon status={node.status} />}
      {showChanges && node.additions !== undefined && node.deletions !== undefined && (
        <>
          <span className="text-xs text-green-11">+{node.additions}</span>
          <span className="text-xs text-red-11">-{node.deletions}</span>
        </>
      )}
      {renderActions && renderActions(node)}
    </div>
  );
});

// ============================================================================
// GitFileTree Component
// ============================================================================

export interface GitFileTreeProps {
  files: GitFileNode<unknown>[];
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (node: GitFileNode<unknown>) => void;
  onToggle: (path: string) => void;
  cwd: string;
  showChanges?: boolean;
  renderActions?: (node: GitFileNode<unknown>) => ReactNode;
  emptyMessage?: string;
  className?: string;
}

export function GitFileTree({
  files,
  selectedPath,
  expandedPaths,
  onSelect,
  onToggle,
  cwd,
  showChanges = false,
  renderActions,
  emptyMessage = '无文件',
  className,
}: GitFileTreeProps) {
  const { contextMenu, showContextMenu, hideContextMenu } = useFileContextMenu();

  if (files.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-slate-9">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className={className || "py-1 overflow-y-auto h-full min-w-max"}>
      {files.map(node => (
        <GitFileTreeItem
          key={node.path}
          node={node}
          level={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={showContextMenu}
          showChanges={showChanges}
          renderActions={renderActions}
        />
      ))}

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          path={contextMenu.path}
          cwd={cwd}
          isDirectory={contextMenu.isDirectory}
          onClose={hideContextMenu}
        />
      )}
    </div>
  );
}

// ============================================================================
// Helper function to build tree from flat file list
// ============================================================================

// Minimal interface for building tree - only requires path and status
interface FileChangeInput {
  path: string;
  status: string; // Use string to allow any status type
  oldPath?: string;
  additions?: number;
  deletions?: number;
}

export function buildGitFileTree<T extends FileChangeInput>(files: T[]): GitFileNode<T>[] {
  const root: GitFileNode<T>[] = [];

  for (const file of files) {
    const parts = file.path.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find(n => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: [],
          ...(isLast && {
            status: file.status as GitFileStatus,
            additions: file.additions,
            deletions: file.deletions,
            oldPath: file.oldPath,
            file: file, // Store original file object
          }),
        };
        currentLevel.push(existing);
      }

      if (!isLast) {
        currentLevel = existing.children;
      }
    }
  }

  // Sort: directories first, then files
  const sortNodes = (nodes: GitFileNode<T>[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => sortNodes(n.children));
  };

  sortNodes(root);
  return root;
}

// Collect all directory paths for initial expansion
export function collectGitTreeDirPaths<T>(nodes: GitFileNode<T>[]): string[] {
  const paths: string[] = [];
  const traverse = (nodeList: GitFileNode<T>[]) => {
    for (const node of nodeList) {
      if (node.isDirectory) {
        paths.push(node.path);
        traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return paths;
}

// Collect all file paths under a directory node (recursive)
export function collectFilesUnderNode<T>(node: GitFileNode<T>): GitFileNode<T>[] {
  const files: GitFileNode<T>[] = [];
  const traverse = (n: GitFileNode<T>) => {
    if (n.isDirectory) {
      for (const child of n.children) {
        traverse(child);
      }
    } else {
      files.push(n);
    }
  };
  traverse(node);
  return files;
}
