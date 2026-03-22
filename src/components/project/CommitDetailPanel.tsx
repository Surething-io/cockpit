'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { DiffView } from './DiffView';
import { GitFileTree, buildGitFileTree, collectGitTreeDirPaths, type GitFileNode } from './GitFileTree';
import { formatAsHumanReadable } from './toolCallUtils';
import { useJsonSearch, JsonSearchBar } from '../../hooks/useJsonSearch';

// Types
export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  relativeDate?: string;
  time?: number; // Unix timestamp (for blame)
}

interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
}

interface FileDiff {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

// Format date time for display (e.g., "01-15 14:30" or "2024-01-15 14:30")
function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (isThisYear) {
    return `${month}-${day} ${hours}:${minutes}`;
  }
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

// Main component props
interface CommitDetailPanelProps {
  isOpen: boolean;
  onClose: () => void;
  commit: CommitInfo | null;
  cwd: string;
  embedded?: boolean; // 内嵌模式，无 Modal 包装和标题栏
  initialFilePath?: string; // 初始选中的文件路径
  onContentSearch?: (query: string) => void; // 选中文本 → 全项目搜索
}

export function CommitDetailPanel({ isOpen, onClose, commit, cwd, embedded = false, initialFilePath, onContentSearch }: CommitDetailPanelProps) {
  const [files, setFiles] = useState<FileChange[]>([]);
  const [fileTree, setFileTree] = useState<GitFileNode<unknown>[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<FileChange | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  const [jsonPreview, setJsonPreview] = useState<{ content: string; filePath: string } | null>(null);
  const commitPreRef = useRef<HTMLPreElement>(null);
  const commitJsonSearch = useJsonSearch(commitPreRef);

  // ESC / Cmd+F
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && jsonPreview) {
        e.preventDefault();
        commitJsonSearch.open();
        return;
      }
      if (e.key === 'Escape') {
        if (commitJsonSearch.isVisible) {
          commitJsonSearch.close();
          return;
        }
        if (jsonPreview) {
          setJsonPreview(null);
          return;
        }
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, onClose, jsonPreview, commitJsonSearch]);

