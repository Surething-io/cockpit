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

function formatValueHumanReadable(value: unknown, indent: number): React.ReactNode {
  const indentStr = '  '.repeat(indent);

  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'string') {
    return value.replace(/\\n/g, '\n').replace(/\n/g, '\n' + indentStr);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return React.createElement(React.Fragment, null,
      '[\n',
      ...value.map((item, i) =>
        React.createElement('span', { key: i },
          indentStr + '  ',
          React.createElement('span', { className: 'font-bold text-foreground' }, `[${i}]`),
          ': ',
          formatValueHumanReadable(item, indent + 1),
          i < value.length - 1 ? '\n' : ''
        )
      ),
      '\n' + indentStr + ']'
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return React.createElement(React.Fragment, null,
      '{\n',
      ...entries.map(([k, v], i) =>
        React.createElement('span', { key: k },
          indentStr + '  ',
          React.createElement('span', { className: 'font-bold text-foreground' }, k),
          ': ',
          formatValueHumanReadable(v, indent + 1),
          i < entries.length - 1 ? '\n' : ''
        )
      ),
      '\n' + indentStr + '}'
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
