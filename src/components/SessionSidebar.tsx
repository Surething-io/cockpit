'use client';

import { useState, useEffect, useCallback } from 'react';
import { Tooltip } from './Tooltip';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
}

interface SessionSidebarProps {
  cwd: string;
  currentSessionId?: string | null;
  onSelectSession: (sessionId: string, title?: string) => void;
  loadingSessionIds?: string[];
}

export function SessionSidebar({ cwd, currentSessionId, onSelectSession, loadingSessionIds = [] }: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  // 加载 session 列表
  const loadSessions = useCallback(async () => {
    if (!cwd) return;

    setIsLoading(true);
    try {
      const encodedPath = cwd.replace(/\//g, '-');
      const response = await fetch(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`);
      if (response.ok) {
        const data = await response.json();
        setSessions(data);
      }
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const handleSessionClick = (session: SessionInfo) => {
    const fileName = session.path.split('/').pop() || '';
    const sessionId = fileName.replace('.jsonl', '');
    onSelectSession(sessionId, session.title);
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return '刚刚';
    if (diffMins < 60) return `${diffMins}分钟前`;
    if (diffHours < 24) return `${diffHours}小时前`;
    if (diffDays < 7) return `${diffDays}天前`;

    return date.toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
    });
  };

  // 折叠状态下只显示展开按钮
  if (isCollapsed) {
    return (
      <div className="w-10 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex flex-col items-center pt-3">
        <button
          onClick={() => setIsCollapsed(false)}
          className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
          title="展开侧边栏"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
          Sessions
        </span>
        <button
          onClick={() => setIsCollapsed(true)}
          className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
          title="折叠侧边栏"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <svg className="animate-spin h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}

        {!isLoading && sessions.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-gray-400 dark:text-gray-500">
            No sessions
          </div>
        )}

        {!isLoading && sessions.map((session) => {
          const sessionId = session.path.split('/').pop()?.replace('.jsonl', '') || '';
          const isActive = sessionId === currentSessionId;
          const isGenerating = loadingSessionIds.includes(sessionId);

          return (
            <Tooltip key={session.path} content={session.title} delay={200}>
              <div
                onClick={() => handleSessionClick(session)}
                className={`px-3 py-2 cursor-pointer border-b border-gray-100 dark:border-gray-700/50 transition-colors ${
                  isActive
                    ? 'bg-blue-50 dark:bg-blue-900/30 border-l-2 border-l-blue-500'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700/50'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  {isGenerating && (
                    <svg className="animate-spin h-3 w-3 text-blue-500 flex-shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  <div
                    className={`text-sm truncate ${
                      isActive
                        ? 'text-blue-700 dark:text-blue-300 font-medium'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    {session.title}
                  </div>
                </div>
                <div className={`text-xs text-gray-400 dark:text-gray-500 mt-0.5 ${isGenerating ? 'ml-4.5' : ''}`}>
                  {formatDate(session.modifiedAt)}
                </div>
              </div>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}
