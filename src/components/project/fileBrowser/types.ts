export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

export interface FileContent {
  type: 'text' | 'image' | 'binary' | 'error';
  content?: string;
  message?: string;
  size?: number;
  mtime?: number; // 文件最后修改时间 (ms)，用于保存冲突检测
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

// 搜索结果类型
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
}
