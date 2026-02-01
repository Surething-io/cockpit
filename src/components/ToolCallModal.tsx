'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ToolCallInfo } from '@/types/chat';
import { DiffView, DiffUnifiedView } from './DiffView';
import { CodeViewer } from './CodeViewer';

// 检查是否是有效的 JSON
function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

// 格式化为 JSON（美化显示）
function formatAsJson(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

// 格式化为人类可读格式（将 \n 转换为实际换行）
function formatAsHumanReadable(content: string): React.ReactNode {
  try {
    const parsed = JSON.parse(content);
    return formatValueHumanReadable(parsed, 0);
  } catch {
    return content;
  }
}

// 递归格式化值为人类可读格式，返回 React 节点
function formatValueHumanReadable(value: unknown, indent: number): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    // 将 \n 转换为实际换行，并添加适当缩进
    return value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      <>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {indentStr}  <span className="font-bold text-foreground">[{i}]</span>: {formatValueHumanReadable(item, indent + 1)}
            {i < value.length - 1 ? '\n' : ''}
          </span>
        ))}
        {'\n' + indentStr + ']'}
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return (
      <>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {indentStr}  <span className="font-bold text-foreground">{k}</span>: {formatValueHumanReadable(v, indent + 1)}
            {i < entries.length - 1 ? '\n' : ''}
          </span>
        ))}
        {'\n' + indentStr + '}'}
      </>
    );
  }

  return String(value);
}

// 检测是否是 Edit 工具的输入（包含 old_string 和 new_string）
interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function isEditInput(content: string): EditInput | null {
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed.file_path === 'string' &&
      typeof parsed.old_string === 'string' &&
      typeof parsed.new_string === 'string'
    ) {
      return parsed as EditInput;
    }
  } catch {
    // ignore
  }
  return null;
}


// 从 JSON 中提取 file_path
function getFilePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.file_path === 'string') {
      return parsed.file_path;
    }
  } catch {
    // ignore
  }
  return null;
}

