'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkAlert } from 'remark-github-blockquote-alert';
import rehypeRaw from 'rehype-raw';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import 'remark-github-blockquote-alert/alert.css';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { memo, useMemo, ComponentPropsWithoutRef } from 'react';
import type { PluggableList } from 'unified';
import type { ExtraProps } from 'react-markdown';
import { useTheme } from './ThemeProvider';
import { MermaidBlock } from './MermaidBlock';

// Stable reference — avoid recreating on every render
const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkAlert];
const REMARK_PLUGINS_NO_MATH = [remarkGfm, remarkAlert];
const REHYPE_PLUGINS_BASE = [rehypeRaw, rehypeKatex];
const REHYPE_PLUGINS_NO_MATH = [rehypeRaw];

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
  isStreaming?: boolean;
  enableMath?: boolean;
  rehypePlugins?: PluggableList;
}

/**
 * Detect whether text is a Markdown table.
 * Characteristic: contains separator lines like |---|, |:--|, |--:|, etc.
 */
function isMarkdownTable(text: string): boolean {
  // Markdown table separator row: | --- | or |:---| or |---:| etc.
  return /^\|[\s:|-]+\|$/m.test(text);
}

/**
 * Detect whether text contains ASCII art.
 * Detection criteria:
 * 1. Unicode box-drawing characters (┌┐└┘│─ etc.)
 * 2. ASCII border patterns (+---+ etc.)
 * 3. Multi-line pipe patterns (at least 3 lines starting or ending with |, excluding Markdown tables)
 */
