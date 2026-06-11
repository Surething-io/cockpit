'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectItem } from './ProjectItem';
import { GlobalSessionMonitor, GlobalSession } from '@cockpit/feature-agent';
import { PinnedSessionsPanel } from '@cockpit/feature-agent';
import { ScheduledTasksPanel } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { useWebSocket, toast } from '@cockpit/shared-ui';
import { useLatestVersion } from './useLatestVersion';

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
  onOpenSkills: () => void;
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
  onOpenSkills,
  onSwitchProject,
  onAddProject: _onAddProject,
}: ProjectSidebarProps) {
  const { t, i18n } = useTranslation();
  const { latest: latestVersion, hasUpdate } = useLatestVersion();
  const [updatePopoverOpen, setUpdatePopoverOpen] = useState(false);
  const updatePopoverRef = useRef<HTMLDivElement | null>(null);
  // Close popover when clicking anywhere outside it. The entire right
  // content area is a per-project <iframe> (see Workspace.tsx), so clicks
  // there never reach this document — but they do steal the parent
  // window's focus, hence the blur listener (same pattern as
  // GlobalSessionMonitor). Capture phase on mousedown so in-document
  // components that stopPropagation (e.g. xterm) can't swallow it.
  useEffect(() => {
    if (!updatePopoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!updatePopoverRef.current?.contains(e.target as Node)) {
        setUpdatePopoverOpen(false);
      }
    };
    const onBlur = () => setUpdatePopoverOpen(false);
    document.addEventListener('mousedown', onDocClick, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [updatePopoverOpen]);
  const copyUpgradeCmd = useCallback(() => {
    navigator.clipboard.writeText('cockpit update');
    toast(t('workspace.upgradeCommandCopied'));
    setUpdatePopoverOpen(false);
  }, [t]);
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
        {/* Skills */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSkills}
          title={t('workspace.skills')}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3l1.9 4.8L19 9l-4.1 3.1L16 18l-4-2.8L8 18l1.1-5.9L5 9l5.1-1.2L12 3z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.skills')}</span>}
        </button>
        {/* Settings row — the whole row is one click target (opens the
            Settings modal). Help is a secondary action nested inside the
            same row, positioned absolutely on the right like ProjectItem's
            note/close buttons. Clicking the Help icon stops propagation so
            it doesn't also fire Settings.

            Layout choices match the project-list item pattern:
              - Whole row uses a single hover background (one item, not two)
              - Help icon is small (w-3.5 h-3.5) like other secondary actions
              - Help link is hidden when the sidebar is collapsed — folding is
                a space-saving mode, and the help entry-point is for new users
                who would be in the expanded view anyway.

            The href computes zh/en from the live i18n language. Switching
            language in-app re-renders this component and updates the link. */}
        <div
          className={`relative flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSettings}
          title={t('workspace.settings')}
        >
          <div className="relative flex-shrink-0">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {/* Collapsed-state update marker: small red dot on the gear's
                top-right when there's an update — the only signal we can
                fit in a collapsed footer. */}
            {collapsed && hasUpdate && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500"
                title={latestVersion ? t('workspace.updateAvailable', { version: latestVersion }) : undefined}
              />
            )}
          </div>
          {!collapsed && <span className="flex-1 text-sm">{t('workspace.settings')}</span>}
          {/* Update version pill — only renders when there's a newer
              @surething/cockpit on npm. Brand-coloured, clickable, opens a
              small popover with the two actions (copy command, view
              changelog). stopPropagation everywhere so clicks here don't
              also fire the row-level Settings open. */}
          {!collapsed && hasUpdate && latestVersion && (
            /* -mr-2 fully cancels the row's `gap-2` so the version pill
               sits flush next to the Help icon — they read as one tight
               right-edge cluster. */
            <div ref={updatePopoverRef} className="relative -mr-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setUpdatePopoverOpen((v) => !v);
                }}
                className="px-1.5 py-0.5 rounded text-xs font-mono font-medium text-brand hover:bg-brand/10 transition-colors"
                title={t('workspace.updateAvailable', { version: latestVersion })}
                aria-label={t('workspace.updateAvailable', { version: latestVersion })}
              >
                v{latestVersion}
              </button>
              {updatePopoverOpen && (
                <div
                  /* Anchor to the version pill's top-right corner so the
                     popover floats into the main panel area (right + up),
                     not into the sidebar (which would clip on the left
                     edge given the sidebar is narrow). `left-full` puts
                     the popover's left edge at the pill's right edge;
                     `bottom-full` puts its bottom at the pill's top; the
                     small ml/mb gaps keep it visually detached. */
                  className="absolute left-full bottom-full ml-2 mb-1 w-56 rounded-lg border border-border bg-popover shadow-lg p-2 z-50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-xs text-muted-foreground mb-2 px-1">
                    {t('workspace.updateAvailable', { version: latestVersion })}
                  </div>
                  <button
                    type="button"
                    onClick={copyUpgradeCmd}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-accent transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <rect x="9" y="9" width="13" height="13" rx="2" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                    </svg>
                    {/* Label now contains the full command name inline
                        (no truncated separate `<code>` block on the
                        right), so it stays fully readable in a 224px
                        popover regardless of locale. */}
                    <span className="flex-1">{t('workspace.copyUpgradeCommand')}</span>
                  </button>
                  <a
                    href={`https://opencockpit.dev/${i18n.language?.startsWith('zh') ? 'zh' : 'en'}/changelog/`}
                    target="_blank"
                    rel="noopener"
                    onClick={() => setUpdatePopoverOpen(false)}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent transition-colors"
                  >
                    <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="flex-1">{t('workspace.viewChangelog')}</span>
                    <svg className="w-3 h-3 flex-shrink-0 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              )}
            </div>
          )}
          {!collapsed && (
            <a
              href={`https://opencockpit.dev/${i18n.language?.startsWith('zh') ? 'zh' : 'en'}/docs/get-started/quickstart/`}
              target="_blank"
              rel="noopener"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              onClick={(e) => e.stopPropagation()}
              title={t('workspace.help')}
              aria-label={t('workspace.help')}
            >
              {/* Lucide HelpCircle, inline SVG to stay consistent with the
                  rest of this footer (no Lucide React import). */}
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
              </svg>
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
