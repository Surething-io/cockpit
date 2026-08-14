'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import type { ScheduledTask } from './useScheduledTasks';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { MdPreviewModal } from './MdPreviewModal';
import { EngineBadge } from './EngineBadge';
import { SessionNumberBadge } from './SessionNumberBadge';
import { readFileForPreview } from './effect/agentClient';

interface ScheduledTasksPanelProps {
  collapsed?: boolean;
  tasks: ScheduledTask[];
  unreadCount: number;
  /** Live "project.session" coordinates keyed `${cwd}\n${sessionId}`. A task
   *  whose target session has no open tab simply has no coordinate. */
  sessionNumbers?: Record<string, string>;
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

// Design-system `-11` steps, not raw Tailwind `red-500` / `yellow-500` /
// `green-500`: the `-11` steps track the theme, so these dots stay readable on
// the light card as well as the dark one.
function getStatusColor(task: ScheduledTask): string {
  if (task.unread) return 'bg-red-11';
  if (task.completed) return 'bg-muted-foreground/30';
  if (task.paused) return 'bg-amber-11';
  if (task.lastResult === 'error') return 'bg-red-11';
  return 'bg-green-11';
}

/**
 * What the card shows as the task's instruction: the exact prompt that will be
 * dispatched, so "what the card says" and "what the agent receives" cannot drift.
 * The server computes it (buildTaskPrompt); the fallbacks cover tasks fetched
 * before that field existed.
 */
function getTaskSummary(task: ScheduledTask): string {
  return task.resolvedPrompt || task.message || task.taskFile || '';
}

/**
 * The engine this task will actually fire on. `engine` is a snapshot taken at
 * creation and is absent on tasks made before it was persisted — those run on
 * claude, which is also what the dispatcher falls back to (sendChatMessageEff).
 */
function getTaskEngine(task: ScheduledTask): string {
  return task.engine || 'claude';
}

/** Model is only meaningful for the engines that carry one; keep it in the tooltip. */
function getEngineTooltip(task: ScheduledTask): string {
  const engine = getTaskEngine(task);
  return task.model ? `${engine} · ${task.model}` : engine;
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
  sessionNumbers,
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
  // Task-file preview: the path is set on click, the content arrives async.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);

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

  // Read the task file when a preview opens. The path is absolute and may sit
  // outside any project, so this goes through /api/file rather than the
  // cwd-relative file routes.
  useEffect(() => {
    if (!previewPath) return;
    let cancelled = false;
    // Drop any previous file's content first: the modal renders as soon as both
    // are set, so a stale body would flash before this fetch lands.
    setPreviewContent(null);
    BrowserRuntime.runPromiseExit(readFileForPreview(previewPath)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success' && exit.value.content !== undefined) {
        setPreviewContent(exit.value.content);
      } else {
        // Deleted, moved, too large or binary — the same failure the dispatcher
        // pre-checks for. Drop back to the board instead of showing an empty shell.
        toast(t('toast.readFileFailed'), 'error');
        setPreviewPath(null);
      }
    });
    return () => { cancelled = true; };
  }, [previewPath, t]);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    setPreviewContent(null);
  }, []);

  /**
   * One copy button per card, carrying whichever half of the mutually-exclusive
   * pair the task actually uses: the absolute path for a file-backed task, the
   * text for a typed one. Both are values the card can only ever show truncated.
   */
  const handleCopy = useCallback(async (task: ScheduledTask) => {
    const isFile = !!task.taskFile;
    try {
      await navigator.clipboard.writeText(isFile ? task.taskFile! : task.message);
      toast(t(isFile ? 'common.copiedPath' : 'toast.copiedMessage'), 'success');
    } catch {
      // Clipboard writes reject without a user gesture or on an insecure origin.
      toast(t('common.copyFailed'), 'error');
    }
  }, [t]);

  // Close on ESC — the edit dialog and the preview both sit above and own their
  // own ESC, so the board must not also swallow the same keypress and close.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (previewPath) { closePreview(); return; }
      if (!editingTask) setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, editingTask, previewPath, closePreview]);

  const renderActions = (task: ScheduledTask) => (
    <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {/* Preview — only a file-backed task has something to show */}
      {task.taskFile && (
        <button
          onClick={(e) => { e.stopPropagation(); setPreviewPath(task.taskFile!); }}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title={t('common.preview')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        </button>
      )}
      {/* Copy — the path for a file task, the text for a typed one */}
      <button
        onClick={(e) => { e.stopPropagation(); handleCopy(task); }}
        className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        title={t(task.taskFile ? 'common.copyPath' : 'common.copy')}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      </button>
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
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-green-11"
          title={t('scheduledTasks.resume')}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          </svg>
        </button>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); onPause(task.id); }}
          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-amber-11"
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
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-hover transition-colors ${
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
          <span className={`min-w-[18px] h-[18px] px-1 text-foreground text-xs font-medium rounded-full flex items-center justify-center bg-red-9/55 ${
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
          <div className="absolute inset-0 bg-scrim" onClick={() => setIsOpen(false)} />

          {/* Modal */}
          <div className="relative w-full max-w-7xl h-[90vh] mx-4 bg-card rounded-lg shadow-lv3 flex flex-col overflow-hidden">
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
                className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
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
                          className={`group p-3 bg-secondary rounded border hover:border-brand hover:shadow-lv2 cursor-pointer transition-all ${
                            task.unread ? 'border-brand/40 bg-brand/5' : 'border-border'
                          }`}
                        >
                          {/* Project name + status dot + engine */}
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                            <EngineBadge engine={getTaskEngine(task)} tooltip={getEngineTooltip(task)} />
                            <h4 className="text-xs font-medium text-foreground truncate flex-1" data-tooltip={task.cwd}>
                              {getProjectName(task.cwd)}
                            </h4>
                            <SessionNumberBadge coordinate={sessionNumbers?.[`${task.cwd}\n${task.sessionId}`]} />
                            <span className="text-[10px] text-muted-foreground flex-shrink-0 group-hover:hidden">
                              {getStatusText(task, t)}
                            </span>
                            {renderActions(task)}
                          </div>

                          {/* Task message */}
                          <div className="text-xs text-foreground line-clamp-3 mb-1 whitespace-pre-wrap break-words" data-tooltip={getTaskSummary(task)}>
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
                            className="group p-3 bg-secondary rounded border border-border opacity-60 hover:opacity-100 hover:border-brand hover:shadow-lv2 cursor-pointer transition-all"
                          >
                            <div className="flex items-center gap-1.5 mb-1">
                              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                              <EngineBadge engine={getTaskEngine(task)} tooltip={getEngineTooltip(task)} />
                              <h4 className="text-xs font-medium text-foreground truncate flex-1" data-tooltip={task.cwd}>
                                {getProjectName(task.cwd)}
                              </h4>
                              <SessionNumberBadge coordinate={sessionNumbers?.[`${task.cwd}\n${task.sessionId}`]} />
                              {renderActions(task)}
                            </div>
                            <div className="text-xs text-foreground line-clamp-3 mb-1 whitespace-pre-wrap break-words" data-tooltip={getTaskSummary(task)}>
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

      {/* Task file preview — z-[80] clears the board (z-[70]) but stays under the
          edit dialog (z-[100]); Portal renders to <body>, so without this it
          would land beneath the board that opened it. cwd is the file's own
          directory, NOT task.cwd: a task file may live outside that project. */}
      {previewPath && previewContent !== null && (
        <MdPreviewModal
          filePath={previewPath}
          content={previewContent}
          cwd={previewPath.slice(0, Math.max(0, previewPath.lastIndexOf('/')))}
          onClose={closePreview}
          zClassName="z-[80]"
        />
      )}

      {/* Edit modal */}
      {editingTask && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim" onClick={() => setEditingTask(null)} />
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
