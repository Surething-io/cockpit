import React from 'react';
import i18n from '@cockpit/shared-i18n';

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

/** Token color set for the human-readable JSON renderer. */
export interface JsonColors {
  key: string;   // property key
  str: string;   // string value
  num: string;   // number
  bool: string;  // boolean / null
  punct: string; // punctuation
  fold: string;  // fold toggle hint
}

/**
 * Default palette — hardcoded github-dark hex. Used by the tool-call previews
 * (which render on a fixed dark surface), so leaving this as the default keeps
 * those views pixel-identical.
 */
export const DARK_JSON_COLORS: JsonColors = {
  key: '#79c0ff',
  str: '#a5d6ff',
  num: '#79c0ff',
  bool: '#ff7b72',
  punct: '#8b949e',
  fold: '#6e7681',
};

/**
 * Theme-aware palette — Radix `*-11` accent tokens (accessible text on the app
 * background) that flip automatically between light and dark via CSS variables.
 * Used by the file-browser JSON preview so it follows the app theme.
 */
export const THEME_JSON_COLORS: JsonColors = {
  key: 'hsl(var(--blue-11))',
  str: 'hsl(var(--green-11))',
  num: 'hsl(var(--violet-11))',
  bool: 'hsl(var(--red-11))',
  punct: 'hsl(var(--slate-11))',
  fold: 'hsl(var(--slate-11))',
};

export function formatAsHumanReadable(
  content: string,
  colors: JsonColors = DARK_JSON_COLORS,
): React.ReactNode {
  try {
    const parsed = JSON.parse(content);
    return formatValueHumanReadable(parsed, 0, colors);
  } catch {
    return content;
  }
}

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
function CollapsibleEntry({ label, labelColor, value, indent, colors }: {
  label: string; labelColor: string; value: unknown; indent: number; colors: JsonColors;
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
      s(colors.punct, ': '),
      s(colors.str, firstLine),
      s(colors.fold, ` ${i18n.t('toolCall.foldedLines', { count: lineCount })}`)
    );
  }

  const content = React.createElement(React.Fragment, null,
    s(labelColor, label),
    s(colors.punct, ': '),
    formatValueHumanReadable(value, indent, colors)
  );

  if (canFold) {
    return React.createElement('span', foldProps, content);
  }
  return content;
}

function formatValueHumanReadable(value: unknown, indent: number, colors: JsonColors): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return s(colors.bool, 'null');
  if (value === undefined) return s(colors.bool, 'undefined');

  if (typeof value === 'string') {
    const text = value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr);
    return s(colors.str, text);
  }

  if (typeof value === 'number') return s(colors.num, String(value));
  if (typeof value === 'boolean') return s(colors.bool, String(value));

  if (Array.isArray(value)) {
    if (value.length === 0) return s(colors.punct, '[]');
    return React.createElement(React.Fragment, null,
      s(colors.punct, '['), '\n',
      ...value.map((item, i) =>
        React.createElement('span', { key: i },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: `[${i}]`, labelColor: colors.key, value: item, indent: indent + 1, colors }),
          i < value.length - 1 ? React.createElement(React.Fragment, null, s(colors.punct, ','), '\n') : '\n'
        )
      ),
      indentStr, s(colors.punct, ']')
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return s(colors.punct, '{}');
    return React.createElement(React.Fragment, null,
      s(colors.punct, '{'), '\n',
      ...entries.map(([k, v], i) =>
        React.createElement('span', { key: k },
          indentStr + '  ',
          React.createElement(CollapsibleEntry, { label: k, labelColor: colors.key, value: v, indent: indent + 1, colors }),
          i < entries.length - 1 ? React.createElement(React.Fragment, null, s(colors.punct, ','), '\n') : '\n'
        )
      ),
      indentStr, s(colors.punct, '}')
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

export function isHtmlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

export function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json');
}

/**
 * Resolve a markdown link target against the directory of the current file,
 * returning a cwd-relative path (the form handleSelectFile / locateInTree use).
 *
 * - `baseRel`: cwd-relative path of the file the link lives in (e.g. "docs/a.md")
 * - `href`: link target — relative ("./b.md", "../c.md", "b.md") or root-absolute
 *   ("/docs/d.md", treated as relative to the repo root / cwd).
 *
 * Browser-safe (no node `path`). Collapses '.' and '..' segments.
 */
export function resolveRelativePath(baseRel: string, href: string): string {
  // Root-absolute links resolve from cwd root; otherwise from baseRel's dir.
  const segs = href.startsWith('/')
    ? []
    : baseRel.split('/').slice(0, -1); // dirname(baseRel)
  for (const part of href.replace(/^\//, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  return segs.join('/');
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
