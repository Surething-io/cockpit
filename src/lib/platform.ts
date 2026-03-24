/**
 * 跨平台工具函数
 * 服务端 + 客户端共用（客户端函数通过 typeof navigator 判断）
 */

// ============================================================================
// 服务端平台检测
// ============================================================================

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** 用户默认 shell */
export function getDefaultShell(): string {
  if (isWindows) return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/sh';
}

/** 默认 PATH fallback */
export function getDefaultPath(): string {
  if (isWindows) return process.env.PATH || '';
  return process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
}

// ============================================================================
// 客户端平台检测（UI 快捷键文案）
// ============================================================================

/** 客户端是否 macOS（浏览器环境） */
export function isMacClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || '')
    || ((navigator as any).userAgentData?.platform === 'macOS');
}

/** 修饰键文案：macOS → '⌘'，其他 → 'Ctrl+' */
export function modKey(): string {
  return isMacClient() ? '⌘' : 'Ctrl+';
}

/** 修饰键符号（无加号）：macOS → '⌘'，其他 → 'Ctrl' */
export function modKeyBare(): string {
  return isMacClient() ? '⌘' : 'Ctrl';
}
