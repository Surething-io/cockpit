'use client';

import React, { useState } from 'react';
import { ToolCallInfo } from '@/types/chat';

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
            {indentStr}  <span className="font-bold text-gray-900 dark:text-gray-100">[{i}]</span>: {formatValueHumanReadable(item, indent + 1)}
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
            {indentStr}  <span className="font-bold text-gray-900 dark:text-gray-100">{k}</span>: {formatValueHumanReadable(v, indent + 1)}
            {i < entries.length - 1 ? '\n' : ''}
          </span>
        ))}
        {'\n' + indentStr + '}'}
      </>
    );
  }

  return String(value);
}

// 预览模态窗口组件
interface PreviewModalProps {
  title: string;
  content: string;
  onClose: () => void;
}

function PreviewModal({ title, content, onClose }: PreviewModalProps) {
  const isJson = isValidJson(content);
  const [humanReadable, setHumanReadable] = useState(isJson); // 默认开启可读模式

  const displayContent: React.ReactNode = isJson
    ? (humanReadable ? formatAsHumanReadable(content) : formatAsJson(content))
    : content;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
          <div className="flex items-center gap-3">
            {/* 人类可读切换开关 */}
            {isJson && (
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500 dark:text-gray-400">可读模式</span>
                <button
                  onClick={() => setHumanReadable(!humanReadable)}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    humanReadable ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      humanReadable ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </label>
            )}
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <pre className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
            {displayContent}
          </pre>
        </div>
      </div>
    </div>
  );
}

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
}

export function ToolCall({ toolCall, cwd }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string } | null>(null);

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

  // 从 input 中提取文件路径（用于 Read, Write, Edit 等工具）
  const getFilePath = () => {
    const input = toolCall.input;
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

  const filePath = getFilePath();

  return (
    <div className="my-2 border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span className="text-base">{getToolIcon(toolCall.name)}</span>
        <span className="font-medium text-sm text-gray-700 dark:text-gray-300">
          {toolCall.name}
        </span>
        {filePath && (
          <span
            className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate max-w-[300px]"
            title={filePath}
          >
            {getRelativePath(filePath)}
          </span>
        )}
        {toolCall.isLoading && (
          <span className="ml-auto">
            <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </span>
        )}
        {!toolCall.isLoading && (
          <span className="ml-auto text-gray-400 text-xs">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-600">
          <div className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">输入参数:</span>
              <button
                onClick={() => setPreviewContent({ title: `${toolCall.name} - 输入参数`, content: JSON.stringify(toolCall.input, null, 2) })}
                className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
              >
                查看全部
              </button>
            </div>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-gray-700 dark:text-gray-300">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 dark:text-gray-400">结果:</span>
                <button
                  onClick={() => setPreviewContent({ title: `${toolCall.name} - 结果`, content: toolCall.result || '' })}
                  className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  查看全部
                </button>
              </div>
              <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-gray-700 dark:text-gray-300">
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
          onClose={() => setPreviewContent(null)}
        />
      )}
    </div>
  );
}
