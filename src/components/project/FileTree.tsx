'use client';

import React, { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FileContextMenu, useFileContextMenu } from './FileContextMenu';
import { FileIcon } from '../shared/FileIcon';

// ============================================================================
// Types
// ============================================================================

export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

// Git 状态类型: M=修改, A=新增, D=删除, ?=未跟踪, R=重命名
export type GitStatusCode = 'M' | 'A' | 'D' | '?' | 'R';

// Git 状态映射: path -> status code
export type GitStatusMap = Map<string, GitStatusCode>;

interface FlatTreeItem {
  node: FileNode;
  level: number;
  gitStatus?: GitStatusCode;
  hasChangedChildren?: boolean; // 目录下是否有变更的文件
}

// ============================================================================
// Constants
// ============================================================================

const ROW_HEIGHT = 26;

// ============================================================================
// Helper Functions
// ============================================================================

// 检查目录下是否有变更的文件（递归）
function hasChangedFilesInDir(node: FileNode, gitStatusMap: GitStatusMap | null): boolean {
  if (!gitStatusMap || !node.isDirectory || !node.children) return false;

  for (const child of node.children) {
    if (child.isDirectory) {
      if (hasChangedFilesInDir(child, gitStatusMap)) return true;
    } else {
      if (gitStatusMap.has(child.path)) return true;
    }
  }
  return false;
}

function flattenTree(
  nodes: FileNode[],
  expandedPaths: Set<string>,
  matchedPaths: Set<string> | null,
  gitStatusMap: GitStatusMap | null = null,
  level: number = 0
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];

  for (const node of nodes) {
    // 如果有搜索过滤，检查是否匹配
    if (matchedPaths !== null && !matchedPaths.has(node.path)) {
      continue;
    }

    const gitStatus = gitStatusMap?.get(node.path);
    const hasChangedChildren = node.isDirectory ? hasChangedFilesInDir(node, gitStatusMap) : undefined;

    result.push({ node, level, gitStatus, hasChangedChildren });

    if (node.isDirectory && node.children && expandedPaths.has(node.path)) {
      result.push(...flattenTree(node.children, expandedPaths, matchedPaths, gitStatusMap, level + 1));
    }
  }

  return result;
}

// ============================================================================
// VirtualTreeRow Component
// ============================================================================

// Git 状态颜色配置
const GIT_STATUS_COLORS: Record<GitStatusCode, { text: string; bg: string }> = {
  'M': { text: 'text-amber-11', bg: 'bg-amber-9/20' },      // 修改 - 黄色
  'A': { text: 'text-green-11', bg: 'bg-green-9/20' },      // 新增 - 绿色
  'D': { text: 'text-red-11', bg: 'bg-red-9/20' },          // 删除 - 红色
  '?': { text: 'text-slate-9', bg: 'bg-slate-9/20' },       // 未跟踪 - 灰色
  'R': { text: 'text-blue-11', bg: 'bg-blue-9/20' },        // 重命名 - 蓝色
};

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
  const { node, level, gitStatus, hasChangedChildren } = item;
  const statusColors = gitStatus ? GIT_STATUS_COLORS[gitStatus] : null;

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

  // 文件名的颜色类（文件和目录都支持变色）
  const isEnvFile = !node.isDirectory && (node.name === '.env' || node.name.startsWith('.env.'));
  const nameColorClass = gitStatus
    ? statusColors!.text
    : hasChangedChildren
    ? 'text-amber-11'  // 目录下有变更文件时目录名变色
    : isEnvFile
    ? 'text-yellow-600 dark:text-yellow-500'  // .env 敏感文件高亮
    : isSelected && !node.isDirectory
    ? 'text-brand'
    : 'text-foreground';

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
      <span className={`text-sm truncate flex-1 ${nameColorClass}`} data-tooltip={node.isSymlink && node.symlinkTarget ? `${node.path} → ${node.symlinkTarget}` : node.path}>
        {node.name}
      </span>
      {node.isSymlink && (
        <span className="text-xs text-muted-foreground flex-shrink-0">→</span>
      )}
      {/* 文件的 Git 状态标识（靠右） */}
      {gitStatus && (
        <span className={`text-xs font-mono px-1 rounded ${statusColors!.text} ${statusColors!.bg} flex-shrink-0`}>
          {gitStatus}
        </span>
      )}
      {/* 目录下有变更文件时显示小圆点（靠右） */}
      {node.isDirectory && hasChangedChildren && (
        <span className="w-1.5 h-1.5 rounded-full bg-amber-9 flex-shrink-0" />
      )}
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
  gitStatusMap?: GitStatusMap | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  cwd: string;
  shouldScrollToSelected?: boolean;
  // 右键菜单操作回调
  onCreateFile?: (dirPath: string) => void;
  onDelete?: (path: string, isDirectory: boolean, name: string) => void;
  onRefresh?: () => void;
}

export function FileTree({
  files,
  selectedPath,
  expandedPaths,
  matchedPaths = null,
  gitStatusMap = null,
  onSelect,
  onToggle,
  cwd,
  shouldScrollToSelected = false,
  onCreateFile,
  onDelete,
  onRefresh,
}: FileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const { contextMenu, showContextMenu, hideContextMenu } = useFileContextMenu();

  const flatItems = useMemo(() => {
    return flattenTree(files, expandedPaths, matchedPaths, gitStatusMap);
  }, [files, expandedPaths, matchedPaths, gitStatusMap]);

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
        // 延迟执行确保 DOM 已渲染（tab 切换后需要等待 hidden 状态移除）
        const timer = setTimeout(() => {
          virtualizer.scrollToIndex(index, { align: 'center' });
        }, 150);
        return () => clearTimeout(timer);
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
          onCreateFile={onCreateFile}
          onDelete={onDelete}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

