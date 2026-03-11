'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectItem } from './ProjectItem';
import { GlobalSessionMonitor, GlobalSession } from './GlobalSessionMonitor';
import { PinnedSessionsPanel } from './PinnedSessionsPanel';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { usePinnedSessions } from '@/hooks/usePinnedSessions';
import { useScheduledTasks } from '@/hooks/useScheduledTasks';
import { useWebSocket } from '@/hooks/useWebSocket';
import { showSessionCompleteToast } from './SessionCompleteToast';

export interface ProjectInfo {
  cwd: string;
  sessionId?: string;
}

interface ProjectSidebarProps {
  projects: ProjectInfo[];
  activeIndex: number;
  collapsed: boolean;
  currentCwd?: string;
  onSelectProject: (index: number) => void;
  onRemoveProject: (index: number) => void;
  onReorderProjects: (projects: ProjectInfo[]) => void;
  onToggleCollapse: () => void;
  onOpenSessionBrowser: () => void;
  onOpenSettings: () => void;
  onOpenNote: (cwd?: string) => void;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  currentActiveView?: string;  // 当前项目的 activeView (agent/explorer/console)
}

// 从 cwd 提取项目名称
function getProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function ProjectSidebar({
  projects,
  activeIndex,
  collapsed,
  currentCwd,
  onSelectProject,
  onRemoveProject,
  onReorderProjects,
  onToggleCollapse,
  onOpenSessionBrowser,
  onOpenSettings,
  onOpenNote,
  onSwitchProject,
  currentActiveView,
}: ProjectSidebarProps) {
  const { pinnedSessions, unpinSession, updateTitle, reorder } = usePinnedSessions();
  const { tasks: scheduledTasks, unreadCount: scheduledUnread, reload: reloadScheduled, pauseTask, resumeTask, deleteTask: deleteScheduledTask, updateTask: updateScheduledTask, markRead: markScheduledRead, reorderTasks } = useScheduledTasks();
  const [isHovered, setIsHovered] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [sessions, setSessions] = useState<GlobalSession[]>([]);
  // 按 sessionId 追踪未读状态（跟随 chat tab 的红点逻辑）
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(new Set());
  const prevLoadingSessionIdsRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // 通过 SSE 监听全局状态变化（替代 1s 轮询）
  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;

  const currentActiveViewRef = useRef(currentActiveView);
  currentActiveViewRef.current = currentActiveView;

  const reloadScheduledRef = useRef(reloadScheduled);
  reloadScheduledRef.current = reloadScheduled;

  const handleGlobalStateMessage = useCallback((msg: unknown) => {
    try {
      const parsed = msg as { type: string; data?: { sessions: GlobalSession[] } };

      // 定时任务触发通知
      if (parsed.type === 'task-fired') {
        reloadScheduledRef.current();
        return;
      }

      const { data } = parsed;
      if (!data) return;
      const newSessions: GlobalSession[] = data.sessions || [];
      setSessions(newSessions);

      const currentLoadingIds = new Set(
        newSessions.filter(s => s.isLoading).map(s => s.sessionId)
      );
      const prevLoading = prevLoadingSessionIdsRef.current;

      if (prevLoading.size > 0) {
        const allCompleted: string[] = [];   // 所有刚完成的 session
        const shouldMarkUnread: string[] = []; // 需要标记未读的
        prevLoading.forEach(sessionId => {
          if (!currentLoadingIds.has(sessionId)) {
            allCompleted.push(sessionId);
            const session = newSessions.find(s => s.sessionId === sessionId);
            if (session) {
              // 非当前项目 → 标记未读
              // 当前项目但明确不在 agent 屏（在 explorer/console）→ 也标记未读
              // 注意：undefined 视为 agent（默认视图，iframe 未发送 VIEW_CHANGE 前）
              const isOnAgent = !currentActiveViewRef.current || currentActiveViewRef.current === 'agent';
              if (session.cwd !== currentCwdRef.current || !isOnAgent) {
                shouldMarkUnread.push(sessionId);
              }
            }
          }
        });
        if (shouldMarkUnread.length > 0) {
          setUnreadSessionIds(prev => {
            const next = new Set(prev);
            shouldMarkUnread.forEach(id => next.add(id));
            return next;
          });
        }
        // 弹出左下角完成通知：所有完成的 session 都弹
        allCompleted.forEach(sessionId => {
          const session = newSessions.find(s => s.sessionId === sessionId);
          if (session) {
            showSessionCompleteToast({
              projectName: session.cwd.split('/').pop() || session.cwd,
              message: session.lastUserMessage || session.title,
              cwd: session.cwd,
              sessionId: session.sessionId,
            });
          }
        });
      }

      prevLoadingSessionIdsRef.current = currentLoadingIds;
    } catch {
      // 忽略解析错误
    }
  }, []);

  useWebSocket({
    url: '/ws/global-state',
    onMessage: handleGlobalStateMessage,
  });

  // 当切换到某个项目（且在 agent 屏）时，清除该项目所有 session 的未读状态
  // 仅依赖 currentCwd 和 currentActiveView，避免 sessions/unreadSessionIds 变化误触发
  // 注意：undefined 视为 agent（默认视图，iframe 未发送 VIEW_CHANGE 前）
  useEffect(() => {
    const isOnAgent = !currentActiveView || currentActiveView === 'agent';
    if (!currentCwd || !isOnAgent) return;
    const cwdSessionIds = sessionsRef.current
      .filter(s => s.cwd === currentCwd)
      .map(s => s.sessionId);
    setUnreadSessionIds(prev => {
      const hasUnread = cwdSessionIds.some(id => prev.has(id));
      if (!hasUnread) return prev;
      const next = new Set(prev);
      cwdSessionIds.forEach(id => next.delete(id));
      return next;
    });
  }, [currentCwd, currentActiveView]);

  // 清除指定 session 的未读状态（点击切换时调用）
  const handleClearUnread = useCallback((sessionId: string) => {
    setUnreadSessionIds(prev => {
      if (!prev.has(sessionId)) return prev;
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // 构建 cwd -> isLoading 的映射
  const loadingCwds = new Set(
    sessions.filter(s => s.isLoading).map(s => s.cwd)
  );

  // 从 unreadSessionIds 推导出哪些项目有未读（单一状态源）
  const unreadCwds = new Set(
    sessions.filter(s => unreadSessionIds.has(s.sessionId)).map(s => s.cwd)
  );

  // 拖拽开始
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  // 拖拽经过
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index);
    }
  }, [dragIndex]);

  // 拖拽结束
  const handleDrop = useCallback((targetIndex: number) => {
    if (dragIndex !== null && dragIndex !== targetIndex) {
      const newProjects = [...projects];
      const [removed] = newProjects.splice(dragIndex, 1);
      newProjects.splice(targetIndex, 0, removed);
      onReorderProjects(newProjects);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, projects, onReorderProjects]);

  // 拖拽离开
  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div
      className={`h-full bg-card border-r border-border flex flex-col transition-all duration-200 ${
        collapsed ? 'w-12' : 'w-56'
      }`}
    >
      {/* 浏览所有会话按钮 + 折叠按钮 */}
      <div
        className="p-2 border-b border-border relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSessionBrowser}
          title="浏览所有会话"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          {!collapsed && <span className="text-sm">浏览所有会话</span>}
        </button>
        {/* 折叠按钮 */}
        {isHovered && (
          collapsed ? (
            // 折叠状态：覆盖整个按钮区域
            <button
              className="absolute inset-0 m-2 flex items-center justify-center px-2 py-2 rounded-lg bg-accent text-foreground transition-colors z-10"
              onClick={onToggleCollapse}
              title="展开侧边栏"
            >
              <svg
                className="w-5 h-5 flex-shrink-0 rotate-180"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          ) : (
            // 展开状态：小按钮放右侧
            <button
              className="absolute top-1/2 -translate-y-1/2 right-2 p-2 rounded-lg bg-accent text-foreground transition-colors z-10"
              onClick={onToggleCollapse}
              title="折叠侧边栏"
            >
              <svg
                className="w-5 h-5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )
        )}
      </div>

      {/* 项目列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {projects.map((project, index) => (
          <div
            key={project.cwd}
            draggable
            onDragStart={() => handleDragStart(index)}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={() => handleDrop(index)}
            onDragEnd={handleDragEnd}
            className={`${
              dragOverIndex === index ? 'border-t-2 border-brand' : ''
            } ${dragIndex === index ? 'opacity-50' : ''}`}
          >
            <ProjectItem
              index={index}
              name={getProjectName(project.cwd)}
              cwd={project.cwd}
              isActive={index === activeIndex}
              collapsed={collapsed}
              hasUnread={unreadCwds.has(project.cwd)}
              isLoading={loadingCwds.has(project.cwd)}
              onClick={() => onSelectProject(index)}
              onRemove={() => onRemoveProject(index)}
              onOpenNote={() => onOpenNote(project.cwd)}
            />
          </div>
        ))}
      </div>

      {/* 底部按钮区域 */}
      <div className="p-2 border-t border-border space-y-1">
        {/* 最近会话 */}
        <GlobalSessionMonitor
          currentCwd={currentCwd}
          onSwitchProject={onSwitchProject}
          collapsed={collapsed}
          sessions={sessions}
          unreadSessionIds={unreadSessionIds}
          onClearUnread={handleClearUnread}
        />
        {/* 常用会话 */}
        <PinnedSessionsPanel
          collapsed={collapsed}
          pinnedSessions={pinnedSessions}
          onSwitchProject={onSwitchProject}
          onUnpin={unpinSession}
          onUpdateTitle={updateTitle}
          onReorder={reorder}
        />
        {/* 定时任务 */}
        <ScheduledTasksPanel
          collapsed={collapsed}
          tasks={scheduledTasks}
          unreadCount={scheduledUnread}
          onSwitchProject={onSwitchProject}
          onPause={pauseTask}
          onResume={resumeTask}
          onDelete={deleteScheduledTask}
          onMarkRead={markScheduledRead}
          onUpdateTask={updateScheduledTask}
          onReorder={reorderTasks}
        />
        {/* 笔记 */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={() => onOpenNote()}
          title="笔记"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {!collapsed && <span className="text-sm">笔记</span>}
        </button>
        {/* 设置按钮 */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSettings}
          title="设置"
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {!collapsed && <span className="text-sm">设置</span>}
        </button>
      </div>
    </div>
  );
}
