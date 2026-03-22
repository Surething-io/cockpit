import React from 'react';

// ============================================
// JSON 工具函数
// ============================================

export function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

export function formatAsJson(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return content;
  }
}

// ============================================
// 人类可读格式化
// ============================================

export function formatAsHumanReadable(content: string): React.ReactNode {
  try {
    const parsed = JSON.parse(content);
    return formatValueHumanReadable(parsed, 0);
  } catch {
    return content;
  }
}

// github-dark JSON token 颜色
const C_KEY = '#79c0ff';   // property key
const C_STR = '#a5d6ff';   // string value
const C_NUM = '#79c0ff';   // number
const C_BOOL = '#ff7b72';  // boolean / null
const C_PUNCT = '#8b949e'; // punctuation
const C_FOLD = '#6e7681';  // fold toggle

const s = (color: string, text: string | React.ReactNode) =>
  React.createElement('span', { style: { color } }, text);

/** 判断一个值渲染后是否超过 3 行（用于决定是否可折叠） */
function isMultilineValue(value: unknown): boolean {
  if (typeof value === 'string') {
    const text = value.replace(/\\n/g, '\n');
    return text.split('\n').length > 3;
  }
  return false;
}

/** 可折叠的 key: value 条目，点击长文本本身切换折叠/展开 */
function CollapsibleEntry({ label, labelColor, value, indent }: {
  label: string; labelColor: string; value: unknown; indent: number;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const canFold = isMultilineValue(value);
  const downPos = React.useRef({ x: 0, y: 0 });
  const onDown = (e: React.MouseEvent) => { downPos.current = { x: e.clientX, y: e.clientY }; };
  const onClick = (e: React.MouseEvent) => {
    const dx = e.clientX - downPos.current.x;
    const dy = e.clientY - downPos.current.y;
    if (dx * dx + dy * dy > 25) return; // 拖选不触发
    e.stopPropagation();
    setCollapsed(v => !v);
  };
  const foldProps = { onMouseDown: onDown, onClick, style: { cursor: 'pointer' as const } };

  if (canFold && collapsed && typeof value === 'string') {
    const firstLine = value.replace(/\\n/g, '\n').split('\n')[0];
    const lineCount = value.replace(/\\n/g, '\n').split('\n').length;
    return React.createElement('span', foldProps,
      s(labelColor, label),
      s(C_PUNCT, ': '),
      s(C_STR, firstLine),
      s(C_FOLD, ` ... (${lineCount} 行)`)
    );
  }

  const content = React.createElement(React.Fragment, null,
    s(labelColor, label),
    s(C_PUNCT, ': '),
    formatValueHumanReadable(value, indent)
  );

  if (canFold) {
    return React.createElement('span', foldProps, content);
  }
  return content;
}

function formatValueHumanReadable(value: unknown, indent: number): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return s(C_BOOL, 'null');
  if (value === undefined) return s(C_BOOL, 'undefined');

  if (typeof value === 'string') {
    const text = value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr);
    return s(C_STR, text);
  }

  if (typeof value === 'number') return s(C_NUM, String(value));
  if (typeof value === 'boolean') return s(C_BOOL, String(value));

  if (Array.isArray(value)) {
    if (value.length === 0) return s(C_PUNCT, '[]');
    return React.createElement(React.Fragment, null,
      s(C_PUNCT, '['), '\n',
      ...value.map((item, i) =>
        React.createElement('span', { key: i },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: `[${i}]`, labelColor: C_KEY, value: item, indent: indent + 1 }),
          i < value.length - 1 ? React.createElement(React.Fragment, null, s(C_PUNCT, ','), '\n') : '\n'
        )
      ),
      indentStr, s(C_PUNCT, ']')
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return s(C_PUNCT, '{}');
    return React.createElement(React.Fragment, null,
      s(C_PUNCT, '{'), '\n',
      ...entries.map(([k, v], i) =>
        React.createElement('span', { key: k },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: k, labelColor: C_KEY, value: v, indent: indent + 1 }),
          i < entries.length - 1 ? React.createElement(React.Fragment, null, s(C_PUNCT, ','), '\n') : '\n'
        )
      ),
      indentStr, s(C_PUNCT, '}')
    );
  }

  return String(value);
}

// ============================================
// Edit 工具输入检测
// ============================================

export interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

export function isEditInput(content: string): EditInput | null {
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

// ============================================
// 图片文件检测
// ============================================

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

export function isMarkdownFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.md');
}

// ============================================
// 文件路径提取
// ============================================

export function getFilePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.file_path === 'string') {
      return parsed.file_path;
    }
  } catch {
    // 非 JSON：检查是否是单行绝对路径（如工具结果直接返回文件路径）
    const trimmed = content.trim();
    if (trimmed.startsWith('/') && !trimmed.includes('\n') && trimmed.length < 500) {
      return trimmed;
    }
  }
  return null;
}
