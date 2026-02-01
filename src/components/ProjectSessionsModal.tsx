'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
}

interface ProjectSessionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
  onSelectSession?: (sessionId: string, title?: string) => void;
}

export function ProjectSessionsModal({ isOpen, onClose, cwd, onSelectSession }: ProjectSessionsModalProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 加载当前项目的 session 列表
  const loadSessions = useCallback(async () => {
    if (!cwd) return;

    setIsLoading(true);
    setError(null);

    try {
      // 将 cwd 编码为目录名格式
      const encodedPath = cwd.replace(/\//g, '-');
      const response = await fetch(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`);
      if (!response.ok) {
        throw new Error('Failed to load sessions');
      }
      const data = await response.json();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (isOpen) {
      loadSessions();
      // 自动聚焦到搜索框
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen, loadSessions]);

  // ESC 键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSessionClick = (session: SessionInfo) => {
    // 从 sessionPath 中提取 sessionId（文件名去掉 .jsonl）
    const fileName = session.path.split('/').pop() || '';
    const sessionId = fileName.replace('.jsonl', '');

    if (onSelectSession) {
      // 如果有 onSelectSession 回调，使用它（在 TabManager 中添加新标签）
      onSelectSession(sessionId, session.title);
      onClose();
    } else {
      // 否则打开新浏览器标签页
      const url = `/?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}`;
      window.open(url, '_blank');
    }
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // 过滤 session
  const filteredSessions = sessions.filter((session) => {
    if (!searchKeyword) return true;
    const keyword = searchKeyword.toLowerCase();
    return (
      session.title.toLowerCase().includes(keyword) ||
      session.firstMessages.some((msg) => msg.toLowerCase().includes(keyword)) ||
      session.lastMessages.some((msg) => msg.toLowerCase().includes(keyword))
    );
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-6xl h-[90vh] mx-4 bg-white dark:bg-gray-800 rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-medium text-gray-900 dark:text-gray-100">
              会话列表
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate" title={cwd}>
              {cwd}
            </p>
          </div>
          <div className="flex items-center gap-3 ml-4">
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索会话..."
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <button
              onClick={onClose}
              className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>加载会话中...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-red-500 dark:text-red-400">{error}</div>
            </div>
          )}

          {!isLoading && !error && filteredSessions.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {searchKeyword ? '未找到匹配的会话' : '暂无会话'}
              </div>
            </div>
          )}

          {!isLoading && !error && filteredSessions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredSessions.map((session) => (
                <div
                  key={session.path}
                  onClick={() => handleSessionClick(session)}
                  className="p-3 bg-gray-50 dark:bg-gray-700/50 rounded border border-gray-200 dark:border-gray-600 hover:border-blue-500 dark:hover:border-blue-400 hover:shadow-md cursor-pointer transition-all"
                >
                  {/* Session Title */}
                  <h4 className="text-xs font-medium text-gray-900 dark:text-gray-100 mb-1 truncate" title={session.title}>
                    {session.title}
                  </h4>

                  {/* Session Time */}
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {formatDate(session.modifiedAt)}
                  </div>

                  {/* Messages Preview */}
                  <div className="space-y-0.5 text-xs">
                    {/* First Messages */}
                    {session.firstMessages.map((msg, idx) => (
                      <div
                        key={`first-${idx}`}
                        className="text-gray-600 dark:text-gray-300 truncate"
                        title={msg}
                      >
                        <span className="text-gray-400 dark:text-gray-500 mr-1">•</span>
                        {msg}
                      </div>
                    ))}

                    {/* Separator if there are last messages */}
                    {session.lastMessages.length > 0 && (
                      <div className="text-gray-400 dark:text-gray-500 text-center py-0.5">
                        ···
                      </div>
                    )}

                    {/* Last Messages */}
                    {session.lastMessages.map((msg, idx) => (
                      <div
                        key={`last-${idx}`}
                        className="text-gray-600 dark:text-gray-300 truncate"
                        title={msg}
                      >
                        <span className="text-gray-400 dark:text-gray-500 mr-1">•</span>
                        {msg}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
