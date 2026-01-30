'use client';

import { useState } from 'react';
import { ToolCallInfo } from '@/types/chat';

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
}

export function ToolCall({ toolCall, cwd }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);

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
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">输入参数:</div>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto text-gray-700 dark:text-gray-300">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">结果:</div>
              <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto text-gray-700 dark:text-gray-300">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
