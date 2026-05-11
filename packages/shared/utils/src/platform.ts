/**
 * Cross-platform utility functions
 * Shared by server and client (client functions guard with typeof navigator)
 */

// ============================================================================
// Server-side platform detection
// ============================================================================

export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const isLinux = process.platform === 'linux';

/** User's default shell */
export function getDefaultShell(): string {
  if (isWindows) return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || '/bin/sh';
}

/** Default PATH fallback */
export function getDefaultPath(): string {
  if (isWindows) return process.env.PATH || '';
  return process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
}

// ============================================================================
// Client-side platform detection (UI keyboard shortcut labels)
// ============================================================================

/** Whether the client is macOS (browser environment) */
export function isMacClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || '')
    || ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform === 'macOS');
}

/** Modifier key label: macOS → '⌘', others → 'Ctrl+' */
export function modKey(): string {
  return isMacClient() ? '⌘' : 'Ctrl+';
}

/** Modifier key symbol without plus sign: macOS → '⌘', others → 'Ctrl' */
export function modKeyBare(): string {
  return isMacClient() ? '⌘' : 'Ctrl';
}
