'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { memo, useState, useMemo, ComponentPropsWithoutRef } from 'react';
import { useTheme } from './ThemeProvider';
import { MermaidBlock } from './MermaidBlock';

// Stable reference — avoid recreating on every render
const REMARK_PLUGINS = [remarkGfm];

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  isStreaming?: boolean;
  rehypePlugins?: any[];
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
function createMarkdownComponents(isDark: boolean, isStreaming?: boolean) {
  return {
    // 代码块 — node 来自 react-markdown passNode，需要析构掉避免传给 DOM
    code({ className, children, node, ...props }: ComponentPropsWithoutRef<'code'> & { className?: string; node?: any }) {
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

      // Mermaid 代码块：非流式时渲染图表，流式中显示代码
      if (language === 'mermaid' && !isStreaming) {
        return <MermaidBlock code={code} isDark={isDark} />;
      }

      // 从 HAST node 获取代码块在 markdown 源码中的行范围
      // ``` 围栏占首尾各一行，实际代码内容从 start+1 开始
      const prePosition = node?.position;
      const codeStartLine = prePosition ? prePosition.start.line + 1 : 0;

      return (
        <SyntaxHighlighter
          style={isDark ? oneDark : oneLight}
          language={language}
          PreTag="div"
          customStyle={{ margin: '0.75rem 0', borderRadius: '0.375rem', fontSize: '0.875rem' }}
          wrapLines
          lineProps={(lineNumber: number) => ({
            'data-source-start': codeStartLine + lineNumber - 1,
            'data-source-end': codeStartLine + lineNumber - 1,
            style: { display: 'block' },
          } as any)}
        >
          {code}
        </SyntaxHighlighter>
      );
    },
    // 以下所有自定义组件析构 node（react-markdown passNode）并展开 ...rest
    // 使得 rehypeSourceLines 注入的 data-source-start/end 属性能传递到 DOM
    p: ({ children, node, ...rest }: any) => <p className="mb-3 last:mb-0" {...rest}>{children}</p>,
    h1: ({ children, node, ...rest }: any) => <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0" {...rest}>{children}</h1>,
    h2: ({ children, node, ...rest }: any) => <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0" {...rest}>{children}</h2>,
    h3: ({ children, node, ...rest }: any) => <h3 className="text-base font-bold mb-2 mt-3 first:mt-0" {...rest}>{children}</h3>,
    ul: ({ children, node, ...rest }: any) => <ul className="list-disc list-inside mb-3 space-y-1" {...rest}>{children}</ul>,
    ol: ({ children, node, ...rest }: any) => <ol className="list-decimal list-inside mb-3 space-y-1" {...rest}>{children}</ol>,
    li: ({ children, node, ...rest }: any) => <li className="leading-relaxed" {...rest}>{children}</li>,
    blockquote: ({ children, node, ...rest }: any) => (
      <blockquote className="border-l-4 border-border pl-4 my-3 italic text-muted-foreground" {...rest}>{children}</blockquote>
    ),
    a: ({ href, children, node, ...rest }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline" {...rest}>{children}</a>
    ),
    table: ({ children, node, ...rest }: any) => (
      <div className="overflow-x-auto my-3" {...rest}><table className="min-w-full border border-border">{children}</table></div>
    ),
    thead: ({ children, node, ...rest }: any) => <thead className="bg-accent" {...rest}>{children}</thead>,
    th: ({ children, node, ...rest }: any) => (
      <th className="px-4 py-2 text-left font-semibold border-b border-border" {...rest}>{children}</th>
    ),
    td: ({ children, node, ...rest }: any) => (
      <td className="px-4 py-2 border-b border-border" {...rest}>{children}</td>
    ),
    hr: ({ node, ...rest }: any) => <hr className="my-4 border-border" {...rest} />,
    img: ({ src, alt, node, ...props }: any) => (
      <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg my-3" {...props} />
    ),
    strong: ({ children, node, ...rest }: any) => <strong className="font-bold" {...rest}>{children}</strong>,
    em: ({ children, node, ...rest }: any) => <em className="italic" {...rest}>{children}</em>,
    del: ({ children, node, ...rest }: any) => <del className="line-through" {...rest}>{children}</del>,
  };
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, isUser = false, isStreaming = false, rehypePlugins }: MarkdownRendererProps) {
  // 使用全局 Theme Context，避免每个组件都创建 MutationObserver
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Memoize components to keep stable references — prevents ReactMarkdown from
  // tearing down and recreating the entire DOM tree on parent re-renders
  const components = useMemo(() => createMarkdownComponents(isDark), [isDark]);
  const streamComponents = useMemo(() => createMarkdownComponents(isDark, true), [isDark]);

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
          remarkPlugins={REMARK_PLUGINS}
          components={streamComponents}
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
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

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
