'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectItem } from './ProjectItem';
import { GlobalSessionMonitor, GlobalSession } from './GlobalSessionMonitor';
import { PinnedSessionsPanel } from './PinnedSessionsPanel';
import { ScheduledTasksPanel } from './ScheduledTasksPanel';
import { usePinnedSessions } from '@/hooks/usePinnedSessions';
import { useScheduledTasks } from '@/hooks/useScheduledTasks';
import { useWebSocket } from '@/hooks/useWebSocket';

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
  onAddProject: (cwd: string) => void;
}

// Extract project name from cwd
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
  onAddProject,
}: ProjectSidebarProps) {
  const { t } = useTranslation();
  const { pinnedSessions, unpinSession, updateTitle, reorder } = usePinnedSessions();
  const { tasks: scheduledTasks, unreadCount: scheduledUnread, reload: reloadScheduled, pauseTask, resumeTask, triggerTask, deleteTask: deleteScheduledTask, updateTask: updateScheduledTask, markRead: markScheduledRead, reorderTasks } = useScheduledTasks();
  const [isHovered, setIsHovered] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [sessions, setSessions] = useState<GlobalSession[]>([]);
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; });

  const reloadScheduledRef = useRef(reloadScheduled);
  useEffect(() => { reloadScheduledRef.current = reloadScheduled; });

  const handleGlobalStateMessage = useCallback((msg: unknown) => {
    try {
      const parsed = msg as { type: string; data?: { sessions: GlobalSession[] } };

      // Scheduled task trigger notification
      if (parsed.type === 'task-fired') {
        reloadScheduledRef.current();
        return;
      }

      const { data } = parsed;
      if (!data) return;
      setSessions(data.sessions || []);
    } catch {
      // Ignore parse errors
    }
  }, []);

  useWebSocket({
    url: '/ws/global-state',
    onMessage: handleGlobalStateMessage,
  });

  // Derive dot state directly from session.status (single source of truth: state.json)
  const loadingCwds = new Set(
    sessions.filter(s => s.status === 'loading').map(s => s.cwd)
  );
  const unreadCwds = new Set(
    sessions.filter(s => s.status === 'unread').map(s => s.cwd)
  );

  // Drag start
  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  // Drag over
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== index) {
      setDragOverIndex(index);
    }
  }, [dragIndex]);

  // Drop
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

  // Drag end
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
      {/* Open project button + collapse button */}
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
          title={t('workspace.openProject')}
        >
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.openProject')}</span>}
        </button>
        {/* Collapse button */}
        {isHovered && (
          collapsed ? (
            // Collapsed state: overlay the entire button area
            <button
              className="absolute inset-0 m-2 flex items-center justify-center px-2 py-2 rounded-lg bg-accent text-foreground transition-colors z-10"
              onClick={onToggleCollapse}
              title={t('workspace.expandSidebar')}
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
            <button
              className="absolute top-1/2 -translate-y-1/2 right-2 p-2 rounded-lg bg-accent text-foreground transition-colors z-10"
              onClick={onToggleCollapse}
              title={t('workspace.collapseSidebar')}
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

      {/* Project list */}
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

      {/* Bottom button area */}
      <div className="p-2 border-t border-border space-y-1">
        {/* Recent sessions */}
        <GlobalSessionMonitor
          currentCwd={currentCwd}
          onSwitchProject={onSwitchProject}
          collapsed={collapsed}
          sessions={sessions}
        />
        {/* Pinned sessions */}
        <PinnedSessionsPanel
          collapsed={collapsed}
          pinnedSessions={pinnedSessions}
          onSwitchProject={onSwitchProject}
          onUnpin={unpinSession}
          onUpdateTitle={updateTitle}
          onReorder={reorder}
        />
        {/* Scheduled tasks */}
        <ScheduledTasksPanel
          collapsed={collapsed}
          tasks={scheduledTasks}
          unreadCount={scheduledUnread}
          onSwitchProject={onSwitchProject}
          onPause={pauseTask}
          onResume={resumeTask}
          onTrigger={triggerTask}
          onDelete={deleteScheduledTask}
          onMarkRead={markScheduledRead}
          onUpdateTask={updateScheduledTask}
          onReorder={reorderTasks}
        />
        {/* Notes */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={() => onOpenNote()}
          title={t('workspace.notes')}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.notes')}</span>}
        </button>
        {/* Settings button */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSettings}
          title={t('workspace.settings')}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.settings')}</span>}
        </button>
      </div>
    </div>
  );
}
