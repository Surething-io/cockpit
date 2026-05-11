export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

export interface FileContent {
  type: 'text' | 'image' | 'binary' | 'error';
  content?: string;
  message?: string;
  size?: number;
  mtime?: number; // File last modified time (ms), used for save conflict detection
  isSymlink?: boolean;
  symlinkTarget?: string;
}

export interface BlameLine {
  hash: string;
  hashFull: string;
  author: string;
  authorEmail: string;
  time: number;
  message: string;
  line: number;
  content: string;
}

// Git Status Types
export interface GitFileStatus {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  oldPath?: string;
  /** Lines added — populated by status route via `git diff --numstat`. 0 for untracked / binary / unmatched. */
  additions?: number;
  /** Lines deleted — populated by status route via `git diff --numstat`. 0 for untracked / binary / unmatched. */
  deletions?: number;
}

export interface GitStatusResponse {
  staged: GitFileStatus[];
  unstaged: GitFileStatus[];
  cwd: string;
}

export interface GitDiffResponse {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

// Git History Types
export interface Branch {
  current: string;
  local: string[];
  remote: string[];
}

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  subject: string;
  body: string;
  relativeDate: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  additions: number;
  deletions: number;
}

export interface FileDiff {
  oldContent: string;
  newContent: string;
  filePath: string;
  isNew: boolean;
  isDeleted: boolean;
}

// Tab type
export type TabType = 'tree' | 'search' | 'recent' | 'status' | 'history';

/**
 * Sub-mode within the 'status' tab.
 * - 'files': original staged/unstaged tree (git mental model)
 * - 'changes': flat list of all changed files for review (comprehension mental model)
 *
 * The legacy `StatusSubMode` (with a second `'changes'` mode for symbol-
 * level diff) was retired together with `ChangesView` — symbol diff now
 * surfaces inside DiffView via a Block toggle, not as a separate file
 * list. The status tab is therefore single-mode again.
 */

// Search result types
export interface SearchMatch {
  lineNumber: number;
  content: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  totalFiles: number;
  totalMatches: number;
  truncated: boolean;
  error?: string;
}

export interface FileBrowserModalProps {
  onClose: () => void;
  cwd: string;
  initialTab?: TabType;
  tabSwitchTrigger?: number;
  initialSearchQuery?: string | null;
  searchQueryTrigger?: number;
}
