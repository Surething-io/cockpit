'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChatMessage, MessageImage } from '@/types/chat';
import { ToolCallModal } from './ToolCallModal';
import { MarkdownRenderer } from './MarkdownRenderer';

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
}

// 工具调用折叠显示的阈值
const TOOL_CALLS_COLLAPSE_THRESHOLD = 3;

export function MessageBubble({ message, cwd }: MessageBubbleProps) {
  const [previewImage, setPreviewImage] = useState<MessageImage | null>(null);
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const isUser = message.role === 'user';
  const hasImages = message.images && message.images.length > 0;
  const toolCallsCount = message.toolCalls?.length || 0;
  const shouldCollapseToolCalls = toolCallsCount > TOOL_CALLS_COLLAPSE_THRESHOLD;

  return (
    <>
      <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
        <div
          className={`max-w-[80%] ${
            isUser
              ? 'bg-accent text-foreground border border-brand rounded-2xl rounded-br-md'
              : 'bg-accent text-foreground rounded-2xl rounded-bl-md'
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

          {/* 工具调用 */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className={`${message.content || hasImages ? 'mt-2' : ''}`}>
              {shouldCollapseToolCalls ? (
                // 折叠模式：显示摘要和展开按钮
                <div className="border border-border rounded-lg overflow-hidden bg-secondary">
                  <button
                    onClick={() => setToolCallsExpanded(!toolCallsExpanded)}
                    className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors active:bg-muted"
                  >
                    <span className="text-lg">🔧</span>
                    <span className="font-medium text-foreground">
                      {toolCallsCount} 个工具调用
                    </span>
                    <span className="ml-auto text-muted-foreground text-sm">
                      {toolCallsExpanded ? '▲ 收起' : '▼ 展开'}
                    </span>
                  </button>
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
      </div>

      {/* 图片预览模态窗口 */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </>
  );
}
