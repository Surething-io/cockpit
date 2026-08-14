'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectItem, type ProjectSessionBadge } from './ProjectItem';
import { GlobalSessionMonitor, GlobalSession } from '@cockpit/feature-agent';
import { PinnedSessionsPanel } from '@cockpit/feature-agent';
import { ScheduledTasksPanel } from '@cockpit/feature-agent';
import { usePinnedSessions } from '@cockpit/feature-agent';
import { useScheduledTasks } from '@cockpit/feature-agent';
import { useWebSocket, toast } from '@cockpit/shared-ui';
import { useLatestVersion } from './useLatestVersion';
import { useSelfUpdate } from './useSelfUpdate';
import { AppWindow, MoreHorizontal } from 'lucide-react';
import type { HtmlAppPreview } from '@cockpit/feature-explorer';

export interface ProjectInfo {
  cwd: string;
  sessionId?: string;
}

/** A w-56 row fits three 16px badges next to a truncated project name; beyond
 *  that they crowd out the name, and the overflow is one click away in the
 *  project's own session list anyway. Extras are dropped, not counted. */
const MAX_SESSION_BADGES = 3;

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
  onOpenApps: () => void;
  htmlAppPreviews: HtmlAppPreview[];
  activeHtmlAppPreviewPath: string | null;
  onShowHtmlAppPreview: (item: HtmlAppPreview) => void;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onResolveSessionNumbers: () => Promise<Record<string, string>>;
  /** Live tab order per project cwd, pushed up by each project iframe (null =
   *  a tab with no session yet). Absent for projects whose iframe has never
   *  been mounted (lazy load). */
  sessionOrders: Record<string, Array<string | null>>;
  /** Live "project.session" coordinates, keyed `${cwd}\n${sessionId}`. */
  sessionNumbers: Record<string, string>;
}

// Extract project name from cwd
function getProjectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function AppsDockIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="6" height="6" rx="1.5" />
      <rect x="4" y="14" width="6" height="6" rx="1.5" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" />
      <path d="M17 3v8" />
      <path d="M13 7h8" />
    </svg>
  );
}

