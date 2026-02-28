'use client';

import { useState, useEffect, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { FileDiff, ListTodo, MessageCircleQuestion, Circle, Loader, CheckCircle2, ClipboardList } from 'lucide-react';
import { ChatMessage, MessageImage } from '@/types/chat';
import { ToolCallModal } from './ToolCallModal';
import { DiffViewerModal } from './DiffViewerModal';
import { TodoViewerModal } from './TodoViewerModal';
import { AskQuestionViewerModal } from './AskQuestionViewerModal';
import { PreviewModal } from './PreviewModal';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { toast } from '../shared/Toast';

interface ImageModalProps {
  image: MessageImage;
  onClose: () => void;
}

function ImageModal({ image, onClose }: ImageModalProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* 关闭按钮 */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* 图片 */}
      <img
        src={`data:${image.media_type};base64,${image.data}`}
        alt="图片预览"
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  // 客户端渲染时使用 Portal 到 body
  if (mounted) {
    return createPortal(modalContent, document.body);
  }

  return null;
}

interface MessageBubbleProps {
  message: ChatMessage;
  cwd?: string;
  sessionId?: string | null;
  onFork?: (messageId: string) => void;
}

// 工具调用折叠显示的阈值
const TOOL_CALLS_COLLAPSE_THRESHOLD = 3;

