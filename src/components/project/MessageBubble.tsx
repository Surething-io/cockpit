'use client';

import { useState, useEffect, useMemo, memo } from 'react';
import { Portal } from '../shared/Portal';
import { FileDiff, MessageCircleQuestion, Circle, Loader, CheckCircle2 } from 'lucide-react';
import { ChatMessage, MessageImage } from '@/types/chat';
import { ToolCallModal } from './ToolCallModal';
import { DiffViewerModal } from './DiffViewerModal';
import { AskQuestionViewerModal } from './AskQuestionViewerModal';
import { InteractiveMarkdownPreview } from './InteractiveMarkdownPreview';
import { MenuContainerProvider } from './FileContextMenu';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { toast } from '../shared/Toast';
import { useTranslation } from 'react-i18next';

interface ImageModalProps {
  image: MessageImage;
  onClose: () => void;
}

function ImageModal({ image, onClose }: ImageModalProps) {
  const { t } = useTranslation();

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>

      {/* Image */}
      <img
        src={`data:${image.media_type};base64,${image.data}`}
        alt={t('chat.imagePreview')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}

// MD preview modal — provides MenuContainerProvider so FloatingToolbar works correctly
// container uses a callback ref (i.e. useState setter): React calls it synchronously on mount, avoiding timing issues
function MdPreviewModal({ filePath, content, cwd, onClose }: {
  filePath: string; content: string; cwd: string;
  onClose: () => void;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div ref={setContainer} className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90vh] flex flex-col relative" onClick={e => e.stopPropagation()}>
        <MenuContainerProvider container={container}>
          <InteractiveMarkdownPreview
            content={content}
            filePath={filePath}
            cwd={cwd}
            onClose={onClose}
          />
        </MenuContainerProvider>
      </div>
    </div>
    </Portal>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  cwd?: string;
  sessionId?: string | null;
  onFork?: (messageId: string) => void;
}

// Threshold for collapsing tool calls
const TOOL_CALLS_COLLAPSE_THRESHOLD = 1;

// Use memo optimization — only re-render when message or cwd changes
export const MessageBubble = memo(function MessageBubble({ message, cwd, sessionId, onFork }: MessageBubbleProps) {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<MessageImage | null>(null);
  const [toolCallsExpanded, setToolCallsExpanded] = useState(false);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showAskQuestionViewer, setShowAskQuestionViewer] = useState(false);
  const isUser = message.role === 'user';
  const hasImages = message.images && message.images.length > 0;
  const toolCallsCount = message.toolCalls?.length || 0;
  const shouldCollapseToolCalls = toolCallsCount > TOOL_CALLS_COLLAPSE_THRESHOLD;
  const canFork = !!sessionId && !!cwd && !!onFork;

  // Whether there are Edit/Write tool calls
  const hasFileChanges = useMemo(() => {
    return message.toolCalls?.some(tc => tc.name === 'Edit' || tc.name === 'Write') || false;
  }, [message.toolCalls]);

  // Last TodoWrite call
  const lastTodoWrite = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      if (message.toolCalls[i].name === 'TodoWrite') return message.toolCalls[i];
    }
    return null;
  }, [message.toolCalls]);

  // All AskUserQuestion calls
  const askQuestionCalls = useMemo(() => {
    if (!message.toolCalls) return [];
    return message.toolCalls.filter(tc => tc.name === 'AskUserQuestion');
  }, [message.toolCalls]);

  // Extract deduplicated .md file paths from Read/Edit/Write tool calls
  const mdFiles = useMemo(() => {
    if (!message.toolCalls) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const tc of message.toolCalls) {
      if (tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') {
        const fp = (tc.input as { file_path?: string }).file_path;
        if (fp && fp.toLowerCase().endsWith('.md') && !seen.has(fp)) {
          seen.add(fp);
          result.push(fp);
        }
      }
    }
    return result;
  }, [message.toolCalls]);

  // Extract and parse thoughts from tool call inputs
  const thoughts = useMemo(() => {
    if (!message.toolCalls) return [];
    const result: Array<{ previous: string; current: string; expect: string; raw: string; toolName: string }> = [];
    for (const tc of message.toolCalls) {
      const thought = tc.input?.thought;
      if (thought && typeof thought === 'string') {
        // Parse "PREVIOUS: ... → THIS: ... → EXPECT: ..." format
        const match = thought.match(/PREVIOUS:\s*(.*?)\s*→\s*THIS:\s*(.*?)\s*→\s*EXPECT:\s*(.*)/i);
        if (match) {
          result.push({ previous: match[1].trim(), current: match[2].trim(), expect: match[3].trim(), raw: thought, toolName: tc.name });
        } else {
          result.push({ previous: '', current: thought, expect: '', raw: thought, toolName: tc.name });
        }
      }
    }
    return result;
  }, [message.toolCalls]);

  const [mdPreviewFile, setMdPreviewFile] = useState<string | null>(null);
  const [mdFileContent, setMdFileContent] = useState<string | null>(null);

  // Fetch content when an md file is selected
  useEffect(() => {
    if (!mdPreviewFile) { queueMicrotask(() => setMdFileContent(null)); return; }
    let cancelled = false;
    fetch(`/api/file?path=${encodeURIComponent(mdPreviewFile)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(d => { if (!cancelled) setMdFileContent(d.content); })
      .catch(() => { if (!cancelled) { toast(t('toast.readFileFailed'), 'error'); setMdPreviewFile(null); } });
    return () => { cancelled = true; };
  }, [mdPreviewFile]);


  // Copy message content
  const handleCopy = () => {
    if (message.content) {
      navigator.clipboard.writeText(message.content);
      toast(t('toast.copiedMessage'));
    }
  };

  // Fork session (branch from this message)
  const handleFork = () => {
    if (canFork) {
      onFork!(message.id);
    }
  };

  // Format time as: 01-15 14:30
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
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4 group`} data-role={message.role}>
        {/* Message timestamp — shown on hover */}
        {timeStr && (
          <span className="text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mb-0.5 px-1">
            {timeStr}
          </span>
        )}
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} w-full`}>
        {/* Action buttons for user messages — on the left */}
        {isUser && (
          <div className="self-start mt-2 mr-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {message.content && (
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title={t('chat.copyMessage')}
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
                title={t('chat.forkSession')}
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
          {/* Image content */}
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
                    alt={t('chat.imageN', { index: index + 1 })}
                    className="w-full h-full object-cover"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Text content — rendered as Markdown */}
          {message.content && (
            <div className="break-words">
              <MarkdownRenderer content={message.content} isUser={isUser} isStreaming={message.isStreaming} enableMath={false} />
              {message.isStreaming && (
                <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />
              )}
            </div>
          )}

          {/* Inline Todo display */}
          {lastTodoWrite && (() => {
            const rawTodos = lastTodoWrite.input?.todos;
            const todos = (Array.isArray(rawTodos) ? rawTodos : []) as Array<{ content: string; status: string; activeForm?: string }>;
            const completed = todos.filter(t => t.status === 'completed').length;
            const total = todos.length;
            return (
              <div
                className={`${message.content || hasImages ? 'mt-2' : ''}`}
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

          {/* MD file list */}
          {mdFiles.length > 0 && (
            <div className={`${message.content || hasImages || lastTodoWrite ? 'mt-2' : ''}`}>
              <div className="border border-border rounded-lg overflow-hidden bg-secondary/50 px-3 py-2 space-y-0.5">
                {mdFiles.map((fp) => (
                  <button
                    key={fp}
                    onClick={() => setMdPreviewFile(fp)}
                    className="flex items-center gap-1.5 w-full text-left hover:bg-accent rounded px-1 py-0.5 transition-colors group/md"
                  >
                    <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="text-xs text-muted-foreground group-hover/md:text-foreground truncate">
                      {fp.split('/').pop()}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Thoughts — extracted from tool call inputs, displayed as table */}
          {thoughts.length > 0 && (
            <div className={`${message.content || hasImages || lastTodoWrite || mdFiles.length > 0 ? 'mt-2' : ''}`}>
              <div className="border border-border rounded-lg overflow-hidden bg-secondary/50">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground">
                      <th className="px-2 py-1.5 text-left font-medium w-[60px]">Tool</th>
                      <th className="px-2 py-1.5 text-left font-medium">Previous</th>
                      <th className="px-2 py-1.5 text-left font-medium">Action</th>
                      <th className="px-2 py-1.5 text-left font-medium">Expect</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thoughts.map((t, i) => (
                      <tr key={i} className={i < thoughts.length - 1 ? 'border-b border-border/50' : ''}>
                        <td className="px-2 py-1 text-muted-foreground font-mono">{t.toolName}</td>
                        <td className="px-2 py-1 text-muted-foreground">{t.previous || '—'}</td>
                        <td className="px-2 py-1 text-foreground">{t.current}</td>
                        <td className="px-2 py-1 text-muted-foreground">{t.expect || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className={`${message.content || hasImages ? 'mt-2' : ''}`}>
              {shouldCollapseToolCalls ? (
                // Collapsed mode: show summary and expand button
                <div className="border border-border rounded-lg overflow-hidden bg-secondary">
                  <div className="flex items-center">
                    <button
                      onClick={() => setToolCallsExpanded(!toolCallsExpanded)}
                      className="flex-1 px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors active:bg-muted"
                    >
                      <span className="text-lg">🔧</span>
                      <span className="font-medium text-foreground">
                        {t('chat.toolCalls', { count: toolCallsCount })}
                      </span>
                      <span className="ml-auto text-muted-foreground text-sm">
                        {toolCallsExpanded ? t('chat.collapse') : t('chat.expand')}
                      </span>
                    </button>
                    {askQuestionCalls.length > 0 && (
                      <button
                        onClick={() => setShowAskQuestionViewer(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title={t('chat.viewQuestions')}
                      >
                        <MessageCircleQuestion className="w-4 h-4" />
                      </button>
                    )}
                    {hasFileChanges && (
                      <button
                        onClick={() => setShowDiffViewer(true)}
                        className="px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border"
                        title={t('chat.viewAllFileChanges')}
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
                // Normal mode: show all tool calls directly
                message.toolCalls.map((toolCall, index) => (
                  <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} />
                ))
              )}
            </div>
          )}
        </div>
        {/* Action buttons for AI messages — on the right */}
        {!isUser && (
          <div className="self-start mt-2 ml-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {message.content && (
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
                title={t('chat.copyMessage')}
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
                title={t('chat.forkSession')}
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

      {/* Image preview modal */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}

      {/* Diff viewer */}
      {showDiffViewer && message.toolCalls && (
        <DiffViewerModal toolCalls={message.toolCalls} cwd={cwd} onClose={() => setShowDiffViewer(false)} />
      )}

      {/* AskQuestion viewer */}
      {showAskQuestionViewer && askQuestionCalls.length > 0 && (
        <AskQuestionViewerModal toolCalls={askQuestionCalls} onClose={() => setShowAskQuestionViewer(false)} />
      )}

      {/* MD file interactive preview */}
      {mdPreviewFile && mdFileContent !== null && (
        <MdPreviewModal
          filePath={mdPreviewFile}
          content={mdFileContent}
          cwd={cwd || ''}
          onClose={() => setMdPreviewFile(null)}
        />
      )}
    </>
  );
});
