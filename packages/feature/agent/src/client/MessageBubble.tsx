'use client';

import { useState, useEffect, useMemo, memo } from 'react';
import type { MouseEvent } from 'react';
import { Portal, toast } from '@cockpit/shared-ui';
import { Copy, FileDiff, MessageCircleQuestion, Circle, Loader, CheckCircle2, MessageSquareDashed, Scissors } from 'lucide-react';
import { ToolCallModal } from './ToolCallModal';
import { AskQuestionViewerModal } from './AskQuestionViewerModal';
import { DiffViewerModal, resolveDiffCalls } from './DiffViewerModal';
import { loadSnapshotsByToolIds } from './effect/snapshotClient';
import type { ChatMessage, MessageImage, ToolCallInfo } from './types';
import { isMutatingToolName } from '../shared/toolMutation';
// Tech debt: cross-package imports into the main shell.
//   - FileContextMenu: chat-adjacent code that hasn't migrated yet.
//   - MarkdownRenderer: a generic markdown renderer; candidate for shared-ui.
// Allowed by MODULES.md as transitional reverse imports.
import { HtmlPreviewModal, isMarkdownFile, isHtmlFile, isImageFile, resolveRelativePath } from '@cockpit/feature-explorer';
import { MarkdownRenderer } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { MdPreviewModal } from './MdPreviewModal';
import { readFileForPreview } from './effect/agentClient';
import { useTranslation } from 'react-i18next';

// Migrated from src/components/project/MessageBubble.tsx.

interface ImageModalProps {
  image: MessageImage;
  onClose: () => void;
}

function base64ToBlob(data: string, type: string): Blob {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function imageSrcToPngBlob(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode image'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

function imageMimeTypeFromPath(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.avif') return 'image/avif';
  return 'image/png';
}

async function writeImageToClipboard(blob: Blob, fallbackSrc: string) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image write is unavailable');
  }

  try {
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob }),
    ]);
    return;
  } catch (error) {
    if (blob.type === 'image/png') throw error;
  }

  const pngBlob = await imageSrcToPngBlob(fallbackSrc);
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': pngBlob }),
  ]);
}

function ImageModal({ image, onClose }: ImageModalProps) {
  const { t } = useTranslation();
  const src = `data:${image.media_type};base64,${image.data}`;

  const handleCopyImage = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await writeImageToClipboard(base64ToBlob(image.data, image.media_type), src);
      toast(t('chat.copiedImage'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopyImage}
          className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
          title={t('chat.copyImage')}
        >
          <Copy className="w-5 h-5" />
        </button>
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
          title={t('common.close')}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Image */}
      <img
        src={src}
        alt={t('chat.imagePreview')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}

// Image file preview modal — serves raw bytes via <img src> pointing at
// /api/file?raw=true (absolute path). No content is pulled into the JS heap.
function ImageFilePreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const { t } = useTranslation();
  const src = `/api/file?path=${encodeURIComponent(filePath)}&raw=true`;

  const handleCopyImage = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('Could not read image');
      const fetchedBlob = await res.blob();
      const blob = fetchedBlob.type
        ? fetchedBlob
        : new Blob([fetchedBlob], { type: imageMimeTypeFromPath(filePath) });
      await writeImageToClipboard(blob, src);
      toast(t('chat.copiedImage'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  };

  return (
    <Portal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopyImage}
            className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
            title={t('chat.copyImage')}
          >
            <Copy className="w-5 h-5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
            title={t('common.close')}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <img
          src={src}
          alt={filePath.split('/').pop()}
          className="max-w-[90vw] max-h-[90vh] object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </Portal>
  );
}

