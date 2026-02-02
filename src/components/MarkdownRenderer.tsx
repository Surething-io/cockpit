'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState, useMemo, ComponentPropsWithoutRef } from 'react';
import { useTheme } from './ThemeProvider';

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  isStreaming?: boolean;
}

/**
 * 检测文本是否为 Markdown 表格
 * 特征：包含 |---|、|:--|、|--:| 等分隔行
 */
function isMarkdownTable(text: string): boolean {
  // Markdown 表格分隔行：| --- | 或 |:---| 或 |---:| 等
  return /^\|[\s:|-]+\|$/m.test(text);
}

/**
 * 检测文本是否包含 ASCII 图表
 * 检测特征：
 * 1. Unicode box-drawing 字符（┌┐└┘│─ 等）
 * 2. ASCII 边框模式（+---+ 等）
 * 3. 多行竖线模式（至少 3 行以 | 开头或结尾，但排除 Markdown 表格）
 */
function hasAsciiArt(text: string): boolean {
  // 排除 Markdown 表格
  if (isMarkdownTable(text)) {
    return false;
  }

  // Unicode box-drawing 字符
  if (/[┌┐└┘│─├┤┬┴┼╔╗╚╝║═╭╮╯╰▲▼◀▶△▽◁▷]/.test(text)) {
    return true;
  }

  // ASCII 边框模式: +---+ 或 +===+
  if (/\+[-=]{2,}\+/.test(text)) {
    return true;
  }

  // 多行竖线模式：至少 3 行以 | 开头或结尾
  const lines = text.split('\n');
  const pipeLines = lines.filter(line => /^\s*\||\|\s*$/.test(line));
  if (pipeLines.length >= 3) {
    return true;
  }

  return false;
}

/**
 * 预处理内容：将包含 ASCII 图表的内容整体包裹为代码块
 * 简化策略：如果检测到 ASCII 图表特征，整个内容用 <pre> 渲染
 */
function preprocessAsciiArt(content: string): string {
  if (!hasAsciiArt(content)) {
    return content;
  }

  // 如果内容已经是代码块，不重复包裹
  if (/^```[\s\S]*```$/m.test(content.trim())) {
    return content;
  }

  // 整个内容包裹为代码块
  return '```text\n' + content.trim() + '\n```';
}

// 提取 Markdown 组件配置，避免重复定义
function createMarkdownComponents(isDark: boolean) {
  return {
    // 代码块
    code({ className, children, ...props }: ComponentPropsWithoutRef<'code'> & { className?: string }) {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children);
      const isInline = !match && !className && !codeString.includes('\n');

      if (isInline) {
        return (
          <code className="px-1.5 py-0.5 mx-0.5 rounded bg-accent text-sm font-mono" {...props}>
            {children}
          </code>
        );
      }

      const code = String(children).replace(/\n$/, '');
      const language = match?.[1] || 'text';
      return (
        <SyntaxHighlighter
          style={isDark ? oneDark : oneLight}
          language={language}
          PreTag="div"
          customStyle={{ margin: '0.75rem 0', borderRadius: '0.375rem', fontSize: '0.875rem' }}
        >
          {code}
        </SyntaxHighlighter>
      );
    },
    p: ({ children }: { children?: React.ReactNode }) => <p className="mb-3 last:mb-0">{children}</p>,
    h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>,
    h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
    h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h3>,
    ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>,
    ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>,
    li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
    blockquote: ({ children }: { children?: React.ReactNode }) => (
      <blockquote className="border-l-4 border-border pl-4 my-3 italic text-muted-foreground">{children}</blockquote>
    ),
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">{children}</a>
    ),
    table: ({ children }: { children?: React.ReactNode }) => (
      <div className="overflow-x-auto my-3"><table className="min-w-full border border-border">{children}</table></div>
    ),
    thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-accent">{children}</thead>,
    th: ({ children }: { children?: React.ReactNode }) => (
      <th className="px-4 py-2 text-left font-semibold border-b border-border">{children}</th>
    ),
    td: ({ children }: { children?: React.ReactNode }) => (
      <td className="px-4 py-2 border-b border-border">{children}</td>
    ),
    hr: () => <hr className="my-4 border-border" />,
    img: ({ src, alt, ...props }: ComponentPropsWithoutRef<'img'>) => (
      <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg my-3" {...props} />
    ),
    strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-bold">{children}</strong>,
    em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
    del: ({ children }: { children?: React.ReactNode }) => <del className="line-through">{children}</del>,
  };
}

export function MarkdownRenderer({ content, isUser = false, isStreaming = false }: MarkdownRendererProps) {
  // 使用全局 Theme Context，避免每个组件都创建 MutationObserver
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // 流式结束后或历史消息，检测并预处理 ASCII 图表
  const processedContent = useMemo(() => {
    // 用户消息或流式中不处理
    if (isUser || isStreaming) {
      return content;
    }
    return preprocessAsciiArt(content);
  }, [content, isUser, isStreaming]);

  // 用户消息使用简化样式
  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  // 流式输出中：已完成的行用 Markdown 渲染，最后一行用纯文本（避免频繁重解析）
  if (isStreaming) {
    const lastNewlineIndex = content.lastIndexOf('\n');

    // 没有换行符，全部用纯文本
    if (lastNewlineIndex === -1) {
      return <div className="whitespace-pre-wrap break-words">{content}</div>;
    }

    // 分割为已完成行和当前行
    const completedLines = content.slice(0, lastNewlineIndex + 1);
    const currentLine = content.slice(lastNewlineIndex + 1);

    return (
      <div className="markdown-body">
        {/* 已完成的行用 Markdown 渲染 */}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={createMarkdownComponents(isDark)}
        >
          {completedLines}
        </ReactMarkdown>
        {/* 当前正在输入的行用纯文本 */}
        {currentLine && (
          <span className="whitespace-pre-wrap">{currentLine}</span>
        )}
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={createMarkdownComponents(isDark)}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}

// 复制按钮组件
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      console.error('Failed to copy');
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  );
}
