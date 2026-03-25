import React from 'react';
import i18n from '@/lib/i18n';

// ============================================
// JSON utility functions
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
// Human-readable formatting
// ============================================

export function formatAsHumanReadable(content: string): React.ReactNode {
  try {
    const parsed = JSON.parse(content);
    return formatValueHumanReadable(parsed, 0);
  } catch {
    return content;
  }
}

// github-dark JSON token colors
const C_KEY = '#79c0ff';   // property key
const C_STR = '#a5d6ff';   // string value
const C_NUM = '#79c0ff';   // number
const C_BOOL = '#ff7b72';  // boolean / null
const C_PUNCT = '#8b949e'; // punctuation
const C_FOLD = '#6e7681';  // fold toggle

const s = (color: string, text: string | React.ReactNode) =>
  React.createElement('span', { style: { color } }, text);

/** Determine if a value renders to more than 3 lines (used to decide if it can be collapsed) */
function isMultilineValue(value: unknown): boolean {
  if (typeof value === 'string') {
    const text = value.replace(/\\n/g, '\n');
    return text.split('\n').length > 3;
  }
  return false;
}

/** Collapsible key: value entry, click long text itself to toggle collapse/expand */
function CollapsibleEntry({ label, labelColor, value, indent }: {
  label: string; labelColor: string; value: unknown; indent: number;
}) {
  const [collapsed, setCollapsed] = React.useState(false);
  const [downPos, setDownPos] = React.useState({ x: 0, y: 0 });
  const canFold = isMultilineValue(value);
  const onDown = (e: React.MouseEvent) => { setDownPos({ x: e.clientX, y: e.clientY }); };
  const onClick = (e: React.MouseEvent) => {
    const dx = e.clientX - downPos.x;
    const dy = e.clientY - downPos.y;
    if (dx * dx + dy * dy > 25) return; // Drag-select does not trigger
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
      s(C_FOLD, ` ${i18n.t('toolCall.foldedLines', { count: lineCount })}`)
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
// Edit tool input detection
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
// Image file detection
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
// File path extraction
// ============================================

export function getFilePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.file_path === 'string') {
      return parsed.file_path;
    }
  } catch {
    // Not JSON: check if it's a single-line absolute path (e.g. tool result returning file path directly)
    const trimmed = content.trim();
    if (trimmed.startsWith('/') && !trimmed.includes('\n') && trimmed.length < 500) {
      return trimmed;
    }
  }
  return null;
}
