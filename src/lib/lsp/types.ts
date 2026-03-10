// ============================================
// LSP 统一接口定义
// 所有 Language Server adapter 实现此接口
// ============================================

import type { ChildProcess } from 'child_process';

/** 代码位置 */
export interface Location {
  file: string;
  line: number;      // 1-based
  column: number;    // 1-based
  lineText?: string; // 该行源码，用于前端展示
}

/** 悬浮类型信息 */
export interface HoverInfo {
  displayString: string;   // 类型签名
  documentation?: string;  // JSDoc / docstring
  kind?: string;           // function / variable / class ...
}

/** Language Server adapter 统一接口 */
export interface LanguageServerAdapter {
  readonly language: string;

  /** 启动 Language Server 进程 */
  spawn(): ChildProcess;

  /** 发送初始化请求（部分 LS 需要） */
  initialize?(): Promise<void>;

  /** 通知 LS 打开文件 */
  openFile(filePath: string, content: string): void;

  /** 通知 LS 文件已关闭 */
  closeFile?(filePath: string): void;

  /** 跳转定义 */
  definition(filePath: string, line: number, column: number): Promise<Location[]>;

  /** 悬浮类型信息 */
  hover(filePath: string, line: number, column: number): Promise<HoverInfo | null>;

  /** 引用查找 */
  references(filePath: string, line: number, column: number): Promise<Location[]>;

  /** 优雅关闭 */
  shutdown(): void;
}

/** LSP Server 实例（Registry 内部使用） */
export interface LSPServerInstance {
  language: string;
  cwd: string;               // 项目根目录（绝对路径）
  adapter: LanguageServerAdapter;
  process: ChildProcess;
  openedFiles: Set<string>;  // 已 open 的文件路径
  lastOpenedFile?: string;   // 当前活跃文件，切换时 reload
  ready: boolean;            // 初始化完成标志
  readyPromise: Promise<void>; // 等待初始化完成
  lastUsedAt: number;        // 最后使用时间戳（LRU + idle 超时用）
}

/** 支持 LSP 的语言 */
export type SupportedLanguage = 'typescript' | 'python';

/** 根据文件扩展名获取语言类型 */
export function getLanguageForFile(filePath: string): SupportedLanguage | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'typescript';
  if (['py', 'pyi'].includes(ext)) return 'python';
  return null;
}
