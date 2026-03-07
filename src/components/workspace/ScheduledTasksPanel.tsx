'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { ScheduledTask } from '@/hooks/useScheduledTasks';
import { ScheduleTaskPopover } from '@/components/project/ScheduleTaskPopover';

interface ScheduledTasksPanelProps {
  collapsed?: boolean;
  tasks: ScheduledTask[];
  unreadCount: number;
  onSwitchProject: (cwd: string, sessionId: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onDelete: (id: string) => void;
  onMarkRead: (id: string) => void;
  onUpdateTask: (id: string, fields: Partial<Pick<ScheduledTask, 'message' | 'type' | 'delayMinutes' | 'intervalMinutes' | 'activeFrom' | 'activeTo' | 'cron'>>) => void;
  onReorder: (orderedIds: string[]) => void;
}

function getProjectName(cwd: string): string {
  return cwd.split('/').pop() || cwd;
}

function formatNextFire(ts: number): string {
  if (!ts) return '-';
  const diff = ts - Date.now();
  if (diff <= 0) return '即将触发';
  if (diff < 60000) return `${Math.ceil(diff / 1000)}秒后`;
  if (diff < 3600000) return `${Math.ceil(diff / 60000)}分钟后`;
  if (diff < 86400000) {
    const h = Math.floor(diff / 3600000);
    const m = Math.ceil((diff % 3600000) / 60000);
    return `${h}小时${m > 0 ? m + '分' : ''}后`;
  }
  return new Date(ts).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatType(task: ScheduledTask): string {
  if (task.type === 'once') return `一次性 (${task.delayMinutes}分钟)`;
  if (task.type === 'interval') {
    const base = `每${task.intervalMinutes}分钟`;
    if (task.activeFrom && task.activeTo) return `${base} (${task.activeFrom}-${task.activeTo})`;
    return base;
  }
  if (task.type === 'cron') return task.cron || 'cron';
  return task.type;
}

function getStatusColor(task: ScheduledTask): string {
  if (task.completed) return 'bg-muted-foreground';
  if (task.paused) return 'bg-yellow-500';
  if (task.lastResult === 'error') return 'bg-red-500';
  return 'bg-green-500';
}

function getStatusText(task: ScheduledTask): string {
  if (task.completed) return '已完成';
  if (task.paused) return '已暂停';
  return '运行中';
}

export function ScheduledTasksPanel({
  collapsed,
  tasks,
  unreadCount,
  onSwitchProject,
  onPause,
  onResume,
  onDelete,
  onMarkRead,
  onUpdateTask,
  onReorder,
}: ScheduledTasksPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeTasks = tasks.filter(t => !t.completed);
  const runningCount = activeTasks.filter(t => !t.paused).length;
  const completedTasks = tasks.filter(t => t.completed);

  // 拖动排序状态
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const newList = [...activeTasks];
    const [moved] = newList.splice(dragIndex, 1);
    newList.splice(index, 0, moved);
    // 活跃任务新顺序 + 已完成任务保持原序
    onReorder([...newList, ...completedTasks].map(t => t.id));
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, activeTasks, completedTasks, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  // 自动刷新显示（倒计时）
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!isOpen) return;
    const timer = setInterval(() => setTick(t => t + 1), 10000);
    return () => clearInterval(timer);
  }, [isOpen]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleBlur = () => setIsOpen(false);
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('blur', handleBlur);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('blur', handleBlur);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative flex items-center gap-2 px-2 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors ${
          collapsed ? 'w-full justify-center' : 'w-full'
        }`}
        title="定时任务"
      >
        {/* 时钟图标 */}
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" strokeWidth={2} />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2" />
        </svg>
        {!collapsed && <span className="text-sm flex-1 text-left">定时任务</span>}
        {/* 红点 / 数量 */}
        {unreadCount > 0 ? (
          <span className={`min-w-[18px] h-[18px] px-1 text-white text-xs font-medium rounded-full flex items-center justify-center bg-red-500 ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {unreadCount}
          </span>
        ) : tasks.length > 0 ? (
          <span className={`min-w-[18px] h-[18px] px-1 text-muted-foreground text-xs font-medium rounded-full flex items-center justify-center bg-accent ${
            collapsed ? 'absolute -top-1 -right-1' : ''
          }`}>
            {tasks.length}
          </span>
        ) : null}
      </button>

      {/* 下拉面板 */}
      {isOpen && (
        <div className="absolute left-full bottom-0 ml-2 w-96 max-h-[500px] bg-popover border border-border rounded-lg shadow-lg z-50 flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex-shrink-0 rounded-t-lg flex items-center justify-between">
            <span className="text-sm font-medium">定时任务</span>
            {activeTasks.length > 0 && (
              <span className="text-xs text-muted-foreground">{runningCount} 个活跃{activeTasks.length - runningCount > 0 ? ` · ${activeTasks.length - runningCount} 个暂停` : ''}</span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                暂无定时任务，在聊天输入栏点击时钟按钮创建
              </div>
            ) : (
              <>
                {/* 活跃任务 */}
                {activeTasks.map((task, index) => (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={() => handleDragStart(index)}
                    onDragOver={(e) => handleDragOver(e, index)}
                    onDrop={() => handleDrop(index)}
                    onDragEnd={handleDragEnd}
                    className={`group px-3 py-2 hover:bg-accent transition-colors border-b border-border/50 cursor-pointer ${
                      task.unread ? 'bg-brand/5' : ''
                    } ${dragIndex === index ? 'opacity-50' : ''} ${
                      dragOverIndex === index ? 'border-t-2 border-brand' : ''
                    }`}
                    onClick={() => {
                      onSwitchProject(task.cwd, task.sessionId);
                      if (task.unread) onMarkRead(task.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className="flex items-start gap-2">
                      {/* 状态点 */}
                      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground font-mono">{getProjectName(task.cwd)}</span>
                          <span className="text-xs text-muted-foreground">·</span>
                          <span className="text-xs text-muted-foreground">{getStatusText(task)}</span>
                        </div>
                        <div className="text-sm text-foreground truncate mt-0.5" title={task.message}>
                          {task.message}
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{formatType(task)}</span>
                          <span>·</span>
                          <span>{task.paused ? '已暂停' : formatNextFire(task.nextFireTime)}</span>
                          {task.lastFiredAt && (
                            <>
                              <span>·</span>
                              <span>上次: {task.lastResult === 'success' ? '✓' : '✗'}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {/* 操作按钮 */}
                      <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* 编辑 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setEditingTask(task); }}
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                          title="编辑"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        {/* 暂停/恢复 */}
                        {task.paused ? (
                          <button
                            onClick={(e) => { e.stopPropagation(); onResume(task.id); }}
                            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-green-500"
                            title="恢复"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                            </svg>
                          </button>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); onPause(task.id); }}
                            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-yellow-500"
                            title="暂停"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6" />
                            </svg>
                          </button>
                        )}
                        {/* 删除 */}
                        <button
                          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                          className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                          title="删除"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* 已完成任务 */}
                {completedTasks.length > 0 && (
                  <>
                    <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 border-b border-border/50">
                      已完成 ({completedTasks.length})
                    </div>
                    {completedTasks.map((task) => (
                      <div
                        key={task.id}
                        className="group px-3 py-2 hover:bg-accent transition-colors border-b border-border/50 opacity-60 cursor-pointer"
                        onClick={() => {
                          onSwitchProject(task.cwd, task.sessionId);
                          setIsOpen(false);
                        }}
                      >
                        <div className="flex items-start gap-2">
                          <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${getStatusColor(task)}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-foreground truncate">{task.message}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {formatType(task)} · {task.lastResult === 'success' ? '成功' : '失败'}
                            </div>
                          </div>
                          <div className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
                              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                              title="删除"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 编辑弹窗 */}
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
    </div>
  );
}
