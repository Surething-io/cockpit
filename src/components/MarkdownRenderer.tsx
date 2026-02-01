'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useState, useEffect, ComponentPropsWithoutRef } from 'react';

interface MarkdownRendererProps {
  content: string;
  isUser?: boolean;
}

export function MarkdownRenderer({ content, isUser = false }: MarkdownRendererProps) {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    // 检测暗色模式
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    // 监听暗色模式变化
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // 用户消息使用简化样式
  if (isUser) {
    return <div className="whitespace-pre-wrap break-words">{content}</div>;
  }

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
        // 代码块
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          const isInline = !match && !className;

          if (isInline) {
            return (
              <code
                className="px-1.5 py-0.5 mx-0.5 rounded bg-accent text-sm font-mono"
                {...props}
              >
                {children}
              </code>
            );
          }

          return (
            <div className="relative my-3 rounded-lg overflow-hidden">
              {match && (
                <div className="flex items-center justify-between px-4 py-2 bg-slate-11 text-muted-foreground text-xs">
                  <span>{match[1]}</span>
                  <CopyButton text={String(children).replace(/\n$/, '')} />
                </div>
              )}
              <SyntaxHighlighter
                style={isDark ? oneDark : oneLight}
                language={match?.[1] || 'text'}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  borderRadius: match ? '0 0 0.5rem 0.5rem' : '0.5rem',
                  fontSize: '0.875rem',
                }}
              >
                {String(children).replace(/\n$/, '')}
              </SyntaxHighlighter>
            </div>
          );
        },

        // 段落
        p({ children }) {
          return <p className="mb-3 last:mb-0">{children}</p>;
        },

        // 标题
        h1({ children }) {
          return <h1 className="text-xl font-bold mb-3 mt-4 first:mt-0">{children}</h1>;
        },
        h2({ children }) {
          return <h2 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h2>;
        },
        h3({ children }) {
          return <h3 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h3>;
        },

        // 列表
        ul({ children }) {
          return <ul className="list-disc list-inside mb-3 space-y-1">{children}</ul>;
        },
        ol({ children }) {
          return <ol className="list-decimal list-inside mb-3 space-y-1">{children}</ol>;
        },
        li({ children }) {
          return <li className="leading-relaxed">{children}</li>;
        },

        // 引用
        blockquote({ children }) {
          return (
            <blockquote className="border-l-4 border-border pl-4 my-3 italic text-muted-foreground">
              {children}
            </blockquote>
          );
        },

        // 链接
        a({ href, children }) {
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand hover:underline"
            >
              {children}
            </a>
          );
        },

        // 表格
        table({ children }) {
          return (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border border-border">
                {children}
              </table>
            </div>
          );
        },
        thead({ children }) {
          return <thead className="bg-accent">{children}</thead>;
        },
        th({ children }) {
          return (
            <th className="px-4 py-2 text-left font-semibold border-b border-border">
              {children}
            </th>
          );
        },
        td({ children }) {
          return (
            <td className="px-4 py-2 border-b border-border">
              {children}
            </td>
          );
        },

        // 分隔线
        hr() {
          return <hr className="my-4 border-border" />;
        },

        // 图片
        img({ src, alt, ...props }: ComponentPropsWithoutRef<'img'>) {
          return (
            <img
              src={src}
              alt={alt || ''}
              className="max-w-full h-auto rounded-lg my-3"
              {...props}
            />
          );
        },

        // 粗体
        strong({ children }) {
          return <strong className="font-bold">{children}</strong>;
        },

        // 斜体
        em({ children }) {
          return <em className="italic">{children}</em>;
        },

        // 删除线
        del({ children }) {
          return <del className="line-through">{children}</del>;
        },
      }}
    >
      {content}
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
      className="px-2 py-1 text-xs rounded hover:bg-slate-8 transition-colors"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  );
}
