'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScheduledTask } from './useScheduledTasks';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';

interface ScheduledTasksPanelProps {
  collapsed?: boolean;
  tasks: ScheduledTask[];
  unreadCount: number;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onTrigger: (id: string) => void;
  onDelete: (id: string) => void;
  onMarkRead: (id: string) => void;
  onUpdateTask: (id: string, fields: Partial<Pick<ScheduledTask, 'message' | 'taskFile' | 'type' | 'delayMinutes' | 'intervalMinutes' | 'activeFrom' | 'activeTo' | 'cron'>>) => void;
}

function getProjectName(cwd: string): string {
  return cwd.split('/').pop() || cwd;
}

function formatNextFire(ts: number, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!ts) return '-';
  const diff = ts - Date.now();
  if (diff <= 0) return t('scheduledTasks.aboutToTrigger');
  if (diff < 60000) return t('scheduledTasks.secondsLater', { count: Math.ceil(diff / 1000) });
  if (diff < 3600000) return t('scheduledTasks.minutesLater', { count: Math.ceil(diff / 60000) });
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.ceil((diff % 3600000) / 60000);
    return m > 0 ? t('scheduledTasks.hoursMinutesLater', { h, m }) : t('scheduledTasks.hoursLater', { h });
  }
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatType(task: ScheduledTask, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (task.type === 'once') return t('scheduledTasks.onceType', { minutes: task.delayMinutes });
  if (task.type === 'interval') {
    const base = t('scheduledTasks.everyNMinutes', { minutes: task.intervalMinutes });
    if (task.activeFrom && task.activeTo) return `${base} (${task.activeFrom}-${task.activeTo})`;
    return base;
  }
  if (task.type === 'cron') return task.cron || 'cron';
  return task.type;
}

function getStatusColor(task: ScheduledTask): string {
  if (task.unread) return 'bg-red-500';
  if (task.completed) return 'bg-muted-foreground/30';
  if (task.paused) return 'bg-yellow-500';
  if (task.lastResult === 'error') return 'bg-red-500';
  return 'bg-green-500';
}

/**
 * What the card shows as the task's instruction. A taskFile task has no message, so
 * it renders the file's basename — the absolute path would be truncated to
 * uselessness in a three-column grid, and the full path is on the tooltip anyway.
 */
function getTaskSummary(task: ScheduledTask): string {
  if (!task.taskFile) return task.message;
  return task.taskFile.split('/').pop() || task.taskFile;
}

function getStatusText(task: ScheduledTask, t: (key: string) => string): string {
  if (task.completed) return t('scheduledTasks.completed');
  if (task.paused) return t('scheduledTasks.paused');
  return t('common.running');
}

/**
 * ScheduledTasksPanel — the sidebar clock button plus the full-viewport task
 * board it opens.
 *
 * Visually aligned with RecentSessionsModal (same modal shell + grid card
 * layout), so the sidebar's two "list of things happening elsewhere" surfaces
 * read the same. Unlike that modal there is no search box and no loading /
 * error state: tasks arrive as props from useScheduledTasks and stay in the
 * low tens, so filtering would be dead weight.
 *
 * Uses a full-viewport `fixed inset-0` overlay so it escapes the three-panel
 * SwipeableViewContainer boundaries (see CLAUDE.md UI layout notes).
 */
