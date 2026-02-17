'use client';

import { useRef, useEffect, memo } from 'react';
import { Terminal } from 'lucide-react';
import { toast } from '../../shared/Toast';
import { AnsiUp } from 'ansi_up';

interface CommandBubbleProps {
  command: string;
  timestamp?: string;
  onDelete?: () => void;
}

interface ResultBubbleProps {
  output: string;
  exitCode?: number;
  isRunning: boolean;
  onInterrupt?: () => void;
  onDelete?: () => void;
  timestamp?: string;
}

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

// 命令气泡（右侧，用户样式）
export const CommandBubble = memo(function CommandBubble({ command, timestamp, onDelete }: CommandBubbleProps) {
  const timeStr = formatTime(timestamp);

  // 复制命令
  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    toast('已复制命令');
  };

  return (
    <div className="flex flex-col items-end mb-4">
      {/* 时间 - hover 时显示 */}
      {timeStr && (
        <span className="text-[11px] text-muted-foreground opacity-0 group-hover/cmd:opacity-100 transition-opacity mb-0.5 px-1">
          {timeStr}
        </span>
      )}
      <div className="flex justify-end w-full">
        {/* 操作按钮在左边 */}
        <div className="self-start mt-2 mr-1 flex flex-col gap-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            title="复制命令"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"
              title="删除记录"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>

        <div className="max-w-[80%] bg-accent text-foreground border border-brand rounded-2xl rounded-br-md px-4 py-2">
          <div className="flex items-start gap-2">
            <Terminal className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <pre className="text-sm font-mono whitespace-pre-wrap break-words">{command}</pre>
          </div>
        </div>
      </div>
    </div>
  );
});

// 结果气泡（左侧，助手样式）
export const ResultBubble = memo(function ResultBubble({
  output,
  exitCode,
  isRunning,
  onInterrupt,
  onDelete,
  timestamp,
}: ResultBubbleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const shouldAutoScroll = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const timeStr = formatTime(timestamp);

  // ANSI 解析器 & 增量追踪（用 ref 避免每帧重建）
  const ansiUpRef = useRef<AnsiUp | null>(null);
  const parsedLenRef = useRef(0);

  if (!ansiUpRef.current) {
    ansiUpRef.current = new AnsiUp();
    ansiUpRef.current.use_classes = true;
  }

  // 增量 DOM 更新：只对新增部分做 ANSI 解析，直接 append 到 <pre>
  useEffect(() => {
    const pre = preRef.current;
    if (!pre || !ansiUpRef.current) return;

    // 检测截断（行数限制导致 output 前缀被裁剪）
    if (output.length < parsedLenRef.current) {
      // 全量重置
      ansiUpRef.current = new AnsiUp();
      ansiUpRef.current.use_classes = true;
      parsedLenRef.current = 0;
      pre.innerHTML = '';
    }

    // 增量：只解析新增部分
    if (output.length > parsedLenRef.current) {
      const newPart = output.slice(parsedLenRef.current);
      const newHtml = ansiUpRef.current.ansi_to_html(newPart);
      parsedLenRef.current = output.length;

      // 用 insertAdjacentHTML 追加，不触发全量 DOM 重建
      pre.insertAdjacentHTML('beforeend', newHtml);
    }
  }, [output]);

  // 自动滚动到底部（仅运行时 + 用户未手动上滚）
  useEffect(() => {
    if (isRunning && shouldAutoScroll.current && scrollRef.current) {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }

      rafIdRef.current = requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
        rafIdRef.current = null;
      });
    }

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [output, isRunning]);

  // 监听用户滚动，如果用户主动滚动则停止自动滚动
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      shouldAutoScroll.current = isAtBottom;
    }
  };

  // 复制输出（去除 ANSI 转义码）
  const handleCopy = () => {
    // eslint-disable-next-line no-control-regex
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    navigator.clipboard.writeText(plain);
    toast('已复制输出');
  };

  return (
    <div className="flex flex-col items-start mb-4">
      {/* 时间 - hover 时显示 */}
      {timeStr && (
        <span className="text-[11px] text-muted-foreground opacity-0 group-hover/cmd:opacity-100 transition-opacity mb-0.5 px-1">
          {timeStr}
        </span>
      )}
      <div className="flex justify-start w-full">
        <div className="max-w-[80%] min-w-[40%] bg-accent text-foreground dark:text-slate-11 rounded-2xl rounded-bl-md">
          {/* 输出内容 */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="max-h-[1200px] overflow-y-auto px-4 py-2"
          >
            <pre ref={preRef} className="text-sm font-mono whitespace-pre-wrap break-words" />
          </div>

          {/* 底部状态栏 */}
          {(isRunning || exitCode !== undefined || onInterrupt) && (
            <div className="border-t border-border px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {isRunning ? (
                  <>
                    <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                    <span>运行中...</span>
                  </>
                ) : exitCode !== undefined ? (
                  <>
                    <span className={`inline-block w-2 h-2 rounded-full ${exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span>退出代码: {exitCode}</span>
                  </>
                ) : null}
              </div>

              {/* 中断按钮 */}
              {isRunning && onInterrupt && (
                <button
                  onClick={onInterrupt}
                  className="text-xs px-3 py-1 rounded-md font-medium bg-destructive text-destructive-foreground transition-all duration-150 hover:bg-destructive/80 hover:shadow-md active:scale-95 active:bg-destructive/70 cursor-pointer select-none"
                >
                  Ctrl+C
                </button>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮在右边 */}
        <div className="self-start mt-2 ml-1 flex flex-col gap-0.5 opacity-0 group-hover/cmd:opacity-100 transition-opacity">
          {output && (
            <button
              onClick={handleCopy}
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              title="复制输出"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-accent"
              title="删除记录"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
