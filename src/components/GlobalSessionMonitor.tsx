'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  isLoading: boolean;
  title?: string;
}

interface GlobalSessionMonitorProps {
  currentCwd?: string;
  onSwitchSession?: (sessionId: string) => void;
}

export function GlobalSessionMonitor({ currentCwd, onSwitchSession }: GlobalSessionMonitorProps) {
  const router = useRouter();
  const [sessions, setSessions] = useState<GlobalSession[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 轮询获取全局状态（前端轮询，避免 SW 休眠问题）
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const response = await fetch('/api/global-state');
        if (response.ok) {
          const data = await response.json();
          setSessions(data.sessions || []);
        }
      } catch {
        // 忽略错误
      }
    };

    fetchSessions();
    const interval = setInterval(fetchSessions, 3000);
    return () => clearInterval(interval);
  }, []);

  // 注册 Service Worker（仅用于跨 Tab 通信）
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // 监听 BroadcastChannel，处理跨 tab session 切换
  useEffect(() => {
    const channel = new BroadcastChannel('session-switch');

    const handleMessage = (event: MessageEvent) => {
      const { targetCwd, sessionId } = event.data || {};
      // 只有当前项目匹配时才处理
      if (targetCwd === currentCwd && sessionId && onSwitchSession) {
        onSwitchSession(sessionId);
      }
    };

    channel.addEventListener('message', handleMessage);
    return () => {
      channel.removeEventListener('message', handleMessage);
      channel.close();
    };
  }, [currentCwd, onSwitchSession]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // 切换到指定 session
  const handleSessionClick = useCallback(async (session: GlobalSession) => {
    const targetUrl = `/?cwd=${encodeURIComponent(session.cwd)}&sessionId=${encodeURIComponent(session.sessionId)}`;

    // 如果是同项目，通过回调切换 session（无刷新）
    if (currentCwd === session.cwd) {
      if (onSwitchSession) {
        onSwitchSession(session.sessionId);
      } else {
        router.push(targetUrl);
      }
      setIsOpen(false);
      return;
    }

    // 检查 Service Worker 是否可用
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.ready;

        if (registration.active) {
          const messageChannel = new MessageChannel();

          const response = await new Promise<{ found: boolean }>((resolve) => {
            messageChannel.port1.onmessage = (event) => {
              resolve(event.data);
            };

            registration.active!.postMessage(
              {
                type: 'FIND_TAB',
                cwd: session.cwd,
                sessionId: session.sessionId,
              },
              [messageChannel.port2]
            );

            // 超时处理
            setTimeout(() => resolve({ found: false }), 500);
          });

          if (response.found) {
            // 已有 tab，发送通知让用户点击切换
            let permission = Notification.permission;
            if (permission === 'default') {
              permission = await Notification.requestPermission();
            }

            if (permission === 'granted') {
              const projectName = session.cwd.split('/').pop() || session.cwd;
              await registration.showNotification(`切换到 ${projectName}`, {
                body: '点击切换到该项目',
                tag: `switch-${session.cwd}`,
                data: { cwd: session.cwd, sessionId: session.sessionId },
              });
            }
            setIsOpen(false);
            return;
          }
        }
      } catch {
        // 忽略 SW 错误
      }
    }

    // 没有找到或 SW 不可用，打开新 tab
    window.open(targetUrl, '_blank');
    setIsOpen(false);
  }, [currentCwd, onSwitchSession, router]);

  const loadingCount = sessions.filter(s => s.isLoading).length;

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
        className="relative p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
        title="运行中的会话"
      >
        {/* 闪电图标表示活动状态 */}
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        {/* 红点 badge */}
        {loadingCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-xs font-medium rounded-full flex items-center justify-center">
            {loadingCount}
          </span>
        )}
      </button>

      {/* 下拉列表 */}
      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-popover border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/50">
            <span className="text-sm font-medium">最近会话</span>
            {loadingCount > 0 && (
              <span className="ml-2 text-xs text-red-500">({loadingCount} 运行中)</span>
            )}
          </div>
          <div>
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
                  {/* 状态指示器 */}
                  <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                    session.isLoading ? 'bg-green-500 animate-pulse' : 'bg-muted-foreground/30'
                  }`} />
                  <div className="flex-1 min-w-0" title={session.cwd}>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {getProjectName(session.cwd)}
                      </span>
                      {session.isLoading && (
                        <span className="text-xs text-green-500 flex-shrink-0">运行中</span>
                      )}
                      <span className="text-xs text-muted-foreground flex-shrink-0">
                        {formatTime(session.lastActive)}
                      </span>
                    </div>
                    {session.title && (
                      <div className="text-xs text-foreground/80 truncate">
                        {session.title}
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