  // Load files when commit changes
  useEffect(() => {
    if (!isOpen || !commit) return;

    setFiles([]);
    setFileTree([]);
    setSelectedFile(null);
    setFileDiff(null);
    setIsLoadingFiles(true);

    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}`)
      .then(res => res.json())
      .then(data => {
        const fileList: FileChange[] = data.files || [];
        setFiles(fileList);
        // Build file tree
        const tree = buildGitFileTree(fileList);
        setFileTree(tree);
        // Initialize expanded paths
        setExpandedPaths(new Set(collectGitTreeDirPaths(tree)));

        // 如果有 initialFilePath，自动选中对应的文件
        if (initialFilePath && fileList.length > 0) {
          const matchedFile = fileList.find(f => f.path === initialFilePath);
          if (matchedFile) {
            // 延迟执行以确保状态已更新
            setTimeout(() => {
              setSelectedFile(matchedFile);
              // 加载 diff
              fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}&file=${encodeURIComponent(matchedFile.path)}`)
                .then(res => res.json())
                .then(diffData => setFileDiff(diffData))
                .catch(console.error);
            }, 0);
          }
        }
      })
      .catch(console.error)
      .finally(() => setIsLoadingFiles(false));
  }, [isOpen, commit, cwd, initialFilePath]);

  // Load diff when file selected
  const handleSelectFile = useCallback((file: FileChange) => {
    if (!commit) return;
    setSelectedFile(file);
    setIsLoadingDiff(true);
    fetch(`/api/git/commit-diff?cwd=${encodeURIComponent(cwd)}&hash=${commit.hash}&file=${encodeURIComponent(file.path)}`)
      .then(res => res.json())
      .then(data => setFileDiff(data))
      .catch(console.error)
      .finally(() => setIsLoadingDiff(false));
  }, [cwd, commit]);

  // Toggle directory expand/collapse
  const handleToggle = useCallback((path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Format display date
  const displayDate = useMemo(() => {
    if (!commit) return '';
    if (commit.date) {
      return formatDateTime(commit.date);
    }
    if (commit.time) {
      return new Date(commit.time * 1000).toLocaleString();
    }
    return '';
  }, [commit]);

  if (!isOpen || !commit) return null;

  // 内容部分（共享于 embedded 和 modal 模式）
  const content = (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Commit info header */}
      <div className="px-4 py-3 border-b border-border bg-secondary flex-shrink-0">
        <div className="text-sm font-medium text-foreground mb-2">
          {commit.subject}
        </div>
        {commit.body && (
          <div className="text-xs text-muted-foreground whitespace-pre-wrap mb-3 max-h-32 overflow-y-auto border-l-2 border-border pl-3">
            {commit.body}
          </div>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1">
            <span className="text-slate-9">哈希:</span>
            <span className="font-mono bg-accent px-1.5 py-0.5 rounded">
              {commit.hash}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-9">作者:</span>
            <span>{commit.author}</span>
            <span className="text-slate-9">&lt;{commit.authorEmail}&gt;</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-9">日期:</span>
            <span>{displayDate}</span>
            {commit.relativeDate && (
              <span className="text-slate-9">({commit.relativeDate})</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-slate-9">文件:</span>
            <span>{files.length} 个变更</span>
          </div>
        </div>
      </div>

      {/* File tree + Diff container */}
      <div className="flex-1 flex overflow-hidden">
        {/* File tree */}
        <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto overflow-x-hidden">
          {isLoadingFiles ? (
            <div className="p-4 text-center text-muted-foreground text-sm">加载文件中...</div>
          ) : (
            <GitFileTree
              files={fileTree}
              selectedPath={selectedFile?.path || null}
              expandedPaths={expandedPaths}
              onSelect={(node) => node.file && handleSelectFile(node.file as FileChange)}
              onToggle={handleToggle}
              cwd={cwd}
              showChanges={true}
              emptyMessage="无文件变更"
              className="py-1"
            />
          )}
        </div>

        {/* Diff view */}
        <div className="flex-1 overflow-hidden">
          {isLoadingDiff ? (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">加载差异中...</div>
          ) : fileDiff ? (
            <DiffView
              oldContent={fileDiff.oldContent}
              newContent={fileDiff.newContent}
              filePath={fileDiff.filePath}
              isNew={fileDiff.isNew}
              isDeleted={fileDiff.isDeleted}
              cwd={cwd}
              enableComments={true}
              onPreview={
                !fileDiff.isDeleted && fileDiff.filePath.endsWith('.json')
                  ? () => setJsonPreview({ content: fileDiff.newContent, filePath: fileDiff.filePath })
                  : undefined
              }
              previewLabel="可读"
              onContentSearch={onContentSearch}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
              选择文件查看差异
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const jsonPreviewModal = jsonPreview && (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setJsonPreview(null)}>
      <div
        className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90%] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
          <span className="text-sm text-muted-foreground font-mono truncate">{jsonPreview.filePath}</span>
          <button
            onClick={() => setJsonPreview(null)}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <JsonSearchBar search={commitJsonSearch} />
        <div className="flex-1 overflow-auto px-6 py-4 bg-[#0d1117]">
          <pre ref={commitPreRef} className="whitespace-pre-wrap break-words font-mono" style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}>
            {formatAsHumanReadable(jsonPreview.content)}
          </pre>
        </div>
      </div>
    </div>
  );

  // 内嵌模式：无 Modal 包装和标题栏，但右上角有关闭按钮
  if (embedded) {
    return (
      <div className="bg-card w-full h-full flex flex-col relative">
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-10 p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
          title="关闭"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {content}
        {jsonPreviewModal}
      </div>
    );
  }

  // Modal 模式
  return (
    <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose}>
      <div
        className="bg-card w-full h-full flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">提交详情</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        {content}
        {jsonPreviewModal}
      </div>
    </div>
  );
}