interface MessageBubbleProps {
  message: ChatMessage;
  cwd?: string;
  sessionId?: string | null;
  /**
   * Branch a new session off this message. `scope` picks how much comes along:
   * 'prefix' keeps the conversation up to this turn, 'single' keeps only this turn.
   */
  onFork?: (messageId: string, scope: 'prefix' | 'single') => void;
  /**
   * Whether a new session can be created in this engine's transcript store at all
   * (false for codex, whose CLI owns the store). A boolean rather than the engine itself,
   * so this memoized component keeps stable props.
   */
  forkSupported?: boolean;
  /** Plan mode: approve the plan card → turn off plan mode and resend to execute */
  onApprovePlan?: () => void;
  /** Disable the approve button while a run is streaming (no concurrent send) */
  isLoading?: boolean;
  /** Selected text → project-wide search (threads into the HTML preview toolbar) */
  onContentSearch?: (query: string) => void;
  /**
   * Show all file changes for this message in the Explorer panel (panel 2) and
   * auto-swipe there. When omitted (e.g. inside SubagentTranscriptModal, which
   * has no second panel), the button falls back to a local full-screen modal.
   */
  onShowFileDiff?: (toolCalls: ToolCallInfo[], cwd?: string, sessionId?: string) => void;
  /** AI reply Markdown local-file link → Explorer tree + optional line jump. */
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
}

function parseLocalFileLink(href: string, cwd?: string): { path: string; lineNumber?: number } | null {
  if (!href || href.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) return null;

  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* keep raw */ }
  if (decoded.startsWith('file://')) decoded = decoded.slice('file://'.length);

  const hashIdx = decoded.indexOf('#');
  const hash = hashIdx >= 0 ? decoded.slice(hashIdx + 1) : '';
  let pathPart = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;

  const queryIdx = pathPart.indexOf('?');
  const query = queryIdx >= 0 ? pathPart.slice(queryIdx + 1) : '';
  pathPart = queryIdx >= 0 ? pathPart.slice(0, queryIdx) : pathPart;

  let lineNumber: number | undefined;
  const hashLine = hash.match(/^L?(\d+)(?:-L?\d+)?$/i)?.[1];
  const queryLine = query.match(/(?:^|[&;])(?:line|L)=(\d+)(?:$|[&;])/i)?.[1];
  const suffixLineMatch = pathPart.match(/:(\d+)(?::\d+)?$/);
  const lineText = hashLine || queryLine || suffixLineMatch?.[1];
  if (lineText) {
    lineNumber = Number(lineText);
    if (suffixLineMatch) pathPart = pathPart.slice(0, -suffixLineMatch[0].length);
  }

  pathPart = pathPart.trim();
  if (!pathPart) return null;
  if (cwd && pathPart.startsWith(cwd + '/')) pathPart = pathPart.slice(cwd.length + 1);
  else if (cwd && pathPart === cwd) return null;
  else if (pathPart.startsWith('/')) pathPart = pathPart.slice(1);

  const looksLocal =
    pathPart.startsWith('./') ||
    pathPart.startsWith('../') ||
    pathPart.includes('/') ||
    /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pathPart);
  if (!looksLocal) return null;

  return {
    path: resolveRelativePath('', pathPart),
    ...(lineNumber && lineNumber > 0 ? { lineNumber } : {}),
  };
}

// Threshold for collapsing tool calls — any tool call (≥1) renders inside a collapsible header,
// so special operation entries (AskUserQuestion / FileDiff) on the header are always reachable.
const TOOL_CALLS_COLLAPSE_THRESHOLD = 0;

/**
 * One text segment of an assistant turn.
 *
 * `isAside` marks mid-turn narration — a segment the model emitted before going
 * back to tool calls ("Both red. Now the fixes."), as opposed to the turn's
 * actual answer, which is always the final segment. Without the distinction a
 * turn reads as one uninterrupted monologue with no way to tell the running
 * commentary from the conclusion.
 *
 * memo'd, and this matters more than the usual reason: a turn now renders one
 * row per segment, so a streaming delta re-renders ONLY the trailing row. The
 * old single-blob renderer re-parsed the whole turn's markdown on every token.
 */
