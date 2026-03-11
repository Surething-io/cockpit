'use client';

import React, { useEffect, useRef, useMemo } from 'react';

interface HoverTooltipProps {
  displayString: string;
  documentation?: string;
  x: number;
  y: number;
  container: HTMLElement;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFindReferences?: () => void;
  onSearch?: (keyword: string) => void;
}

/** 去掉 tsserver 返回的 "(kind) " 前缀 */
function stripKindPrefix(s: string): string {
  return s.replace(/^\([^)]+\)\s*/, '');
}

/** 简易语法高亮 */
function highlightTypeSignature(code: string): React.ReactNode[] {
  const KEYWORDS = /\b(const|let|var|function|class|interface|type|enum|import|export|async|await|return|new|typeof|keyof|extends|implements|readonly|static|public|private|protected|abstract|declare|namespace|module|void|never|undefined|null|true|false|any|unknown|string|number|boolean|bigint|symbol|object)\b/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  const combined = /\b(const|let|var|function|class|interface|type|enum|import|export|async|await|return|new|typeof|keyof|extends|implements|readonly|static|public|private|protected|abstract|declare|namespace|module|void|never|undefined|null|true|false|any|unknown|string|number|boolean|bigint|symbol|object)\b|"[^"]*"|'[^']*'|\b\d+\b/g;
  let match;

  while ((match = combined.exec(code)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={key++} className="text-foreground">{code.slice(lastIndex, match.index)}</span>);
    }
    const text = match[0];
    if (/^["']/.test(text)) {
      parts.push(<span key={key++} className="text-green-400">{text}</span>);
    } else if (/^\d+$/.test(text)) {
      parts.push(<span key={key++} className="text-orange-300">{text}</span>);
    } else if (KEYWORDS.test(text)) {
      KEYWORDS.lastIndex = 0;
      parts.push(<span key={key++} className="text-pink-400">{text}</span>);
    } else {
      parts.push(<span key={key++} className="text-foreground">{text}</span>);
    }
    lastIndex = match.index + text.length;
  }

  if (lastIndex < code.length) {
    parts.push(<span key={key++} className="text-foreground">{code.slice(lastIndex)}</span>);
  }

  return parts;
}

/** 从 displayString 提取 token 名（函数名/变量名） */
function extractTokenName(displayString: string): string {
  const clean = stripKindPrefix(displayString);
  // "function foo(..." → "foo"
  // "const foo: ..." → "foo"
  // "class Foo ..." → "Foo"
  const match = clean.match(/^(?:function|const|let|var|class|interface|type|enum|async function)\s+([a-zA-Z_$][\w$]*)/);
  if (match) return match[1];
  // "(method) Foo.bar(...)" or "(property) Foo.bar" 等带前缀的
  const methodMatch = displayString.match(/\([^)]+\)\s+(?:[\w$]+\.)*([a-zA-Z_$][\w$]*)/);
  if (methodMatch) return methodMatch[1];
  // fallback: 第一个标识符
  const idMatch = clean.match(/([a-zA-Z_$][\w$]*)/);
  return idMatch ? idMatch[1] : clean.split(/[(\s:]/)[0];
}

export function HoverTooltip({ displayString, documentation, x, y, container, onMouseEnter, onMouseLeave, onFindReferences, onSearch }: HoverTooltipProps) {
  const ref = useRef<HTMLDivElement>(null);
  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  const cleanCode = useMemo(() => stripKindPrefix(displayString), [displayString]);
  const highlighted = useMemo(() => highlightTypeSignature(cleanCode), [cleanCode]);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const cRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();

    let adjustedX = x - cRect.left;
    let adjustedY = y - cRect.top;

    if (adjustedX + elRect.width > cRect.width - 8) {
      adjustedX = cRect.width - elRect.width - 8;
    }
    if (adjustedX < 8) {
      adjustedX = 8;
    }
    if (adjustedY + elRect.height > cRect.height - 8) {
      adjustedY = adjustedY - elRect.height - 24;
    }

    el.style.left = `${adjustedX}px`;
    el.style.top = `${adjustedY}px`;
  }, [x, y, container]);

  return (
    <div
      ref={ref}
      className="absolute z-[200] max-w-lg bg-card border border-border rounded-lg shadow-xl px-3 py-2 pointer-events-none"
      style={{ left: relX, top: relY }}
    >
      <pre className="font-mono text-xs whitespace-pre-wrap break-all leading-relaxed">
        {highlighted}
      </pre>
      {documentation && (
        <>
          <div className="border-t border-border my-1" />
          <p className="text-xs text-muted-foreground whitespace-pre-wrap">{documentation}</p>
        </>
      )}
      {(onFindReferences || onSearch) && (
        <>
          <div className="border-t border-border my-1.5" />
          <div
            className="flex items-center gap-3 pointer-events-auto"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          >
            {onFindReferences && (
              <button
                onClick={onFindReferences}
                className="text-[11px] text-brand hover:underline cursor-pointer"
              >
                查找引用
              </button>
            )}
            {onSearch && (
              <button
                onClick={() => onSearch(extractTokenName(displayString))}
                className="text-[11px] text-brand hover:underline cursor-pointer"
              >
                搜索
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
