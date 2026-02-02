'use client';

import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileContextMenu, useFileContextMenu } from './FileContextMenu';
import { FileIcon } from './FileIcon';

// ============================================================================
// Types
// ============================================================================

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

interface FlatTreeItem {
  node: FileNode;
  level: number;
}

// ============================================================================
// Constants
// ============================================================================

const ROW_HEIGHT = 26;

// ============================================================================
// Helper Functions
// ============================================================================

function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  matchedPaths: Set<string> | null,
  level: number = 0
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];

  for (const node of nodes) {
    // 如果有搜索过滤，检查是否匹配
    if (matchedPaths !== null && !matchedPaths.has(node.path)) {
      continue;
    }

    result.push({ node, level });

    if (node.isDirectory && node.children && expandedPaths.has(node.path)) {
      result.push(...flattenTree(node.children, expandedPaths, matchedPaths, level + 1));
    }
  }

  return result;
}

// ============================================================================
// VirtualTreeRow Component
// ============================================================================

interface VirtualTreeRowProps {
  item: FlatTreeItem;
  isSelected: boolean;
  isExpanded: boolean;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onContextMenu: (e: React.MouseEvent, path: string, isDirectory: boolean) => void;
}

const VirtualTreeRow = React.memo(function VirtualTreeRow({
  item,
  isSelected,
  isExpanded,
  onSelect,
  onToggle,
  onContextMenu,
}: VirtualTreeRowProps) {
  const { node, level } = item;

  const handleClick = useCallback(() => {
    if (node.isDirectory) {
      onToggle(node.path);
    } else {
      onSelect(node.path);
    }
  }, [node.isDirectory, node.path, onSelect, onToggle]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    onContextMenu(e, node.path, node.isDirectory);
  }, [node.path, node.isDirectory, onContextMenu]);

  return (
    <div
      className={`flex items-center gap-1.5 py-0.5 px-2 cursor-pointer hover:bg-accent ${
        isSelected ? 'bg-brand/10' : ''
      }`}
      style={{ paddingLeft: `${level * 12 + 8}px` }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {node.isDirectory ? (
        <svg
          className={`w-4 h-4 flex-shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
        >
          <path d="M6 4 L10 8 L6 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <FileIcon name={node.name} size={16} className="flex-shrink-0 ml-4" />
      )}
      <span className={`text-sm truncate ${isSelected && !node.isDirectory ? 'text-brand' : 'text-foreground'}`}>
        {node.name}
      </span>
    </div>
  );
});

// ============================================================================
// FileTree Component (with Virtual Scrolling)
// ============================================================================

export interface FileTreeProps {
  files: FileNode[];
  selectedPath: string | null;
  expandedPaths: Set<string>;
  matchedPaths?: Set<string> | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  cwd: string;
  shouldScrollToSelected?: boolean;
}

export function FileTree({
  files,
  selectedPath,
  expandedPaths,
  matchedPaths = null,
  onSelect,
  onToggle,
  cwd,
  shouldScrollToSelected = false,
}: FileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { contextMenu, showContextMenu, hideContextMenu } = useFileContextMenu();

  const flatItems = useMemo(() => {
    return flattenTree(files, expandedPaths, matchedPaths);
  }, [files, expandedPaths, matchedPaths]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Scroll to selected file only when shouldScrollToSelected is true
  useEffect(() => {
    if (shouldScrollToSelected && selectedPath && flatItems.length > 0) {
      const index = flatItems.findIndex(item => item.node.path === selectedPath);
      if (index >= 0) {
        virtualizer.scrollToIndex(index, { align: 'center' });
      }
    }
  }, [shouldScrollToSelected, selectedPath, flatItems, virtualizer]);

  if (flatItems.length === 0) {
    return (
      <div className="p-4 text-center text-muted-foreground text-sm">
        No files
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      style={{ willChange: 'transform' }}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = flatItems[virtualItem.index];
          return (
            <div
              key={item.node.path}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${virtualItem.size}px`,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <VirtualTreeRow
                item={item}
                isSelected={selectedPath === item.node.path}
                isExpanded={expandedPaths.has(item.node.path)}
                onSelect={onSelect}
                onToggle={onToggle}
                onContextMenu={showContextMenu}
              />
            </div>
          );
        })}
      </div>

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

