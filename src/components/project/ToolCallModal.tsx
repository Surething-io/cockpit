'use client';

import { useState } from 'react';
import { ToolCallInfo } from '@/types/chat';
import { PreviewModal } from './PreviewModal';
import { toast } from '../shared/Toast';

// ============================================
// Tool icon mapping
// ============================================

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '✏️',
  Edit: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔍',
};

// ============================================
// ToolCallModal - tool call display component
// ============================================

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
}

export function ToolCallModal({ toolCall, cwd }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string; toolName: string } | null>(null);

  const toolIcon = TOOL_ICONS[toolCall.name] || '🔧';

  // Extract file path or key info from input
  const getDisplayInfo = () => {
    const input = toolCall.input;
    if (toolCall.name === 'Bash' && input.command && typeof input.command === 'string') {
      return input.command;
    }
    if (toolCall.name === 'Glob' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
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

  // Get path relative to cwd
  const getRelativePath = (fullPath: string) => {
    if (cwd && fullPath.startsWith(cwd)) {
      const relativePath = fullPath.slice(cwd.length);
      return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    }
    const parts = fullPath.split('/');
    if (parts.length > 2) {
      return '.../' + parts.slice(-2).join('/');
    }
    return fullPath;
  };

  const displayInfo = getDisplayInfo();
  const skipRelativePath = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'Bash';
  const displayPath = displayInfo ? (skipRelativePath ? displayInfo : getRelativePath(displayInfo)) : null;

  const openPreview = (type: 'input' | 'result') => {
    const suffix = type === 'input' ? '输入参数' : '结果';
    const content = type === 'input'
      ? JSON.stringify(toolCall.input, null, 2)
      : (typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2));
    setPreviewContent({
      title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''} - ${suffix}`,
      content,
      toolName: toolCall.name,
    });
  };

  return (
    <div className="my-2 border border-border rounded-lg overflow-hidden bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors"
      >
        <span className="text-base">{toolIcon}</span>
        <span className="font-medium text-sm text-foreground flex-shrink-0">
          {toolCall.name}
        </span>
        {displayPath && (
          <>
            <span
              className="text-xs text-muted-foreground truncate flex-1 min-w-0"
              title={displayInfo || ''}
            >
              {displayPath}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                if (displayInfo) {
                  navigator.clipboard.writeText(displayInfo);
                  toast('已复制路径');
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  if (displayInfo) {
                    navigator.clipboard.writeText(displayInfo);
                    toast('已复制路径');
                  }
                }
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0 cursor-pointer"
              title="复制绝对路径"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </span>
          </>
        )}
        {/* Right action area */}
        <span className="ml-auto flex items-center gap-2">
          {expanded && !toolCall.isLoading && (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); openPreview('input'); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('input'); } }}
                className="text-xs text-brand hover:text-teal-10 cursor-pointer"
                title="查看输入参数"
              >
                输入
              </span>
              {toolCall.result && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); openPreview('result'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('result'); } }}
                  className="text-xs text-brand hover:text-teal-10 cursor-pointer"
                  title="查看结果"
                >
                  结果
                </span>
              )}
            </>
          )}
          {toolCall.isLoading ? (
            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className="text-slate-9 text-xs">
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          <div className="px-3 py-2">
            <div className="mb-1">
              <span className="text-xs text-muted-foreground">输入参数:</span>
            </div>
            <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-border">
              <div className="mb-1">
                <span className="text-xs text-muted-foreground">结果:</span>
              </div>
              <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Preview modal */}
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