// 文件预览组件 - 使用统一的 CodeViewer
function FilePreview({ filePath }: { filePath: string }) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 防止 StrictMode 下重复请求
  const fetchingRef = useRef(false);

  useEffect(() => {
    // 防止重复请求
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const loadFile = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.statusText}`);
        }
        const data = await response.json();
        setFileContent(data.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    };
    loadFile();
  }, [filePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-red-11">{error}</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  if (!fileContent) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">No content</span>
      </div>
    );
  }

  return (
    <CodeViewer
      content={fileContent}
      filePath={filePath}
      showLineNumbers={true}
      showSearch={true}
      className="h-full"
    />
  );
}

// 预览模态窗口组件
interface PreviewModalProps {
  title: string;
  content: string;
  toolName?: string;
  onClose: () => void;
}

type ViewMode = 'readable' | 'json' | 'diff-unified' | 'diff-split' | 'file';

function PreviewModal({ title, content, toolName, onClose }: PreviewModalProps) {
  const isJson = isValidJson(content);
  const editInput = isEditInput(content);
  const filePath = getFilePath(content);
  const hasDiffMode = !!editInput;
  const hasFileMode = !!filePath;
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null);

  // 默认模式：Read/Write 工具默认 file 模式，Edit 工具默认 diff 模式，其他用可读模式
  const getDefaultMode = (): ViewMode => {
    if ((toolName === 'Read' || toolName === 'Write') && hasFileMode) return 'file';
    if (hasDiffMode) return 'diff-split';
    if (isJson) return 'readable';
    return 'json';
  };

  const [viewMode, setViewMode] = useState<ViewMode>(getDefaultMode());

  // 获取 Portal 容器（Chat 屏幕）
  useEffect(() => {
    const container = document.getElementById('chat-screen');
    setPortalContainer(container);
  }, []);

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 移除焦点，避免关闭后焦点停留在按钮上
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const renderContent = () => {
    if (viewMode === 'file' && filePath) {
      return <FilePreview filePath={filePath} />;
    }
    if (viewMode === 'diff-unified' && editInput) {
      return <DiffUnifiedView oldContent={editInput.old_string} newContent={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'diff-split' && editInput) {
      return <DiffView oldContent={editInput.old_string} newContent={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'readable' && isJson) {
      return (
        <pre className="font-mono text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
          {formatAsHumanReadable(content)}
        </pre>
      );
    }
    return (
      <pre className="font-mono text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
        {isJson ? formatAsJson(content) : content}
      </pre>
    );
  };

  // Split 模式使用更宽的窗口
  const modalWidth = viewMode === 'diff-split' ? 'max-w-[90%]' : 'max-w-[90%]';

  const modalContent = (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-card rounded-lg shadow-xl w-full ${modalWidth} h-[90%] flex flex-col transition-all`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          <div className="flex items-center gap-3">
            {/* 视图模式切换 */}
            {isJson && (
              <div className="flex items-center gap-1 bg-accent rounded p-0.5">
                {hasDiffMode && (
                  <>
                    <button
                      onClick={() => setViewMode('diff-split')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-split'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title="并列对比"
                    >
                      Split
                    </button>
                    <button
                      onClick={() => setViewMode('diff-unified')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-unified'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title="统一对比"
                    >
                      Unified
                    </button>
                  </>
                )}
                {hasFileMode && (
                  <button
                    onClick={() => setViewMode('file')}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === 'file'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title="预览文件"
                  >
                    File
                  </button>
                )}
                <button
                  onClick={() => setViewMode('readable')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'readable'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  可读
                </button>
                <button
                  onClick={() => setViewMode('json')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'json'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  JSON
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );

  // 使用 Portal 渲染到 Chat 屏幕容器，如果容器不存在则回退到 body
  if (portalContainer) {
    return createPortal(modalContent, portalContainer);
  }

  // 回退：直接渲染（fixed 定位到整个视口）
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-card rounded-lg shadow-xl w-full ${modalWidth} h-[90vh] flex flex-col transition-all`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
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
        <div className="flex-1 overflow-auto p-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
}

export function ToolCallModal({ toolCall, cwd }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string; toolName: string } | null>(null);

  const getToolIcon = (name: string) => {
    const icons: Record<string, string> = {
      Read: '📄',
      Write: '✏️',
      Edit: '📝',
      Bash: '💻',
      Glob: '🔍',
      Grep: '🔎',
      WebFetch: '🌐',
      WebSearch: '🔍',
    };
    return icons[name] || '🔧';
  };

  // 从 input 中提取文件路径或关键信息（用于 Read, Write, Edit, Glob, Bash 等工具）
  const getDisplayInfo = () => {
    const input = toolCall.input;
    // Bash 工具展示 command
    if (toolCall.name === 'Bash' && input.command && typeof input.command === 'string') {
      return input.command;
    }
    // Glob 工具展示 pattern
    if (toolCall.name === 'Glob' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    // Grep 工具展示 pattern
    if (toolCall.name === 'Grep' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    if (input.file_path && typeof input.file_path === 'string') {
      return input.file_path;
    }
    if (input.path && typeof input.path === 'string') {
      return input.path;
    }
    return null;
  };

  // 获取相对于 cwd 的路径
  const getRelativePath = (fullPath: string) => {
    if (cwd && fullPath.startsWith(cwd)) {
      // 去掉 cwd 前缀，返回相对路径
      const relativePath = fullPath.slice(cwd.length);
      // 去掉开头的 /
      return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    }
    // 如果不在 cwd 下，显示最后两级路径
    const parts = fullPath.split('/');
    if (parts.length > 2) {
      return '.../' + parts.slice(-2).join('/');
    }
    return fullPath;
  };

  const displayInfo = getDisplayInfo();
  // Bash, Glob 和 Grep 不需要转换为相对路径
  const skipRelativePath = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'Bash';
  // 用于显示的相对路径（标题栏等）
  const displayPath = displayInfo ? (skipRelativePath ? displayInfo : getRelativePath(displayInfo)) : null;

  return (
    <div className="my-2 border border-border rounded-lg overflow-hidden bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors"
      >
        <span className="text-base">{getToolIcon(toolCall.name)}</span>
        <span className="font-medium text-sm text-foreground flex-shrink-0">
          {toolCall.name}
        </span>
        {displayPath && (
          <span
            className="text-xs text-muted-foreground font-mono truncate flex-1 min-w-0"
            title={displayInfo || ''}
          >
            {displayPath}
          </span>
        )}
        {toolCall.isLoading && (
          <span className="ml-auto">
            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </span>
        )}
        {!toolCall.isLoading && (
          <span className="ml-auto text-slate-9 text-xs">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border">
          <div className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">输入参数:</span>
              <button
                onClick={() => setPreviewContent({ title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''}`, content: JSON.stringify(toolCall.input, null, 2), toolName: toolCall.name })}
                className="text-xs text-brand hover:text-teal-10"
              >
                查看全部
              </button>
            </div>
            <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-border">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">结果:</span>
                <button
                  onClick={() => setPreviewContent({ title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''}`, content: toolCall.result || '', toolName: toolCall.name })}
                  className="text-xs text-brand hover:text-teal-10"
                >
                  查看全部
                </button>
              </div>
              <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 预览模态窗口 */}
      {previewContent && (
        <PreviewModal
          title={previewContent.title}
          content={previewContent.content}
          toolName={previewContent.toolName}
          onClose={() => setPreviewContent(null)}
        />
      )}
    </div>
  );
}
