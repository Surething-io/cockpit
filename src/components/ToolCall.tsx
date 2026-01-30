'use client';

import React, { useState, useEffect, useRef } from 'react';
import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';
import { ToolCallInfo } from '@/types/chat';

// Shiki 高亮器单例
let highlighterPromise: Promise<Highlighter> | null = null;

// 支持的语言列表
const SUPPORTED_LANGS = [
  'typescript', 'tsx', 'javascript', 'jsx',
  'html', 'css', 'scss', 'json', 'yaml',
  'python', 'go', 'rust', 'java', 'ruby', 'php',
  'bash', 'shell', 'markdown', 'sql', 'c', 'cpp',
  'swift', 'kotlin', 'dart', 'lua', 'graphql', 'xml',
] as const;

// 初始化 Shiki 高亮器（单例模式）
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [...SUPPORTED_LANGS],
    });
  }
  return highlighterPromise;
}

// 根据文件扩展名获取语言
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    // JavaScript/TypeScript
    ts: 'typescript', tsx: 'tsx',
    js: 'javascript', jsx: 'jsx',
    mjs: 'javascript', cjs: 'javascript',
    // Web
    html: 'html', htm: 'html',
    css: 'css', scss: 'scss', sass: 'scss', less: 'css',
    // Data formats
    json: 'json', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', toml: 'yaml',
    // Backend
    py: 'python', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', scala: 'java',
    rb: 'ruby', php: 'php',
    cs: 'cpp', cpp: 'cpp', c: 'c', h: 'c',
    // Shell
    sh: 'bash', bash: 'bash', zsh: 'bash',
    // Config
    md: 'markdown', mdx: 'markdown',
    sql: 'sql',
    dockerfile: 'bash',
    graphql: 'graphql', gql: 'graphql',
    // Other
    swift: 'swift', dart: 'dart',
    lua: 'lua', r: 'python',
    vim: 'bash',
  };
  const lang = map[ext || ''] || 'text';
  // 确保语言在支持列表中
  if (SUPPORTED_LANGS.includes(lang as typeof SUPPORTED_LANGS[number])) {
    return lang;
  }
  return 'text';
}

// 检查是否是有效的 JSON
function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

// 格式化为 JSON（美化显示）
function formatAsJson(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

// 格式化为人类可读格式（将 \n 转换为实际换行）
function formatAsHumanReadable(content: string): React.ReactNode {
  try {
    const parsed = JSON.parse(content);
    return formatValueHumanReadable(parsed, 0);
  } catch {
    return content;
  }
}

// 递归格式化值为人类可读格式，返回 React 节点
function formatValueHumanReadable(value: unknown, indent: number): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    // 将 \n 转换为实际换行，并添加适当缩进
    return value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return (
      <>
        {'[\n'}
        {value.map((item, i) => (
          <span key={i}>
            {indentStr}  <span className="font-bold text-gray-900 dark:text-gray-100">[{i}]</span>: {formatValueHumanReadable(item, indent + 1)}
            {i < value.length - 1 ? '\n' : ''}
          </span>
        ))}
        {'\n' + indentStr + ']'}
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return (
      <>
        {'{\n'}
        {entries.map(([k, v], i) => (
          <span key={k}>
            {indentStr}  <span className="font-bold text-gray-900 dark:text-gray-100">{k}</span>: {formatValueHumanReadable(v, indent + 1)}
            {i < entries.length - 1 ? '\n' : ''}
          </span>
        ))}
        {'\n' + indentStr + '}'}
      </>
    );
  }

  return String(value);
}

// 检测是否是 Edit 工具的输入（包含 old_string 和 new_string）
interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function isEditInput(content: string): EditInput | null {
  try {
    const parsed = JSON.parse(content);
    if (
      parsed &&
      typeof parsed.file_path === 'string' &&
      typeof parsed.old_string === 'string' &&
      typeof parsed.new_string === 'string'
    ) {
      return parsed as EditInput;
    }
  } catch {
    // ignore
  }
  return null;
}

// 计算简单的行级 diff
interface DiffLine {
  type: 'unchanged' | 'removed' | 'added';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const result: DiffLine[] = [];