function HtmlAppIcon({ item, active, onClick, className = '' }: {
  item: HtmlAppPreview;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 w-8 rounded-md border bg-transparent text-muted-foreground hover:text-brand hover:border-brand/70 active:scale-95 transition-all flex items-center justify-center ${
        active ? 'border-brand/80 text-brand' : 'border-border/70'
      } ${className}`}
      title={`${item.title}\n${item.path}`}
    >
      {item.icon ? <span className="text-base leading-none">{item.icon}</span> : <AppWindow className="w-4 h-4" />}
    </button>
  );
}

function HtmlAppPreviewDock({ collapsed, previews, activePath, onOpenApps, onShowPreview }: {
  collapsed: boolean;
  previews: HtmlAppPreview[];
  activePath: string | null;
  onOpenApps: () => void;
  onShowPreview: (item: HtmlAppPreview) => void;
}) {
  const { t } = useTranslation();
  const [popoverOpen, setPopoverOpen] = useState<'collapsed' | 'more' | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setPopoverOpen(null);
      }
    };
    document.addEventListener('mousedown', onDocClick, true);
    return () => document.removeEventListener('mousedown', onDocClick, true);
  }, [popoverOpen]);

  const maxExpandedItems = 5;
  const maxPreviewIcons = maxExpandedItems - 1;
  const hasOverflow = previews.length > maxPreviewIcons;
  const visibleItems = hasOverflow ? previews.slice(0, maxPreviewIcons - 1) : previews.slice(0, maxPreviewIcons);
  const overflowItems = hasOverflow ? previews.slice(maxPreviewIcons - 1) : [];
  const openAppsItem = (
    <button
      key="html-apps-list"
      type="button"
      onClick={() => { onOpenApps(); setPopoverOpen(null); }}
      className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
      title={t('htmlApps.title')}
    >
      <span className="h-7 w-7 flex-shrink-0 rounded-md border border-border/70 bg-transparent flex items-center justify-center">
        <AppsDockIcon className="w-4 h-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium truncate">{t('htmlApps.title')}</span>
      </span>
    </button>
  );
  const handleShowPreview = (item: HtmlAppPreview) => {
    onShowPreview(item);
    setPopoverOpen(null);
  };

  const renderList = (items: HtmlAppPreview[]) => (
    <div className="max-h-[19.75rem] overflow-y-auto p-1.5 space-y-1">
      {openAppsItem}
      {items.map((item) => (
        <button
          key={item.path}
          type="button"
          onClick={() => handleShowPreview(item)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-hover transition-colors ${
            activePath === item.path ? 'text-brand' : 'text-muted-foreground hover:text-foreground'
          }`}
          title={item.path}
        >
          <span className="h-7 w-7 flex-shrink-0 rounded-md border border-border/70 bg-transparent flex items-center justify-center">
            {item.icon ? <span className="text-base leading-none">{item.icon}</span> : <AppWindow className="w-4 h-4" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium truncate">{item.title}</span>
            <span className="block text-[10px] font-mono text-muted-foreground truncate">{item.path}</span>
          </span>
        </button>
      ))}
    </div>
  );

  if (collapsed) {
    return (
      <div ref={popoverRef} className="relative p-2 border-t border-border">
        <button
          type="button"
          onClick={() => setPopoverOpen((open) => (open === 'collapsed' ? null : 'collapsed'))}
          className={`w-full h-8 rounded-md border bg-transparent text-muted-foreground hover:text-brand hover:border-brand/70 transition-colors flex items-center justify-center ${
            activePath ? 'border-brand/80 text-brand' : 'border-border/70'
          }`}
          title={t('htmlApps.title')}
        >
          <AppsDockIcon className="w-4 h-4" />
        </button>
        {popoverOpen === 'collapsed' && (
          <div className="absolute left-full bottom-0 ml-2 w-64 rounded-lg border border-border bg-card shadow-lv3 z-50">
            {renderList(previews)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={popoverRef} className="p-2 border-t border-border">
      <div className="grid grid-cols-5 gap-1.5">
        <button
          type="button"
          onClick={onOpenApps}
          className="h-8 w-8 rounded-md border border-border/70 bg-transparent text-muted-foreground hover:text-brand hover:border-brand/70 active:scale-95 transition-all flex items-center justify-center"
          title={t('htmlApps.title')}
        >
          <AppsDockIcon className="w-4 h-4" />
        </button>
        {visibleItems.map((item) => (
          <HtmlAppIcon
            key={item.path}
            item={item}
            active={activePath === item.path}
            onClick={() => handleShowPreview(item)}
          />
        ))}
        {hasOverflow && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setPopoverOpen((open) => (open === 'more' ? null : 'more'))}
              className="h-8 w-8 rounded-md border border-border/70 bg-transparent text-muted-foreground hover:text-brand hover:border-brand/70 transition-colors flex items-center justify-center"
              title={t('common.loadMore')}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {popoverOpen === 'more' && (
              <div className="absolute left-0 bottom-full mb-2 w-64 rounded-lg border border-border bg-card shadow-lv3 z-50">
                {renderList(overflowItems)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
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
  onOpenApps,
  htmlAppPreviews,
  activeHtmlAppPreviewPath,
  onShowHtmlAppPreview,
  onSwitchProject,
  onResolveSessionNumbers,
  sessionOrders,
  sessionNumbers,
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
  const { phase: updatePhase, error: updateError, start: startUpdate } = useSelfUpdate();
  const isUpdating = updatePhase === 'starting' || updatePhase === 'waiting';
  useEffect(() => {
    if (updatePhase === 'done') {
      // Only reports that the server is back. Whether the page itself is now
      // stale is ServerRestartedBanner's call — it compares build ids, so it
      // stays silent when the reinstall was a no-op (already latest).
      toast(t('workspace.updateComplete'));
      setUpdatePopoverOpen(false);
    } else if (updatePhase === 'failed') {
      toast(t('workspace.updateFailed', { reason: updateError ?? '' }), 'error');
    }
  }, [updatePhase, updateError, t]);
  const { pinnedSessions, unpinSession, updateTitle, reorder } = usePinnedSessions();
  const { tasks: scheduledTasks, unreadCount: scheduledUnread, reload: reloadScheduled, pauseTask, resumeTask, triggerTask, deleteTask: deleteScheduledTask, updateTask: updateScheduledTask, markRead: markScheduledRead } = useScheduledTasks();
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

  // Per-project session badges: only sessions that are generating or done-but-
  // unread earn one, so a quiet project row stays clean. Ordered by the session's
  // live position in that project's tab bar (the number you can point at), which
  // means a tab drag renumbers these too. Sessions whose project iframe is not
  // mounted yet have no known position and sort last with a '·' placeholder.
  const badgesByCwd = useMemo(() => {
    const map = new Map<string, ProjectSessionBadge[]>();
    for (const project of projects) {
      const order = sessionOrders[project.cwd] ?? [];
      const items = sessions
        .filter((s) => s.cwd === project.cwd && (s.status === 'loading' || s.status === 'unread'))
        .map((s) => ({ session: s, position: order.indexOf(s.sessionId) }))
        .sort((a, b) => {
          if (a.position >= 0 && b.position >= 0) return a.position - b.position;
          if (a.position >= 0) return -1;
          if (b.position >= 0) return 1;
          return b.session.lastActive - a.session.lastActive;
        })
        .slice(0, MAX_SESSION_BADGES)
        .map(({ session, position }): ProjectSessionBadge => ({
          sessionId: session.sessionId,
          label: position >= 0 ? String(position + 1) : '·',
          status: session.status === 'loading' ? 'loading' : 'unread',
        }));
      if (items.length > 0) map.set(project.cwd, items);
    }
    return map;
  }, [projects, sessions, sessionOrders]);

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
      <div className="group p-2 border-b border-border relative">
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSessionBrowser}
          // Collapsed-only: expanded state already renders the same label below.
          title={collapsed ? t('workspace.openProject') : undefined}
        >
          {/* Same folder mark as the other two entry points to this action
              (EmptyState's button and SessionBrowser's "open folder"), so the
              icon reads as "open a project" wherever it appears. */}
          <svg className="w-5 h-5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 10v6m3-3H9m-4 7h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.openProject')}</span>}
        </button>
        {/* Collapse button — hidden until hover on pointer devices, always shown on touch (hover: none) */}
        {collapsed ? (
          // Collapsed state: overlay the entire button area
          <button
            className="absolute inset-0 m-2 flex items-center justify-center px-2 py-2 rounded-lg bg-popover shadow-lv1 text-foreground transition z-10 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
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
            className="absolute top-1/2 -translate-y-1/2 right-2 p-2 rounded-lg bg-popover shadow-lv1 text-foreground transition z-10 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
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
              sessionBadges={badgesByCwd.get(project.cwd)}
              onClick={() => onSelectProject(index)}
              onSelectSession={(sessionId) => onSwitchProject(project.cwd, sessionId)}
              onRemove={() => onRemoveProject(index)}
              onOpenNote={() => onOpenNote(project.cwd)}
            />
          </div>
        ))}
      </div>

      <HtmlAppPreviewDock
        collapsed={collapsed}
        previews={htmlAppPreviews}
        activePath={activeHtmlAppPreviewPath}
        onOpenApps={onOpenApps}
        onShowPreview={onShowHtmlAppPreview}
      />

      {/* Bottom button area */}
      <div className="p-2 border-t border-border space-y-1">
        {/* Recent sessions */}
        <GlobalSessionMonitor
          currentCwd={currentCwd}
          onSwitchProject={onSwitchProject}
          onResolveSessionNumbers={onResolveSessionNumbers}
          collapsed={collapsed}
          sessions={sessions}
        />
        {/* Pinned sessions */}
        <PinnedSessionsPanel
          collapsed={collapsed}
          pinnedSessions={pinnedSessions}
          sessionNumbers={sessionNumbers}
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
          sessionNumbers={sessionNumbers}
          onSwitchProject={onSwitchProject}
          onPause={pauseTask}
          onResume={resumeTask}
          onTrigger={triggerTask}
          onDelete={deleteScheduledTask}
          onMarkRead={markScheduledRead}
          onUpdateTask={updateScheduledTask}
        />
        {/* Notes */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={() => onOpenNote()}
          title={collapsed ? t('workspace.notes') : undefined}
        >
          <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          {!collapsed && <span className="text-sm">{t('workspace.notes')}</span>}
        </button>
        {/* Skills */}
        <button
          className={`w-full flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
            collapsed ? 'justify-center' : ''
          }`}
          onClick={onOpenSkills}
          title={collapsed ? t('workspace.skills') : undefined}
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
          className={`relative flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
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
                  className="absolute left-full bottom-full ml-2 mb-1 w-56 rounded-lg border border-border bg-popover shadow-lv2 p-2 z-50"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-xs text-muted-foreground mb-2 px-1">
                    {t('workspace.updateAvailable', { version: latestVersion })}
                  </div>
                  {/* Primary action: the server updates itself and comes back.
                      Copying the command stays below for anyone who would
                      rather drive it from a terminal. */}
                  <button
                    type="button"
                    onClick={startUpdate}
                    disabled={isUpdating}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left
                               hover:bg-hover transition-colors disabled:opacity-60 disabled:cursor-default"
                  >
                    {isUpdating ? (
                      <svg className="w-3.5 h-3.5 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth={4} />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    <span className="flex-1">
                      {isUpdating ? t('workspace.updating') : t('workspace.updateNow')}
                    </span>
                  </button>
                  {isUpdating && (
                    // Say it plainly: a foreground `cockpit` does not stay in
                    // the foreground across an update — the terminal that owned
                    // it has already been released by the time we respawn.
                    <div className="text-[11px] leading-snug text-muted-foreground px-2 pb-1.5">
                      {t('workspace.updateRestartNote')}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={copyUpgradeCmd}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left hover:bg-hover transition-colors"
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
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-hover transition-colors"
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
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
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