const TextPartRow = memo(function TextPartRow({
  text,
  isAside,
  isUser,
  isStreaming,
  onOpenFileLink,
  cwd,
}: {
  text: string;
  isAside: boolean;
  isUser: boolean;
  isStreaming: boolean;
  onOpenFileLink?: (target: { path: string; lineNumber?: number }) => void;
  cwd?: string;
}) {
  const handleLinkClick = useMemo(() => {
    if (isUser || !onOpenFileLink) return undefined;
    return (href: string) => {
      const target = parseLocalFileLink(href, cwd);
      if (!target) return false;
      onOpenFileLink(target);
      return true;
    };
  }, [cwd, isUser, onOpenFileLink]);

  const body = (
    <>
      <MarkdownRenderer content={text} isUser={isUser} isStreaming={isStreaming} enableMath={false} onLinkClick={handleLinkClick} />
      {isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-current animate-pulse" />}
    </>
  );

  if (!isAside) return <div className="break-words">{body}</div>;

  return (
    <div className="flex gap-1.5 break-words opacity-65">
      <MessageSquareDashed className="w-3 h-3 mt-[5px] shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex-1 min-w-0">{body}</div>
    </div>
  );
});

// Use memo optimization — only re-render when message or cwd changes
export const MessageBubble = memo(function MessageBubble({ message, cwd, sessionId, onFork, forkSupported = true, onApprovePlan, isLoading, onContentSearch, onShowFileDiff, onOpenFileLink }: MessageBubbleProps) {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<MessageImage | null>(null);
  // Single-tool case: default expanded so the content stays visible (we only need the header for special entries).
  // Multi-tool case: default collapsed (preserves existing behavior).
  const [toolCallsExpanded, setToolCallsExpanded] = useState(() => (message.toolCalls?.length || 0) === 1);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showAskQuestionViewer, setShowAskQuestionViewer] = useState(false);
  const [showEventDetail, setShowEventDetail] = useState(false);
  const isUser = message.role === 'user';
  const hasImages = message.images && message.images.length > 0;
  const toolCallsCount = message.toolCalls?.length || 0;
  const shouldCollapseToolCalls = toolCallsCount > TOOL_CALLS_COLLAPSE_THRESHOLD;
  const canFork = !!sessionId && !!cwd && !!onFork && forkSupported;

  // Whether this message contains tool calls that may have touched files.
  // Shares the READ_ONLY deny-list with the server-side snapshot hook (single
  // source of truth) — Task subagents, MCP tools and Bash all snapshot server-
  // side, so they all get the diff entry here too.
  const hasFileChanges = useMemo(() => {
    return message.toolCalls?.some(tc => isMutatingToolName(tc.name)) || false;
  }, [message.toolCalls]);

  // Text segments of this turn, each tagged with whether a tool call follows it
  // (⇒ mid-turn narration rather than the answer). `parts` is the ordered
  // skeleton the reducer/parsers build; see shared/assistantText.ts.
  //
  // Messages without it — user bubbles, optimistically inserted sends, system
  // rows — degrade to a single non-aside segment, i.e. exactly the DOM this
  // component rendered before parts existed.
  const textParts = useMemo(() => {
    const parts = message.parts;
    if (!parts?.length) return message.content ? [{ text: message.content, isAside: false }] : [];
    let lastToolIndex = -1;
    parts.forEach((p, i) => { if (p.type === 'tool') lastToolIndex = i; });
    const out: Array<{ text: string; isAside: boolean }> = [];
    parts.forEach((p, i) => {
      if (p.type === 'text') out.push({ text: p.text, isAside: i < lastToolIndex });
    });
    return out;
  }, [message.parts, message.content]);

  // Whether the FileDiff icon should show at all. We resolve emptiness at
  // RENDER time (not on click) so a message with zero real changes never shows
  // a dead button. Two cheap signals, no per-file diff fetch:
  //   1. Edit/Write can be reconstructed straight from tool params (0 requests)
  //      — resolveDiffCalls([], …) degenerates to that fallback.
  //   2. Otherwise the shadow-git commit LIST answers it: the snapshot hook
  //      skips zero-change commits, so any commit for these tool ids ⇒ real
  //      changes. The list endpoint returns metadata only (no diff bodies).
  const paramsHaveChanges = useMemo(
    () => resolveDiffCalls([], message.toolCalls ?? [], cwd).length > 0,
    [message.toolCalls, cwd],
  );
  const [snapshotHasChanges, setSnapshotHasChanges] = useState(false);
  const showFileDiff = paramsHaveChanges || snapshotHasChanges;

  useEffect(() => {
    // Params already prove non-empty, or nothing mutating / no cwd to query.
    if (!hasFileChanges || paramsHaveChanges || !cwd) return;
    const toolIds = (message.toolCalls ?? []).map(tc => tc.id).filter(Boolean);
    if (toolIds.length === 0) return;
    // Snapshot writes are fire-and-forget after tool_result. Bash/Codex and
    // other mutating tools often have no file params to fall back to, so a
    // single early list query can race the commit and hide the entry forever.
    const snapshotBackedIds = (message.toolCalls ?? [])
      .filter(tc => isMutatingToolName(tc.name))
      .map(tc => tc.id);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const check = () => {
      BrowserRuntime.runPromiseExit(loadSnapshotsByToolIds(cwd, toolIds, sessionId ?? undefined)).then((exit) => {
        if (cancelled) return;
        const commits = exit._tag === 'Success' ? exit.value : [];
        if (commits.length > 0) {
          setSnapshotHasChanges(true);
          return;
        }
        const landed = new Set(commits.map(c => c.toolId));
        const pending = snapshotBackedIds.some(id => !landed.has(id));
        if (pending && attempt < 2) {
          attempt += 1;
          timer = setTimeout(check, 2000);
        }
      });
    };
    check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [hasFileChanges, paramsHaveChanges, cwd, sessionId, message.toolCalls]);

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

  // Last ExitPlanMode call → render its plan as a card (plan mode). The plan markdown
  // lives in the tool-use input (`input.plan`); the tool result is an auto-deny in
  // plan-only mode, so we surface the plan here instead of as a failed tool entry.
  const planCard = useMemo(() => {
    if (!message.toolCalls) return null;
    for (let i = message.toolCalls.length - 1; i >= 0; i--) {
      if (message.toolCalls[i].name === 'ExitPlanMode') {
        const plan = (message.toolCalls[i].input as { plan?: string })?.plan;
        return typeof plan === 'string' && plan ? plan : null;
      }
    }
    return null;
  }, [message.toolCalls]);

  // Tool calls shown in the generic list — ExitPlanMode is surfaced as a plan card
  // above instead of a (failed-looking) tool entry.
  const displayToolCalls = useMemo(
    () => message.toolCalls?.filter(tc => tc.name !== 'ExitPlanMode') ?? [],
    [message.toolCalls]
  );

  // Extract deduplicated previewable paths (.md / .html / .htm / images) from
  // Read/Edit/Write tool calls. Single-click opens an in-modal preview.
  const docFiles = useMemo(() => {
    if (!message.toolCalls) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const tc of message.toolCalls) {
      if (tc.name === 'Read' || tc.name === 'Edit' || tc.name === 'Write') {
        const fp = (tc.input as { file_path?: string }).file_path;
        if (fp && (isMarkdownFile(fp) || isHtmlFile(fp) || isImageFile(fp)) && !seen.has(fp)) {
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

  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);

  // Fetch content when a doc file (md / html) is selected. Images are served
  // as raw bytes via <img src>, so they skip this text-content fetch.
  useEffect(() => {
    if (!previewFile || isImageFile(previewFile)) { queueMicrotask(() => setPreviewContent(null)); return; }
    let cancelled = false;
    BrowserRuntime.runPromiseExit(readFileForPreview(previewFile)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success' && exit.value.content !== undefined) {
        setPreviewContent(exit.value.content);
      } else {
        toast(t('toast.readFileFailed'), 'error');
        setPreviewFile(null);
      }
    });
    return () => { cancelled = true; };
  }, [previewFile, t]);


  // Copy message content
  const handleCopy = () => {
    if (message.content) {
      navigator.clipboard.writeText(message.content);
      toast(t('toast.copiedMessage'));
    }
  };

  // Fork session (branch from this message, keeping the conversation up to here)
  const handleFork = () => {
    if (canFork) {
      onFork!(message.id, 'prefix');
    }
  };

  // Excerpt this single turn (this message's question + answer) into a new session,
  // dropping everything before it. Works from either bubble of the turn — the server
  // rewinds an assistant uuid back to the user message that opened it.
  const handleExcerpt = () => {
    if (canFork) {
      onFork!(message.id, 'single');
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

  // System-event row (task-notification / meta): a muted one-line bar, not a
  // conversation bubble. Kept after all hooks so hook order stays stable.
  if (message.role === 'system') {
    const ev = message.systemEvent;
    const icon =
      ev?.kind === 'task-notification'
        ? ev.status === 'failed'
          ? '⚠️'
          : ev.status === 'stopped'
            ? '⏹️'
            : '🔔'
        : 'ℹ️';
    // Full text for the detail modal — the raw <task-notification> block, or the
    // message content itself (image annotation / compact-summary notice).
    const detail = ev?.detail || message.content;
    return (
      <>
        <div className="flex justify-center my-2 px-2" data-role="system">
          <button
            type="button"
            onClick={() => setShowEventDetail(true)}
            className="flex items-center gap-1.5 max-w-[85%] text-[11px] text-muted-foreground bg-secondary/40 border border-border/50 rounded-full px-3 py-1 hover:bg-secondary hover:text-foreground transition-colors cursor-pointer"
            title={t('chat.viewDetails', { defaultValue: 'Click for details' })}
          >
            <span className="flex-shrink-0">{icon}</span>
            <span className="truncate">{message.content}</span>
          </button>
        </div>
        {showEventDetail && (
          <Portal>
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
              onClick={() => setShowEventDetail(false)}
            >
              <div
                className="bg-card shadow-lv3 w-full max-w-4xl max-h-[80vh] rounded-lg flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
                  <span className="text-sm text-foreground flex items-center gap-1.5">
                    <span>{icon}</span>
                    {ev?.kind === 'task-notification'
                      ? t('chat.taskNotification', { defaultValue: 'Task notification' })
                      : t('chat.systemNotice', { defaultValue: 'Notice' })}
                  </span>
                  <button
                    onClick={() => setShowEventDetail(false)}
                    className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors"
                  >
                    ✕
                  </button>
                </div>
                <pre className="flex-1 overflow-auto px-4 py-3 text-xs text-foreground whitespace-pre-wrap break-words">
                  {detail}
                </pre>
              </div>
            </div>
          </Portal>
        )}
      </>
    );
  }

  return (
    <>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} mb-4 group`} data-role={message.role}>
        {/* Message timestamp — shown on hover */}
        {timeStr && (
          <span className="text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mb-0.5 px-1">
            {timeStr}
          </span>
        )}
        {/* items-start is load-bearing: the hover action buttons flanking the bubble are a
            `flex flex-col` of up to three icons (~84px tall) and, being `opacity-0` rather
            than unmounted, they occupy that height at ALL times. Without it the bubble
            defaults to `align-self: stretch` and is dragged to the buttons' height, so a
            short message ("hi") renders as a tall pill with its text pinned to the top and
            dead space below. Both sides have such a column, so this fixes user and
            assistant bubbles alike. */}
        <div className={`flex items-start ${isUser ? 'justify-end' : 'justify-start'} w-full`}>
        {/* Action buttons for user messages — on the left */}
        {isUser && (
          <div className="self-start mt-2 mr-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {message.content && (
              <button
                onClick={handleCopy}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
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
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
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
            {canFork && (
              <button
                onClick={handleExcerpt}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
                title={t('chat.excerptTurn')}
              >
                <Scissors className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        {/* One skin for both sides: --muted, the QUIETEST step of the fill
         * ladder, and no border. Enough to seat a turn as its own shape
         * without becoming a surface that everything inside has to climb out
         * of. Side is carried by alignment and the flipped corner alone — the
         * user bubble used to add a brand-coloured border on top of a louder
         * fill, which read as a highlighted/selected state rather than as
         * "this one is mine".
         *
         * That choice is what sets the fills nested inside it. The tool-call
         * group and its rows carry no fill at all, and the code blocks inside
         * an expanded row take --accent — one step up, so they still read as a
         * distinct kind of content against a --muted turn rather than
         * disappearing into it. Two layers total, one step apart.
         *
         * The loud skin is what had to go, not the box. An assistant turn carries
         * markdown, code blocks and a tool-call list, and each of those wants a
         * surface of its own; a fill on the turn itself made every one of them
         * a NESTED fill. Because the fills are alpha they compound, and with
         * --accent on the turn plus --secondary on the group, the row and the
         * code block, a code block inside an expanded tool row bottomed out at
         * rgb(179,179,198) on a white page — 2.06:1 against the page it was
         * meant to sit quietly on. Unfilling the group and the rows and
         * dropping the turn to --muted lands the same code block on
         * rgb(231,231,236), 1.23:1.
         *
         * max-w-[80%] is the width mechanism on purpose: a fixed reading
         * column (52rem, centered) was tried here and reverted, and the two do
         * not compose — a percentage inside a fixed column just multiplies
         * down to a narrower measure than either was aiming for.
         */}
        <div
          className={`max-w-[80%] px-4 py-2 rounded-2xl bg-muted text-foreground ${
            isUser ? 'rounded-br-md' : 'rounded-bl-md'
          }`}
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

          {/* Text content — one row per segment. space-y-3 reproduces the gap the
              segments used to get as sibling <p>s inside one document (p is mb-3,
              last:mb-0), so splitting the blob costs no vertical rhythm. */}
          {textParts.length > 0 && (
            <div className="space-y-3">
              {textParts.map((part, i) => (
                <TextPartRow
                  key={i}
                  text={part.text}
                  isAside={part.isAside}
                  isUser={isUser}
                  isStreaming={!!message.isStreaming && i === textParts.length - 1}
                  onOpenFileLink={onOpenFileLink}
                  cwd={cwd}
                />
              ))}
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
                <div className="border border-border rounded-lg overflow-hidden px-3 py-2 space-y-1">
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
                        <CheckCircle2 className="w-3 h-3 text-green-11 flex-shrink-0" />
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

          {/* Inline plan card (plan mode — ExitPlanMode). Plan-only: read this, then
              uncheck Plan mode and resend to implement. */}
          {planCard && (
            <div className={`${message.content || hasImages || lastTodoWrite ? 'mt-2' : ''}`}>
              <div className="border border-brand/40 rounded-lg overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-brand/10">
                  <span className="text-sm">📋</span>
                  <span className="text-xs font-medium text-foreground">
                    {t('chat.planTitle', { defaultValue: 'Plan (awaiting your review)' })}
                  </span>
                </div>
                <div className="px-3 py-2">
                  <MarkdownRenderer content={planCard} isUser={false} enableMath={false} />
                </div>
                {/* Approve & run: the in-UI replacement for the (non-existent) "Exit plan
                    mode?" approval dialog. Turns off plan mode and resends to execute.
                    Disabled while a run streams (one active run per session). */}
                {onApprovePlan && (
                  <div className="px-3 py-2 border-t border-border flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {t('chat.planApproveHint', { defaultValue: '本环境无审批弹窗，点此退出 Plan 并执行' })}
                    </span>
                    <button
                      onClick={() => onApprovePlan()}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
                    >
                      <span>✓</span>
                      <span>{t('chat.approvePlan', { defaultValue: '批准并执行' })}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Previewable doc list (md / html) */}
          {docFiles.length > 0 && (
            <div className={`${message.content || hasImages || lastTodoWrite ? 'mt-2' : ''}`}>
              <div className="border border-border rounded-lg overflow-hidden px-3 py-2 space-y-0.5">
                {docFiles.map((fp) => (
                  <button
                    key={fp}
                    onClick={() => setPreviewFile(fp)}
                    className="flex items-center gap-1.5 w-full text-left hover:bg-hover rounded px-1 py-0.5 transition-colors group/md"
                  >
                    {isImageFile(fp) ? (
                      // Image — picture glyph
                      <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5z" />
                        <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4-4 3 3 4-4 5 5" />
                      </svg>
                    ) : isHtmlFile(fp) ? (
                      // HTML — code/`</>` glyph to distinguish from markdown docs
                      <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                      </svg>
                    ) : (
                      // Markdown — document glyph
                      <svg className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    )}
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
            <div className={`${message.content || hasImages || lastTodoWrite || docFiles.length > 0 ? 'mt-2' : ''}`}>
              <div className="border border-border rounded-lg overflow-hidden">
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
          {displayToolCalls.length > 0 && (
            <div className={`${message.content || hasImages ? 'mt-3' : ''}`}>
              {shouldCollapseToolCalls ? (
                // Collapsed mode: show summary and expand button
                // A frame, but still no fill. Unboxed entirely, this list ran
                // straight into the prose above it with nothing but a wrench
                // emoji marking the boundary. A border re-establishes that
                // boundary without re-introducing a nested surface — lines do
                // not compound the way alpha fills do, which is the whole
                // reason the fill did not come back with it.
                //
                // border-border here against border-line-1 between the rows:
                // the frame is the stronger edge because it separates the
                // group from everything around it, while the row dividers only
                // separate peers inside it.
                <div className="border border-border rounded-lg overflow-hidden">
                  <div className="flex items-center">
                    <button
                      onClick={() => setToolCallsExpanded(!toolCallsExpanded)}
                      className="flex-1 px-3 py-1.5 flex items-center gap-2 text-left hover:bg-hover transition-colors active:bg-muted"
                    >
                      <span className="text-sm">🔧</span>
                      <span className="font-medium text-foreground">
                        {t('chat.toolCalls', { count: displayToolCalls.length })}
                      </span>
                      <span className="ml-auto text-muted-foreground text-sm">
                        {toolCallsExpanded ? t('chat.collapse') : t('chat.expand')}
                      </span>
                    </button>
                    {askQuestionCalls.length > 0 && (
                      <button
                        onClick={() => setShowAskQuestionViewer(true)}
                        className="px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-hover transition-colors border-l border-line-1"
                        title={t('chat.viewQuestions')}
                      >
                        <MessageCircleQuestion className="w-4 h-4" />
                      </button>
                    )}
                    {showFileDiff && (
                      <button
                        onClick={() => {
                          // Prefer showing the diff in the Explorer panel (panel 2)
                          // with an auto-swipe; fall back to a local modal when no
                          // panel host is available (e.g. subagent transcript).
                          if (onShowFileDiff && message.toolCalls) {
                            onShowFileDiff(message.toolCalls, cwd, sessionId ?? undefined);
                          } else {
                            setShowDiffViewer(true);
                          }
                        }}
                        className="px-3 py-1.5 text-muted-foreground hover:text-foreground hover:bg-hover transition-colors border-l border-line-1"
                        title={t('chat.viewAllFileChanges')}
                      >
                        <FileDiff className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {toolCallsExpanded && (
                    // No space-y: rows are divider-separated list items now, so
                    // the gap belongs to their own padding. The old space-y-1
                    // also doubled up with a my-1 on each row.
                    <div className="border-t border-line-1">
                      {displayToolCalls.map((toolCall, index) => (
                        <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} sessionId={sessionId} />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                // Normal mode: show all tool calls directly
                displayToolCalls.map((toolCall, index) => (
                  <ToolCallModal key={`${toolCall.id}-${index}`} toolCall={toolCall} cwd={cwd} sessionId={sessionId} />
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
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
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
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
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
            {canFork && (
              <button
                onClick={handleExcerpt}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
                title={t('chat.excerptTurn')}
              >
                <Scissors className="w-4 h-4" />
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
        <DiffViewerModal toolCalls={message.toolCalls} cwd={cwd} sessionId={sessionId ?? undefined} onClose={() => setShowDiffViewer(false)} onContentSearch={onContentSearch} />
      )}

      {/* AskQuestion viewer */}
      {showAskQuestionViewer && askQuestionCalls.length > 0 && (
        <AskQuestionViewerModal toolCalls={askQuestionCalls} onClose={() => setShowAskQuestionViewer(false)} />
      )}

      {/* File preview — image via raw <img src>, html in a same-origin iframe
          with the bash SDK (i.e. previewing it runs it), md via the rich preview */}
      {previewFile && isImageFile(previewFile) && (
        <ImageFilePreviewModal filePath={previewFile} onClose={() => setPreviewFile(null)} />
      )}
      {previewFile && !isImageFile(previewFile) && previewContent !== null && (
        isHtmlFile(previewFile) ? (
          <HtmlPreviewModal
            filePath={previewFile}
            content={previewContent}
            cwd={cwd}
            onClose={() => setPreviewFile(null)}
            onContentSearch={onContentSearch}
          />
        ) : (
          <MdPreviewModal
            filePath={previewFile}
            content={previewContent}
            cwd={cwd || ''}
            onClose={() => setPreviewFile(null)}
          />
        )
      )}
    </>
  );
});
