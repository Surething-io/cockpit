'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
  lastUserMessage?: string;
}

interface GlobalSessionMonitorProps {
  currentCwd?: string;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  collapsed?: boolean;
  sessions: GlobalSession[];
  unreadSessionIds?: Set<string>;
  onClearUnread?: (sessionId: string) => void;
}

export function GlobalSessionMonitor({ currentCwd, onSwitchProject, collapsed, sessions, unreadSessionIds, onClearUnread }: GlobalSessionMonitorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭（包括点击 iframe）
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    // 点击 iframe 会导致父窗口失焦
    const handleBlur = () => {
      setIsOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);

  // 切换到指定 session
  const handleSessionClick = useCallback((session: GlobalSession) => {
    onSwitchProject(session.cwd, session.sessionId);
    onClearUnread?.(session.sessionId);
    setIsOpen(false);
  }, [onSwitchProject, onClearUnread]);

  const loadingCount = sessions.filter(s => s.isLoading).length;
  const unreadCount = sessions.filter(s => !s.isLoading && unreadSessionIds?.has(s.sessionId)).length;
  const badgeCount = loadingCount + unreadCount;

  // 格式化时间
  const formatTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    return `${Math.floor(hours / 24)}天前`;
  };

  // 获取项目名称
  const getProjectName = (cwd: string) => cwd.split('/').pop() || cwd;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title="最近会话"
      >
        {/* 闪电图标表示活动状态 */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">最近会话</span>}
        {/* badge：loading 黄色闪烁 + 未读红色静态 */}
        {badgeCount > 0 && (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          } ${loadingCount > 0 ? 'bg-green-9 animate-pulse' : 'bg-red-500'}`}>
            {badgeCount}
          </span>
        )}
      </button>

      {/* 下拉列表 - 向右上弹出 */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-80 h-[450px] bg-popover border border-border rounded-lg shadow-lg z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg">
            <span className="text-sm font-medium">最近会话</span>
            {loadingCount > 0 && (
              <span className="ml-2 text-xs text-green-11">({loadingCount} 运行中)</span>
            )}
            {unreadCount > 0 && (
              <span className="ml-2 text-xs text-red-500">({unreadCount} 未读)</span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {sessions.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                暂无会话记录
              </div>
            ) : (
              sessions.map((session, index) => (
                <button
                  key={`${session.cwd}-${session.sessionId}`}
                  onClick={() => handleSessionClick(session)}
                  className={`w-full px-3 py-2 text-left hover:bg-accent transition-colors flex items-start gap-2 ${
                    index !== sessions.length - 1 ? 'border-b border-border/50' : ''
                  } ${currentCwd === session.cwd ? 'bg-accent/50' : ''}`}
                >
                  {/* 状态指示器：loading 闪烁红点 / 未读静态红点 / 普通灰点 */}
                  <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                    session.isLoading
                      ? 'bg-green-9 animate-pulse'
                      : unreadSessionIds?.has(session.sessionId)
                        ? 'bg-red-500'
                        : 'bg-muted-foreground/30'
                  }`} />
                  <div className="flex-1 min-w-0" title={session.cwd}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {getProjectName(session.cwd)}
                      </span>
                      {session.isLoading && (
                        <span className="text-xs text-green-11 flex-shrink-0">运行中</span>
                      )}
                      {!session.isLoading && unreadSessionIds?.has(session.sessionId) && (
                        <span className="text-xs text-red-500 flex-shrink-0">完成</span>
                      )}
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatTime(session.lastActive)}
                      </span>
                    </div>
                    {(session.lastUserMessage || session.title) && (
                      <div className="text-xs text-foreground/80 truncate">
                        {session.lastUserMessage || session.title}
                      </div>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
