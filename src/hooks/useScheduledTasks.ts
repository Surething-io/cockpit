import { useState, useCallback, useEffect } from 'react';

export interface ScheduledTask {
  id: string;
  port: number;
  cwd: string;
  tabId: string;
  sessionId: string;
  message: string;
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;
  intervalMinutes?: number;
  activeFrom?: string;
  activeTo?: string;
  cron?: string;
  nextFireTime: number;
  paused: boolean;
  completed?: boolean;
  unread?: boolean;
  lastFiredAt?: number;
  lastResult?: 'success' | 'error';
  createdAt: number;
}

interface CreateTaskParams {
  cwd: string;
  tabId: string;
  sessionId: string;
  message: string;
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;
  intervalMinutes?: number;
  activeFrom?: string;
  activeTo?: string;
  cron?: string;
}

const NOTIFY_TYPE = 'SCHEDULED_TASKS_CHANGED';

/** 通知父窗口和所有 iframe（跨组件刷新） */
function notifyChanged() {
  try {
    window.parent.postMessage({ type: NOTIFY_TYPE }, '*');
  } catch { /* ignore */ }
  // 也通知自身窗口内的 iframe
  const iframes = document.querySelectorAll('iframe');
  iframes.forEach(iframe => {
    try {
      iframe.contentWindow?.postMessage({ type: NOTIFY_TYPE }, '*');
    } catch { /* ignore */ }
  });
}

export function useScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const reload = useCallback(() => {
    fetch('/api/scheduled-tasks')
      .then(res => res.json())
      .then(data => {
        setTasks(data.tasks || []);
        setUnreadCount(data.unreadCount || 0);
      })
      .catch(() => {});
  }, []);

  // 初始加载
  useEffect(() => { reload(); }, [reload]);

  // 监听跨 iframe 通知
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === NOTIFY_TYPE) {
        reload();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [reload]);

  const createTask = useCallback(async (params: CreateTaskParams): Promise<ScheduledTask | null> => {
    try {
      const res = await fetch('/api/scheduled-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.task) {
        reload();
        notifyChanged();
        return data.task;
      }
      return null;
    } catch {
      return null;
    }
  }, [reload]);

  const pauseTask = useCallback(async (id: string) => {
    await fetch('/api/scheduled-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'pause' }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  const resumeTask = useCallback(async (id: string) => {
    await fetch('/api/scheduled-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'resume' }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  const deleteTask = useCallback(async (id: string) => {
    await fetch('/api/scheduled-tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  const updateTask = useCallback(async (id: string, fields: Partial<Pick<ScheduledTask, 'message' | 'type' | 'delayMinutes' | 'intervalMinutes' | 'activeFrom' | 'activeTo' | 'cron'>>) => {
    await fetch('/api/scheduled-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'update', fields }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  const markRead = useCallback(async (id: string) => {
    await fetch('/api/scheduled-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'markRead' }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  const markAllRead = useCallback(async () => {
    await fetch('/api/scheduled-tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: '_', action: 'markAllRead' }),
    }).catch(() => {});
    reload();
    notifyChanged();
  }, [reload]);

  return {
    tasks,
    unreadCount,
    reload,
    createTask,
    pauseTask,
    resumeTask,
    deleteTask,
    updateTask,
    markRead,
    markAllRead,
  };
}
