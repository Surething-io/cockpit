// ============================================
// Unified LSP interface definitions
// All Language Server adapters implement this interface.
// ============================================

import type { ChildProcess } from 'child_process';

/** Code location */
export interface Location {
  file: string;
  line: number;      // 1-based
  column: number;    // 1-based
  lineText?: string; // source text of the line, for frontend display
}

/** Hover type information */
export interface HoverInfo {
  displayString: string;   // type signature
  documentation?: string;  // JSDoc / docstring
  kind?: string;           // function / variable / class ...
}

/** Unified Language Server adapter interface */
export interface LanguageServerAdapter {
  readonly language: string;

  /** Spawn the Language Server process */
  spawn(): ChildProcess;

  /** Send the initialization request (required by some LSes) */
  initialize?(): Promise<void>;

  /** Notify the LS that a file was opened */
  openFile(filePath: string, content: string): void;

  /** Notify the LS that a file was closed */
  closeFile?(filePath: string): void;

  /** Go to definition */
  definition(filePath: string, line: number, column: number): Promise<Location[]>;

  /** Hover type info */
  hover(filePath: string, line: number, column: number): Promise<HoverInfo | null>;

  /** Find references */
  references(filePath: string, line: number, column: number): Promise<Location[]>;

  /** Graceful shutdown */
  shutdown(): void;
}

/** LSP Server instance (used internally by the Registry) */
export interface LSPServerInstance {
  language: string;
  cwd: string;               // project root directory (absolute path)
  adapter: LanguageServerAdapter;
  process: ChildProcess;
  openedFiles: Set<string>;  // paths of files that have been opened
  lastOpenedFile?: string;   // currently active file; reloaded on switch
  ready: boolean;            // initialization complete flag
  readyPromise: Promise<void>; // resolves when initialization is complete
  lastUsedAt: number;        // last-used timestamp (for LRU + idle timeout)
}

/** Languages with LSP support */
export type SupportedLanguage = 'typescript' | 'python';

/** Get the language type for a file based on its extension */
export function getLanguageForFile(filePath: string): SupportedLanguage | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'typescript';
  if (['py', 'pyi'].includes(ext)) return 'python';
  return null;
}