// 使用 memo 优化，只有当 message 或 cwd 变化时才重新渲染
export const MessageBubble = memo(function MessageBubble({ message, cwd, sessionId, onFork }: MessageBubbleProps) {
  const [previewImage, setPreviewImage] = useState<MessageImage | null>(null);
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showTodoViewer, setShowTodoViewer] = useState(false);
  const [showAskQuestionViewer, setShowAskQuestionViewer] = useState(false);
  const isUser = message.role === 'user';
  const hasImages = message.images && message.images.length > 0;
  const toolCallsCount = message.toolCalls?.length || 0;
  const shouldCollapseToolCalls = toolCallsCount > TOOL_CALLS_COLLAPSE_THRESHOLD;
  const canFork = !!sessionId && !!cwd && !!onFork;

  // 是否有 Edit/Write 工具调用
  const hasFileChanges = useMemo(() => {
    return message.toolCalls?.some(tc => tc.name === 'Edit' || tc.name === 'Write') || false;
  }, [message.toolCalls]);

  // 最后一个 TodoWrite 调用
  const lastTodoWrite = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      if (message.toolCalls[i].name === 'TodoWrite') return message.toolCalls[i];
    }
    return null;
  }, [message.toolCalls]);

  // 所有 AskUserQuestion 调用
  const askQuestionCalls = useMemo(() => {
    if (!message.toolCalls) return [];
    return message.toolCalls.filter(tc => tc.name === 'AskUserQuestion');
  }, [message.toolCalls]);

  // 最后一个写入 plan 文件的 Write 调用
  const lastPlanWrite = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      const tc = message.toolCalls[i];
      if (tc.name === 'Write') {
        const input = tc.input as { file_path?: string; content?: string };
        if (input.file_path?.includes('/.claude/plans/') && input.content) {
          return tc;
        }
      }
    }
    return null;
  }, [message.toolCalls]);
  const [showPlanPreview, setShowPlanPreview] = useState(false);

  // 复制消息内容
  const handleCopy = () => {
    if (message.content) {
      navigator.clipboard.writeText(message.content);
      toast('已复制消息');
    }
  };

  // Fork 会话（从此消息点分叉）
  const handleFork = () => {
    if (canFork) {
      onFork!(message.id);
    }
  };

  // 格式化时间：01-15 14:30
  const formatTime = (ts?: string) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  };

  const timeStr = formatTime(message.timestamp);

  return (
    <>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4 group`}>
        {/* 消息时间 - hover 时显示 */}
        {timeStr && (
          <span className="text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mb-0.5 px-1">
            {timeStr}
          </span>
        )}
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} w-full`}>
        {/* 用户消息的操作按钮在左边 */}
        {isUser && (
          <div className="self-start mt-2 mr-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {message.content && (
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title="复制消息"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            {canFork && (
              <button
                onClick={handleFork}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title="从此处分叉会话"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  {/* Git fork icon */}
                  <circle cx="12" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                  <path d="M12 12v3" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div
          className={`max-w-[80%] ${
            isUser
              ? 'bg-accent text-foreground border border-brand rounded-2xl rounded-br-md'
              : 'bg-accent text-foreground dark:text-slate-11 rounded-2xl rounded-bl-md'
          } px-4 py-2`}
        >
          {/* 图片内容 */}
          {hasImages && (
            <div className={`flex flex-wrap gap-2 ${message.content ? 'mb-2' : ''}`}>
              {message.images!.map((image, index) => (
                <div
                  key={index}
                  className="relative w-16 h-16 rounded-lg overflow-hidden border border-white/20 cursor-pointer hover:opacity-90 transition-opacity"
                  onClick={() => setPreviewImage(image)}
                >
                  <img
                    src={`data:${image.media_type};base64,${image.data}`}
                    alt={`图片 ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          )}

          {/* 文本内容 - 使用 Markdown 渲染 */}
          {message.content && (
            <div className="break-words">
              <MarkdownRenderer content={message.content} isUser={isUser} isStreaming={message.isStreaming} />
              {message.isStreaming && (
                <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
              )}
            </div>
          )}

          {/* 内联 Todo 展示 */}
          {lastTodoWrite && (() => {
            const todos = (lastTodoWrite.input?.todos as Array<{ content: string; status: string; activeForm?: string }>) || [];
            const completed = todos.filter(t => t.status === 'completed').length;
            const total = todos.length;
            return (
              <div
                className={`${message.content || hasImages ? 'mt-2' : ''} cursor-pointer`}
                onClick={() => setShowTodoViewer(true)}
              >
                <div className="border border-border rounded-lg overflow-hidden bg-secondary/50 px-3 py-2 space-y-1">
                  {/* Progress header */}
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className="flex-1 h-1 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all duration-300"
                        style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground flex-shrink-0">{completed}/{total}</span>
                  </div>
                  {/* Todo items */}
                  {todos.map((todo, i) => (
                    <div
                      key={i}
                      className={`flex items-center gap-1.5 ${
                        todo.status === 'completed' ? 'opacity-50' : ''
                      }`}
                    >
                      {todo.status === 'completed' ? (
                        <CheckCircle2 className="w-3 h-3 text-green-500 flex-shrink-0" />
                      ) : todo.status === 'in_progress' ? (
                        <Loader className="w-3 h-3 text-brand flex-shrink-0 animate-spin" />
                      ) : (
                        <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      )}
                      <span className={`text-xs truncate ${
                        todo.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'
                      }`}>
                        {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* 工具调用 */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className={`${message.content || hasImages ? 'mt-2' : ''}`}>
              {shouldCollapseToolCalls ? (
                // 折叠模式：显示摘要和展开按钮
                <div className="border border-border rounded-lg overflow-hidden bg-secondary">
                  <div className="flex items-center">
                    <button
                      onClick={() => setToolCallsExpanded(!toolCallsExpanded)}
                      className="flex-1 px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors active:bg-muted"
                    >
                      <span className="text-lg">🔧</span>
                      <span className="font-medium text-foreground">
                        {toolCallsCount} 个工具调用
                      </span>
                      <span className="ml-auto text-muted-foreground text-sm">
                        {toolCallsExpanded ? '▲ 收起' : '▼ 展开'}
                      </span>
                    </button>
                    {lastPlanWrite && (
                      <button
                        onClick={() => setShowPlanPreview(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title="查看计划"
                      >
                        <ClipboardList className="w-4 h-4" />
                      </button>
                    )}
                    {askQuestionCalls.length > 0 && (
                      <button
                        onClick={() => setShowAskQuestionViewer(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title="查看提问"
                      >
                        <MessageCircleQuestion className="w-4 h-4" />
                      </button>
                    )}
                    {lastTodoWrite && (
                      <button
                        onClick={() => setShowTodoViewer(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title="查看任务列表"
                      >
                        <ListTodo className="w-4 h-4" />
                      </button>
                    )}
                    {hasFileChanges && (
                      <button
                        onClick={() => setShowDiffViewer(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title="查看所有文件变更"
                      >
                        <FileDiff className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {toolCallsExpanded && (
                    <div className="border-t border-border p-2 space-y-1">
                      {message.toolCalls.map((toolCall, index) => (
                        <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                // 正常模式：直接显示所有工具调用
                message.toolCalls.map((toolCall, index) => (
                  <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} />
                ))
              )}
            </div>
          )}
        </div>
        {/* AI 消息的操作按钮在右边 */}
        {!isUser && (
          <div className="self-start mt-2 ml-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {message.content && (
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title="复制消息"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
            {canFork && (
              <button
                onClick={handleFork}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title="从此处分叉会话"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="18" r="3" />
                  <circle cx="6" cy="6" r="3" />
                  <circle cx="18" cy="6" r="3" />
                  <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
                  <path d="M12 12v3" />
                </svg>
              </button>
            )}
          </div>
        )}
        </div>
      </div>

      {/* 图片预览模态窗口 */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}

      {/* Diff 查看器 */}
      {showDiffViewer && message.toolCalls && (
        <DiffViewerModal toolCalls={message.toolCalls} cwd={cwd} onClose={() => setShowDiffViewer(false)} />
      )}

      {/* Todo 查看器 */}
      {showTodoViewer && lastTodoWrite && (
        <TodoViewerModal toolCall={lastTodoWrite} onClose={() => setShowTodoViewer(false)} />
      )}

      {/* AskQuestion 查看器 */}
      {showAskQuestionViewer && askQuestionCalls.length > 0 && (
        <AskQuestionViewerModal toolCalls={askQuestionCalls} onClose={() => setShowAskQuestionViewer(false)} />
      )}

      {/* Plan 预览 */}
      {showPlanPreview && lastPlanWrite && (
        <PreviewModal
          title={`Plan - ${((lastPlanWrite.input as { file_path?: string }).file_path || '').split('/').pop() || 'plan.md'}`}
          content={JSON.stringify(lastPlanWrite.input, null, 2)}
          toolName="Write"
          onClose={() => setShowPlanPreview(false)}
        />
      )}
    </>
  );
});