function hasAsciiArt(text: string): boolean {
  // Exclude Markdown tables
  if (isMarkdownTable(text)) {
    return false;
  }

  // Unicode box-drawing characters
  if (/[┌┐└┘│─├┤┬┴┼╔╗╚╝║═╭╮╯╰▲▼◀▶△▽◁▷]/.test(text)) {
    return true;
  }

  // ASCII border pattern: +---+ or +===+
  if (/\+[-=]{2,}\+/.test(text)) {
    return true;
  }

  // Multi-line pipe pattern: at least 3 lines starting or ending with |
  const lines = text.split('\n');
  const pipeLines = lines.filter(line => /^\s*\||\|\s*$/.test(line));
  if (pipeLines.length >= 3) {
    // Exclude table pattern: table rows have a consistent | count (same column count) with at least 2 columns (3 pipes)
    // e.g. | col1 | col2 | has 3 |, ASCII art like |  box  | only has 2
    const pipeCounts = pipeLines.map(line => (line.match(/\|/g) || []).length);
    const allSame = pipeCounts.every(c => c === pipeCounts[0]);
    if (allSame && pipeCounts[0] >= 3) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Pre-process table rows: escape | characters inside backticks.
 * remark-gfm does not skip | inside code spans when splitting table columns,
 * causing `|` to be treated as a column separator — pre-process by escaping to \|.
 *
 * GFM table parse order: first split columns by | (\| is treated as escaped, not a separator),
 * then inline-parse each column's content (backtick → code span).
 * Replacing | inside code spans with \| makes the table-parse phase consume \,
 * leaving only | in the code span at inline-parse time, rendering correctly.
 */
function escapeTablePipes(content: string): string {
  return content.replace(/^(\|.+\|)$/gm, (line) => {
    // Skip separator rows (only -, :, |, spaces)
    if (/^\|[\s:|-]+\|$/.test(line)) return line;
    // Replace | inside backticks with \| (GFM table pipe escaping)
    return line.replace(/`([^`]*)`/g, (match, inner) => {
      if (!inner.includes('|')) return match;
      return '`' + inner.replace(/\|/g, '\\|') + '`';
    });
  });
}

/**
 * Escape dollar signs that represent currency, not math delimiters.
 * Pattern: $ immediately followed by a digit (e.g. $500, $1,000, $500亿).
 * Replaces $ → \$ so remark-math won't treat it as inline math.
 */
function escapeCurrencyDollars(content: string): string {
  return content.replace(/\$(\d)/g, '\\$$1');
}

/**
 * Pre-process content: wrap ASCII-art-containing content in a code block.
 * Simplified strategy: if ASCII art is detected, render the entire content as <pre>.
 */
function preprocessAsciiArt(content: string): string {
  if (!hasAsciiArt(content)) {
    return content;
  }

  // If content is already a code block, don't wrap again
  if (/^```[\s\S]*```$/m.test(content.trim())) {
    return content;
  }

  // Wrap the entire content in a code block
  return '```text\n' + content.trim() + '\n```';
}

// Extract Markdown component config to avoid redefining on each render
function createMarkdownComponents(isDark: boolean, isStreaming?: boolean) {
  return {
    // Code block — node comes from react-markdown passNode, destructure to avoid passing to DOM
    code({ className, children, node: _node, ...props }: ComponentPropsWithoutRef<'code'> & ExtraProps & { className?: string }) {
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

      // Mermaid code block: render diagram when not streaming, show code while streaming
      if (language === 'mermaid' && !isStreaming) {
        return <MermaidBlock code={code} isDark={isDark} />;
      }

      // Get line range of <pre> from data-source-start injected by rehypeSourceLines onto <code>
      // (node.position on <code> itself is inconsistent with <pre> and unreliable)
      // The ``` fences each occupy one line, so actual code starts at start+1
      const preSourceStart = Number((props as Record<string, unknown>)['data-source-start']) || 0;
      const codeStartLine = preSourceStart ? preSourceStart + 1 : 0;
      // lineNumber param in lineProps is always false when showLineNumbers=false (library bug),
      // use a closure counter to track line numbers manually
      let lineCounter = 0;

      return (
        <SyntaxHighlighter
          style={isDark ? oneDark : oneLight}
          language={language}
          PreTag="div"
          customStyle={{ margin: '0.75rem 0', borderRadius: '0.375rem', fontSize: '0.875rem' }}
          wrapLines
          lineProps={() => {
            const sourceLine = codeStartLine + lineCounter;
            lineCounter++;
            return {
              'data-source-start': sourceLine,
              'data-source-end': sourceLine,
              style: { display: 'block' },
            } as React.HTMLProps<HTMLElement>;
          }}
        >
          {code}
        </SyntaxHighlighter>
      );
    },
    // All custom components below destructure node (react-markdown passNode) and spread ...rest
    // so that data-source-start/end attributes injected by rehypeSourceLines are forwarded to the DOM
    p: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'p'> & ExtraProps) => <p className="mb-3 last:mb-0" {...rest}>{children}</p>,
    h1: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'h1'> & ExtraProps) => <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0" {...rest}>{children}</h1>,
    h2: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'h2'> & ExtraProps) => <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0" {...rest}>{children}</h2>,
    h3: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'h3'> & ExtraProps) => <h3 className="text-base font-bold mb-2 mt-3 first:mt-0" {...rest}>{children}</h3>,
    ul: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'ul'> & ExtraProps) => <ul className="list-disc list-inside mb-3 space-y-1" {...rest}>{children}</ul>,
    ol: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'ol'> & ExtraProps) => <ol className="list-decimal list-inside mb-3 space-y-1" {...rest}>{children}</ol>,
    li: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'li'> & ExtraProps) => <li className="leading-relaxed" {...rest}>{children}</li>,
    blockquote: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'blockquote'> & ExtraProps) => (
      <blockquote className="border-l-4 border-border pl-4 my-3 italic text-muted-foreground" {...rest}>{children}</blockquote>
    ),
    a: ({ href, children, node: _node, ...rest }: ComponentPropsWithoutRef<'a'> & ExtraProps) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline" {...rest}>{children}</a>
    ),
    table: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'table'> & ExtraProps) => (
      <div className="overflow-x-auto my-3" {...rest}><table className="min-w-full border border-border">{children}</table></div>
    ),
    thead: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'thead'> & ExtraProps) => <thead className="bg-accent" {...rest}>{children}</thead>,
    th: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'th'> & ExtraProps) => (
      <th className="px-4 py-2 text-left font-semibold border-b border-border" {...rest}>{children}</th>
    ),
    td: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'td'> & ExtraProps) => (
      <td className="px-4 py-2 border-b border-border" {...rest}>{children}</td>
    ),
    hr: ({ node: _node, ...rest }: ComponentPropsWithoutRef<'hr'> & ExtraProps) => <hr className="my-4 border-border" {...rest} />,
    img: ({ src, alt, node: _node, height, width, style, ...props }: ComponentPropsWithoutRef<'img'> & ExtraProps) => {
      // HTML <img> with explicit dimensions (e.g. <img height="28">): preserve original size, display inline
      // height/width must be converted to inline style, otherwise overridden by Tailwind preflight's img { height: auto }
      const hasExplicitSize = height || width || style;
      if (!hasExplicitSize) {
        return <img src={src} alt={alt || ''} className="max-w-full h-auto rounded-lg my-3" {...props} />;
      }
      const px = (v: string | number | undefined) => v ? (/^\d+$/.test(String(v)) ? `${v}px` : String(v)) : undefined;
      const mergedStyle = { ...style, height: px(height) ?? style?.height, width: px(width) ?? style?.width };
      return <img src={src} alt={alt || ''} style={mergedStyle} className="inline-block align-middle" {...props} />;
    },
    strong: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'strong'> & ExtraProps) => <strong className="font-bold" {...rest}>{children}</strong>,
    em: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'em'> & ExtraProps) => <em className="italic" {...rest}>{children}</em>,
    del: ({ children, node: _node, ...rest }: ComponentPropsWithoutRef<'del'> & ExtraProps) => <del className="line-through" {...rest}>{children}</del>,
  };
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, isUser = false, isStreaming = false, enableMath = true, rehypePlugins }: MarkdownRendererProps) {
  // Use global Theme Context to avoid each component creating its own MutationObserver
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  // Memoize components to keep stable references — prevents ReactMarkdown from
  // tearing down and recreating the entire DOM tree on parent re-renders
  const components = useMemo(() => createMarkdownComponents(isDark), [isDark]);
  const streamComponents = useMemo(() => createMarkdownComponents(isDark, true), [isDark]);

  const remarkPlugins = enableMath ? REMARK_PLUGINS : REMARK_PLUGINS_NO_MATH;
  const rehypePluginsBase = enableMath ? REHYPE_PLUGINS_BASE : REHYPE_PLUGINS_NO_MATH;

  // After streaming or for historical messages, detect and pre-process ASCII art
  const processedContent = useMemo(() => {
    // Skip for user messages or while streaming
    if (isUser || isStreaming) {
      return content;
    }
    const processed = escapeTablePipes(preprocessAsciiArt(content));
    return enableMath ? escapeCurrencyDollars(processed) : processed;
  }, [content, isUser, isStreaming, enableMath]);

  // Merge rehype plugins: base plugins + caller-supplied plugins
  const mergedRehypePlugins = useMemo(() => {
    if (!rehypePlugins?.length) return rehypePluginsBase;
    return [...rehypePluginsBase, ...rehypePlugins];
  }, [rehypePlugins, rehypePluginsBase]);

  // Use simplified style for user messages
  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  // While streaming: render completed lines as Markdown, last line as plain text (avoid frequent re-parsing)
  if (isStreaming) {
    const lastNewlineIndex = content.lastIndexOf('\n');

    // No newline — render everything as plain text
    if (lastNewlineIndex === -1) {
      return <div className="whitespace-pre-wrap break-words">{content}</div>;
    }

    // Split into completed lines and current line
    const completedLines = content.slice(0, lastNewlineIndex + 1);
    const currentLine = content.slice(lastNewlineIndex + 1);

    return (
      <div className="markdown-body">
        {/* Render completed lines as Markdown */}
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePluginsBase}
          components={streamComponents}
        >
          {enableMath ? escapeCurrencyDollars(escapeTablePipes(completedLines)) : escapeTablePipes(completedLines)}
        </ReactMarkdown>
        {/* Current line being typed — plain text */}
        {currentLine && (
          <span className="whitespace-pre-wrap">{currentLine}</span>
        )}
      </div>
    );
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={mergedRehypePlugins}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});