  // 使用 LCS (最长公共子序列) 算法的简化版本
  const m = oldLines.length;
  const n = newLines.length;

  // 构建 DP 表
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯生成 diff
  let i = m, j = n;
  const diffStack: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffStack.push({ type: 'unchanged', content: oldLines[i - 1], oldLineNum: i, newLineNum: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffStack.push({ type: 'added', content: newLines[j - 1], newLineNum: j });
      j--;
    } else {
      diffStack.push({ type: 'removed', content: oldLines[i - 1], oldLineNum: i });
      i--;
    }
  }

  // 反转结果
  while (diffStack.length > 0) {
    result.push(diffStack.pop()!);
  }

  return result;
}

// 使用 Shiki 高亮单行代码，返回 HTML tokens
interface HighlightedLine {
  tokens: Array<{ content: string; style?: string }>;
}

function useLineHighlight(lines: string[], filePath: string): Map<number, HighlightedLine> {
  const [highlightedLines, setHighlightedLines] = useState<Map<number, HighlightedLine>>(new Map());
  const [isDark, setIsDark] = useState(false);

  // 使用 ref 存储上一次的 lines 内容，避免引用变化导致无限循环
  const prevLinesKeyRef = useRef<string>('');

  // 检测暗色模式
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // 生成 lines 的稳定 key
  const linesKey = lines.join('\n');

  useEffect(() => {
    if (lines.length === 0) return;

    // 如果内容没变，跳过高亮
    const currentKey = `${linesKey}:${filePath}:${isDark}`;
    if (currentKey === prevLinesKeyRef.current) {
      return;
    }
    prevLinesKeyRef.current = currentKey;

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);
        const theme = isDark ? 'github-dark' : 'github-light';

        const result = new Map<number, HighlightedLine>();

        // 对每一行进行高亮
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) {
            result.set(i, { tokens: [{ content: '' }] });
            continue;
          }

          // 使用 codeToTokens 获取 token 信息
          const tokens = highlighter.codeToTokens(line, {
            lang: language as BundledLanguage,
            theme: theme,
          });

          const highlightedTokens = tokens.tokens[0]?.map(token => ({
            content: token.content,
            style: token.color ? `color: ${token.color}` : undefined,
          })) || [{ content: line }];

          result.set(i, { tokens: highlightedTokens });
        }

        setHighlightedLines(result);
      } catch (err) {
        console.error('Line highlight error:', err);
      }
    };

    highlight();
  }, [linesKey, filePath, isDark, lines]);

  return highlightedLines;
}

// 渲染高亮行内容
function HighlightedContent({
  content,
  highlightedLine,
  className
}: {
  content: string;
  highlightedLine?: HighlightedLine;
  className?: string;
}) {
  if (!highlightedLine || highlightedLine.tokens.length === 0) {
    return <span className={className}>{content || ' '}</span>;
  }

  return (
    <span className={className}>
      {highlightedLine.tokens.map((token, i) => (
        <span key={i} style={token.style ? { color: token.style.replace('color: ', '') } : undefined}>
          {token.content}
        </span>
      ))}
      {highlightedLine.tokens.length === 0 && ' '}
    </span>
  );
}

