'use client';

import { useRef, useEffect, useLayoutEffect, memo, useState } from 'react';
import { Terminal, Maximize2, Copy, X, RotateCw } from 'lucide-react';
import { toast } from '../../shared/Toast';
import { AnsiUp } from 'ansi_up';
import { OutputViewerModal } from './OutputViewerModal';

interface CommandBubbleProps {
  command: string;
  output: string;
  exitCode?: number;
  isRunning: boolean;
  onInterrupt?: () => void;
  onStdin?: (data: string) => void;
  onDelete?: () => void;
  onRerun?: () => void;
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

// 控制键映射表
const CTRL_KEY_MAP: Record<string, string> = {
  c: '\x03', // SIGINT
  d: '\x04', // EOF
  z: '\x1a', // SIGTSTP
  l: '\x0c', // clear
  a: '\x01', // home
  e: '\x05', // end
  u: '\x15', // kill line
  w: '\x17', // kill word
};

export const CommandBubble = memo(function CommandBubble({
  command,
  output,
  exitCode,
  isRunning,
  onInterrupt,
  onStdin,
  onDelete,
  onRerun,
  timestamp,
}: CommandBubbleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const shouldAutoScroll = useRef(true);
  const rafIdRef = useRef<number | null>(null);
  const stdinRef = useRef<HTMLInputElement>(null);
  const mouseDownIsSelect = useRef(false);
  const timeStr = formatTime(timestamp);
  const [showViewer, setShowViewer] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [stdinValue, setStdinValue] = useState('');

  // ANSI 解析器 & 增量追踪（用 ref 避免每帧重建）
  const ansiUpRef = useRef<AnsiUp | null>(null);
  const parsedLenRef = useRef(0);

  if (!ansiUpRef.current) {
    ansiUpRef.current = new AnsiUp();
    ansiUpRef.current.use_classes = true;
  }

  // 增量 DOM 更新：只对新增部分做 ANSI 解析，直接 append 到 <pre>
  // 使用 useLayoutEffect 避免重运行时闪烁（在浏览器绘制前同步清空旧内容）
  useLayoutEffect(() => {
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

    // 检测是否溢出，并始终滚动到底部显示 tail
    if (scrollRef.current) {
      const overflow = scrollRef.current.scrollHeight > scrollRef.current.clientHeight;
      setIsOverflowing(overflow);
      if (overflow) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
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

  const lineCount = output ? output.split('\n').length : 0;

  return (
    <div className="flex flex-col items-start mb-4">
      {/* 时间 - hover 时显示 */}
      {timeStr && (
        <span className="text-[11px] text-muted-foreground opacity-0 group-hover/cmd:opacity-100 transition-opacity mb-0.5 px-1">
          {timeStr}
        </span>
      )}
        <div className="w-full bg-accent text-foreground dark:text-slate-11 rounded-2xl rounded-bl-md relative overflow-hidden border border-brand">
          {/* 命令行头部 */}
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-brand text-xs">
            <Terminal className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            <span
              className="font-mono text-foreground truncate flex-1 cursor-pointer"
              onClick={() => output && setShowViewer(true)}
            >{command}</span>
            {isOverflowing && !isRunning && (
              <span className="text-muted-foreground flex-shrink-0">共 {lineCount} 行</span>
            )}
            {output && (
              <button
                onClick={handleCopy}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="复制输出"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            )}
            {output && (
              <button
                onClick={() => setShowViewer(true)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="查看全部输出"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
            {onRerun && (
              <button
                onClick={onRerun}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                title="重新运行"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="p-0.5 rounded text-destructive hover:text-destructive/80 transition-colors flex-shrink-0"
                title="删除记录"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {/* 输出内容：点击放大，拖选文本不触发 */}
          <div
            ref={scrollRef}
            className="max-h-[600px] overflow-hidden px-4 py-2 cursor-pointer"
            onMouseDown={() => { mouseDownIsSelect.current = false; }}
            onMouseMove={() => { mouseDownIsSelect.current = true; }}
            onClick={() => {
              if (mouseDownIsSelect.current) return;
              if (window.getSelection()?.toString()) return;
              output && setShowViewer(true);
            }}
          >
            <pre ref={preRef} className="text-sm font-mono whitespace-pre-wrap break-words select-text" />
          </div>

          {/* 运行中：stdin 输入 + 中断按钮 */}
          {isRunning && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2">
              <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse flex-shrink-0" />
              {onStdin ? (
                <input
                  ref={stdinRef}
                  value={stdinValue}
                  onChange={(e) => setStdinValue(e.target.value)}
                  onKeyDown={(e) => {
                    // Ctrl+组合键 → 发送控制字符
                    if (e.ctrlKey && !e.metaKey && !e.altKey) {
                      const ctrl = CTRL_KEY_MAP[e.key.toLowerCase()];
                      if (ctrl) {
                        e.preventDefault();
                        e.stopPropagation();
                        onStdin(ctrl);
                        return;
                      }
                    }
                    // Enter → 发送文本 + 换行
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      onStdin(stdinValue + '\n');
                      setStdinValue('');
                    }
                    // Tab → 发送 \t
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      onStdin('\t');
                    }
                  }}
                  placeholder="stdin 输入..."
                  className="flex-1 min-w-0 bg-transparent text-xs font-mono text-foreground outline-none placeholder:text-muted-foreground"
                  autoComplete="off"
                  spellCheck="false"
                />
              ) : (
                <span className="text-xs text-muted-foreground">运行中...</span>
              )}
              {onInterrupt && (
                <button
                  onClick={onInterrupt}
                  className="flex-shrink-0 text-xs px-3 py-1 rounded-md font-medium bg-destructive text-destructive-foreground transition-all duration-150 hover:bg-destructive/80 hover:shadow-md active:scale-95 active:bg-destructive/70 cursor-pointer select-none"
                >
                  Ctrl+C
                </button>
              )}
            </div>
          )}

          {/* 已结束：退出代码 */}
          {!isRunning && exitCode !== undefined && (
            <div className="border-t border-border px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full ${exitCode === 0 ? 'bg-green-500' : 'bg-red-500'}`} />
              <span>退出代码: {exitCode}</span>
            </div>
          )}
        </div>

      {/* 输出查看器 Modal */}
      {showViewer && (
        <OutputViewerModal
          output={output}
          isRunning={isRunning}
          onClose={() => setShowViewer(false)}
        />
      )}
    </div>
  );
});