export function ScheduledTasksPanel({
  collapsed,
  tasks,
  unreadCount,
  onSwitchProject,
  onPause,
  onResume,
  onTrigger,
  onDelete,
  onMarkRead,
  onUpdateTask,
}: ScheduledTasksPanelProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);

  const activeTasks = tasks.filter(t => !t.completed);
  const runningCount = activeTasks.filter(t => !t.paused).length;
  const completedTasks = tasks.filter(t => t.completed);

  // Auto-refresh display (countdown)
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(timer);
  }, [isOpen]);

  // Close on ESC — the edit dialog sits above and handles its own ESC first
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editingTask) setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, editingTask]);

  const renderActions = (task: ScheduledTask) => (
    <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {/* Run immediately */}
      <button
        onClick={(e) => { e.stopPropagation(); onTrigger(task.id); }}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-brand"
        title={t('scheduledTasks.runNow')}
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
      {/* Edit */}
      <button
        onClick={(e) => { e.stopPropagation(); setEditingTask(task); }}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        title={t('common.edit')}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
      {/* Pause/Resume — omitted once completed: resumeTask clears `paused` but not
          `completed`, and updateTask only re-arms a timer when both are false, so
          the button would be a no-op. Re-scheduling goes through Edit instead,
          which does clear `completed` (see scheduledTasksApi dispatchPatch). */}
      {task.completed ? null : task.paused ? (
        <button
          onClick={(e) => { e.stopPropagation(); onResume(task.id); }}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-green-500"
          title={t('scheduledTasks.resume')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          </svg>
        </button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onPause(task.id); }}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-yellow-500"
          title={t('scheduledTasks.pause')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6" />
          </svg>
        </button>
      )}
      {/* Delete */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
        title={t('common.delete')}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title={collapsed ? t('scheduledTasks.title') : undefined}
      >
        {/* Clock icon */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" strokeWidth={2} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">{t('scheduledTasks.title')}</span>}
        {/* Red dot / count badge */}
        {unreadCount > 0 ? (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-red-500 ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        ) : collapsed && tasks.length > 0 ? (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-accent">
            {tasks.length}
          </span>
        ) : null}
      </button>

      {/* Task board */}
      {isOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/50" onClick={() => setIsOpen(false)} />

          {/* Modal */}
          <div className="relative w-full max-w-7xl h-[90vh] mx-4 bg-card rounded-lg shadow-xl flex flex-col overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-sm font-medium text-foreground">{t('scheduledTasks.title')}</h2>
                {activeTasks.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t('scheduledTasks.activeCount', { running: runningCount })}
                    {activeTasks.length - runningCount > 0
                      ? ` · ${t('scheduledTasks.pausedCount', { paused: activeTasks.length - runningCount })}`
                      : ''}
                  </span>
                )}
              </div>
              <button
                onClick={() => setIsOpen(false)}
                className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {tasks.length === 0 ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-xs text-muted-foreground">{t('scheduledTasks.noScheduledTasks')}</div>
                </div>
              ) : (
                <>
                  {/* Active tasks */}
                  {activeTasks.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {activeTasks.map((task) => (
                        <div
                          key={task.id}
                          onClick={() => {
                            onSwitchProject(task.cwd, task.sessionId);
                            if (task.unread) onMarkRead(task.id);
                            setIsOpen(false);
                          }}
                          className={`group p-3 bg-secondary rounded border hover:border-brand hover:shadow-md cursor-pointer transition-all ${
                            task.unread ? 'border-brand/40 bg-brand/5' : 'border-border'
                          }`}
                        >
                          {/* Project name + status dot */}
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                            <h4 className="text-xs font-medium text-foreground truncate flex-1" data-tooltip={task.cwd}>
                              {getProjectName(task.cwd)}
                            </h4>
                            <span className="text-[10px] text-muted-foreground flex-shrink-0 group-hover:hidden">
                              {getStatusText(task, t)}
                            </span>
                            {renderActions(task)}
                          </div>

                          {/* Task message */}
                          <div className="text-xs text-foreground line-clamp-2 mb-1" data-tooltip={task.taskFile || task.message}>
                            {getTaskSummary(task)}
                          </div>

                          {/* Schedule + next fire */}
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="truncate">{formatType(task, t)}</span>
                            <span>·</span>
                            <span className="flex-shrink-0">
                              {task.paused ? t('scheduledTasks.paused') : formatNextFire(task.nextFireTime, t)}
                            </span>
                            {task.lastFiredAt && (
                              <>
                                <span>·</span>
                                <span className="flex-shrink-0">
                                  {t('scheduledTasks.lastResult')}: {task.lastResult === 'success' ? '✓' : '✗'}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Completed tasks */}
                  {completedTasks.length > 0 && (
                    <>
                      <div className={`text-xs text-muted-foreground mb-2 ${activeTasks.length > 0 ? 'mt-5' : ''}`}>
                        {t('scheduledTasks.completedCount', { count: completedTasks.length })}
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {completedTasks.map((task) => (
                          <div
                            key={task.id}
                            onClick={() => {
                              onSwitchProject(task.cwd, task.sessionId);
                              setIsOpen(false);
                            }}
                            className="group p-3 bg-secondary rounded border border-border opacity-60 hover:opacity-100 hover:border-brand hover:shadow-md cursor-pointer transition-all"
                          >
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                              <h4 className="text-xs font-medium text-foreground truncate flex-1" data-tooltip={task.cwd}>
                                {getProjectName(task.cwd)}
                              </h4>
                              {renderActions(task)}
                            </div>
                            <div className="text-xs text-foreground line-clamp-2 mb-1" data-tooltip={task.taskFile || task.message}>
                              {getTaskSummary(task)}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {formatType(task, t)} · {task.lastResult === 'success' ? t('scheduledTasks.success') : t('scheduledTasks.failure')}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit modal */}
      {editingTask && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setEditingTask(null)} />
          <div className="relative">
            <ScheduleTaskPopover
              onClose={() => setEditingTask(null)}
              onCreate={() => {}}
              editTask={{
                id: editingTask.id,
                message: editingTask.message,
                taskFile: editingTask.taskFile,
                type: editingTask.type,
                delayMinutes: editingTask.delayMinutes,
                intervalMinutes: editingTask.intervalMinutes,
                activeFrom: editingTask.activeFrom,
                activeTo: editingTask.activeTo,
                cron: editingTask.cron,
              }}
              onUpdate={(id, params) => {
                onUpdateTask(id, params);
                setEditingTask(null);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