// Diff 统一视图组件（上下展示）
function DiffUnifiedView({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const diffLines = computeLineDiff(oldStr, newStr);

  // 收集所有需要高亮的行
  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  return (
    <div className="font-mono" style={{ fontSize: '0.8125rem' }}>
      {diffLines.map((line, idx) => (
        <div
          key={idx}
          className={`flex ${
            line.type === 'removed'
              ? 'bg-red-100 dark:bg-red-900/30'
              : line.type === 'added'
              ? 'bg-green-100 dark:bg-green-900/30'
              : ''
          }`}
        >
          {/* 行号 */}
          <span className="w-10 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
            {line.type !== 'added' ? line.oldLineNum : ''}
          </span>
          <span className="w-10 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
            {line.type !== 'removed' ? line.newLineNum : ''}
          </span>
          {/* 符号 */}
          <span
            className={`w-6 flex-shrink-0 text-center select-none ${
              line.type === 'removed'
                ? 'text-red-600 dark:text-red-400'
                : line.type === 'added'
                ? 'text-green-600 dark:text-green-400'
                : 'text-gray-400'
            }`}
          >
            {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
          </span>
          {/* 内容 - 带语法高亮 */}
          <HighlightedContent
            content={line.content}
            highlightedLine={highlightedLines.get(idx)}
            className="flex-1 whitespace-pre pl-1"
          />
        </div>
      ))}
    </div>
  );
}

// Diff 并列视图组件（左右展示）
function DiffSplitView({ oldStr, newStr, filePath }: { oldStr: string; newStr: string; filePath: string }) {
  const diffLines = computeLineDiff(oldStr, newStr);

  // 分离为左右两列
  const leftLines: { lineNum: number; content: string; type: 'unchanged' | 'removed'; originalIdx: number }[] = [];
  const rightLines: { lineNum: number; content: string; type: 'unchanged' | 'added'; originalIdx: number }[] = [];

  let leftIdx = 0;
  let rightIdx = 0;

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i];
    if (line.type === 'unchanged') {
      // 对齐：如果左右行数不一致，先填充空行
      while (leftLines.length < rightLines.length) {
        leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      while (rightLines.length < leftLines.length) {
        rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
      }
      leftIdx++;
      rightIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'unchanged', originalIdx: i });
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'unchanged', originalIdx: i });
    } else if (line.type === 'removed') {
      leftIdx++;
      leftLines.push({ lineNum: leftIdx, content: line.content, type: 'removed', originalIdx: i });
    } else if (line.type === 'added') {
      rightIdx++;
      rightLines.push({ lineNum: rightIdx, content: line.content, type: 'added', originalIdx: i });
    }
  }

  // 最后对齐
  while (leftLines.length < rightLines.length) {
    leftLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ lineNum: 0, content: '', type: 'unchanged', originalIdx: -1 });
  }

  // 收集所有需要高亮的行
  const allLines = diffLines.map(line => line.content);
  const highlightedLines = useLineHighlight(allLines, filePath);

  return (
    <div className="font-mono flex" style={{ fontSize: '0.8125rem' }}>
      {/* 左侧 - Old */}
      <div className="w-1/2 min-w-0 overflow-x-auto border-r border-gray-300 dark:border-gray-600">
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600">
          Old
        </div>
        {leftLines.map((line, idx) => (
          <div
            key={idx}
            className={`flex ${
              line.type === 'removed' ? 'bg-red-100 dark:bg-red-900/30' : ''
            }`}
          >
            <span className="w-8 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
              {line.lineNum || ''}
            </span>
            <HighlightedContent
              content={line.content}
              highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
              className="flex-1 whitespace-pre pl-2"
            />
          </div>
        ))}
      </div>
      {/* 右侧 - New */}
      <div className="w-1/2 min-w-0 overflow-x-auto">
        <div className="px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 text-center text-xs font-medium border-b border-gray-300 dark:border-gray-600">
          New
        </div>
        {rightLines.map((line, idx) => (
          <div
            key={idx}
            className={`flex ${
              line.type === 'added' ? 'bg-green-100 dark:bg-green-900/30' : ''
            }`}
          >
            <span className="w-8 flex-shrink-0 text-right pr-2 text-gray-400 dark:text-gray-500 select-none border-r border-gray-200 dark:border-gray-700">
              {line.lineNum || ''}
            </span>
            <HighlightedContent
              content={line.content}
              highlightedLine={line.originalIdx >= 0 ? highlightedLines.get(line.originalIdx) : undefined}
              className="flex-1 whitespace-pre pl-2"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// 从 JSON 中提取 file_path
function getFilePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.file_path === 'string') {
      return parsed.file_path;
    }
  } catch {
    // ignore
  }
  return null;
}

// 文件预览组件
function FilePreview({ filePath }: { filePath: string }) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(false);

  // 检测暗色模式
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDark(document.documentElement.classList.contains('dark'));
    };
    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  // 防止 StrictMode 下重复请求
  const fetchingRef = useRef(false);

  useEffect(() => {
    // 防止重复请求
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const loadFile = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.statusText}`);
        }
        const data = await response.json();
        setFileContent(data.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    };
    loadFile();
  }, [filePath]);

  // 使用 Shiki 进行语法高亮
  useEffect(() => {
    if (!fileContent) return;

    const theme = isDark ? 'github-dark' : 'github-light';

    const highlight = async () => {
      try {
        const highlighter = await getHighlighter();
        const language = getLanguageFromPath(filePath);

        // 手动添加行号
        const lines = fileContent.split('\n');
        const lineNumberWidth = String(lines.length).length;

        const html = highlighter.codeToHtml(fileContent, {
          lang: language,
          theme: theme,
          transformers: [
            {
              line(node, line) {
                // 添加行号
                const lineNum = String(line).padStart(lineNumberWidth, ' ');
                node.children.unshift({
                  type: 'element',
                  tagName: 'span',
                  properties: { class: 'line-number' },
                  children: [{ type: 'text', value: lineNum }],
                });
              },
            },
          ],
        });

        setHighlightedHtml(html);
      } catch (err) {
        console.error('Highlight error:', err);
        // 出错时显示纯文本
        setHighlightedHtml(null);
      }
    };

    highlight();
  }, [fileContent, filePath, isDark]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-red-500 dark:text-red-400">{error}</div>
      </div>
    );
  }

  // 加载中显示纯文本
  if (isLoading) {
    return (
      <pre
        className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words p-4 rounded-lg bg-gray-50 dark:bg-gray-900"
        style={{ fontSize: '0.8125rem' }}
      >
        Loading...
      </pre>
    );
  }

  // 高亮完成，显示高亮内容
  if (highlightedHtml) {
    return (
      <div
        className="shiki-wrapper rounded-lg overflow-auto"
        style={{ fontSize: '0.8125rem' }}
        dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      />
    );
  }

  // 高亮未完成，先显示纯文本
  return (
    <pre
      className="text-xs font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words p-4 rounded-lg bg-gray-50 dark:bg-gray-900"
      style={{ fontSize: '0.8125rem' }}
    >
      {fileContent || ''}
    </pre>
  );
}

// 预览模态窗口组件
interface PreviewModalProps {
  title: string;
  content: string;
  toolName?: string;
  onClose: () => void;
}

type ViewMode = 'readable' | 'json' | 'diff-unified' | 'diff-split' | 'file';

function PreviewModal({ title, content, toolName, onClose }: PreviewModalProps) {
  const isJson = isValidJson(content);
  const editInput = isEditInput(content);
  const filePath = getFilePath(content);
  const hasDiffMode = !!editInput;
  const hasFileMode = !!filePath;

  // 默认模式：Read/Write 工具默认 file 模式，Edit 工具默认 diff 模式，其他用可读模式
  const getDefaultMode = (): ViewMode => {
    if ((toolName === 'Read' || toolName === 'Write') && hasFileMode) return 'file';
    if (hasDiffMode) return 'diff-split';
    if (isJson) return 'readable';
    return 'json';
  };

  const [viewMode, setViewMode] = useState<ViewMode>(getDefaultMode());

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 移除焦点，避免关闭后焦点停留在按钮上
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const renderContent = () => {
    if (viewMode === 'file' && filePath) {
      return <FilePreview filePath={filePath} />;
    }
    if (viewMode === 'diff-unified' && editInput) {
      return <DiffUnifiedView oldStr={editInput.old_string} newStr={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'diff-split' && editInput) {
      return <DiffSplitView oldStr={editInput.old_string} newStr={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'readable' && isJson) {
      return (
        <pre className="font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
          {formatAsHumanReadable(content)}
        </pre>
      );
    }
    return (
      <pre className="font-mono text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
        {isJson ? formatAsJson(content) : content}
      </pre>
    );
  };

  // Split 模式使用更宽的窗口
  const modalWidth = viewMode === 'diff-split' ? 'max-w-[90vw]' : 'max-w-6xl';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full ${modalWidth} h-[90vh] flex flex-col transition-all`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
          <div className="flex items-center gap-3">
            {/* 视图模式切换 */}
            {isJson && (
              <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded p-0.5">
                {hasDiffMode && (
                  <>
                    <button
                      onClick={() => setViewMode('diff-split')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-split'
                          ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                      title="并列对比"
                    >
                      Split
                    </button>
                    <button
                      onClick={() => setViewMode('diff-unified')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-unified'
                          ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                      }`}
                      title="统一对比"
                    >
                      Unified
                    </button>
                  </>
                )}
                {hasFileMode && (
                  <button
                    onClick={() => setViewMode('file')}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === 'file'
                        ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    }`}
                    title="预览文件"
                  >
                    File
                  </button>
                )}
                <button
                  onClick={() => setViewMode('readable')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'readable'
                      ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  可读
                </button>
                <button
                  onClick={() => setViewMode('json')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'json'
                      ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-gray-100 shadow-sm'
                      : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }`}
                >
                  JSON
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
}

export function ToolCall({ toolCall, cwd }: ToolCallProps) {
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string; toolName: string } | null>(null);

  const getToolIcon = (name: string) => {
    const icons: Record<string, string> = {
      Read: '📄',
      Write: '✏️',
      Edit: '📝',
      Bash: '💻',
      Glob: '🔍',
      Grep: '🔎',
      WebFetch: '🌐',
      WebSearch: '🔍',
    };
    return icons[name] || '🔧';
  };

  // 从 input 中提取文件路径或关键信息（用于 Read, Write, Edit, Glob, Bash 等工具）
  const getDisplayInfo = () => {
    const input = toolCall.input;
    // Bash 工具展示 command
    if (toolCall.name === 'Bash' && input.command && typeof input.command === 'string') {
      return input.command;
    }
    // Glob 工具展示 pattern
    if (toolCall.name === 'Glob' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    // Grep 工具展示 pattern
    if (toolCall.name === 'Grep' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    if (input.file_path && typeof input.file_path === 'string') {
      return input.file_path;
    }
    if (input.path && typeof input.path === 'string') {
      return input.path;
    }
    return null;
  };

  // 获取相对于 cwd 的路径
  const getRelativePath = (fullPath: string) => {
    if (cwd && fullPath.startsWith(cwd)) {
      // 去掉 cwd 前缀，返回相对路径
      const relativePath = fullPath.slice(cwd.length);
      // 去掉开头的 /
      return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    }
    // 如果不在 cwd 下，显示最后两级路径
    const parts = fullPath.split('/');
    if (parts.length > 2) {
      return '.../' + parts.slice(-2).join('/');
    }
    return fullPath;
  };

  const displayInfo = getDisplayInfo();
  // Bash, Glob 和 Grep 不需要转换为相对路径
  const skipRelativePath = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'Bash';
  // 用于显示的相对路径（标题栏等）
  const displayPath = displayInfo ? (skipRelativePath ? displayInfo : getRelativePath(displayInfo)) : null;

  return (
    <div className="my-2 border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <span className="text-base">{getToolIcon(toolCall.name)}</span>
        <span className="font-medium text-sm text-gray-700 dark:text-gray-300 flex-shrink-0">
          {toolCall.name}
        </span>
        {displayPath && (
          <span
            className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate flex-1 min-w-0"
            title={displayInfo || ''}
          >
            {displayPath}
          </span>
        )}
        {toolCall.isLoading && (
          <span className="ml-auto">
            <span className="inline-block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </span>
        )}
        {!toolCall.isLoading && (
          <span className="ml-auto text-gray-400 text-xs">
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-600">
          <div className="px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-gray-500 dark:text-gray-400">输入参数:</span>
              <button
                onClick={() => setPreviewContent({ title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''}`, content: JSON.stringify(toolCall.input, null, 2), toolName: toolCall.name })}
                className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
              >
                查看全部
              </button>
            </div>
            <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-gray-700 dark:text-gray-300">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-gray-200 dark:border-gray-600">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 dark:text-gray-400">结果:</span>
                <button
                  onClick={() => setPreviewContent({ title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''}`, content: toolCall.result || '', toolName: toolCall.name })}
                  className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  查看全部
                </button>
              </div>
              <pre className="text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-gray-700 dark:text-gray-300">
                {toolCall.result}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 预览模态窗口 */}
      {previewContent && (
        <PreviewModal
          title={previewContent.title}
          content={previewContent.content}
          toolName={previewContent.toolName}
          onClose={() => setPreviewContent(null)}
        />
      )}
    </div>
  );
}
