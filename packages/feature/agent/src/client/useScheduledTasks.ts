import { useState, useCallback, useEffect } from 'react';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadScheduledTasks,
  createScheduledTask,
  patchScheduledTask,
  deleteScheduledTask,
} from './effect/scheduledTasksClient';

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
  sortIndex?: number;
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

const NOTIFY_TYPE = 'SCHEDULED_TASKS_CHANGED'; // v1 legacy listeners reference this string

/** Notify the parent window and all iframes (cross-component refresh) */
function notifyChanged() {
  // IframeBus publish (also broadcasts to legacy window postMessage listeners).
  publishTopic(Topics.ScheduledTasksChanged, {});
  // Also notify iframes within the current window
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
    BrowserRuntime.runPromise(
      loadScheduledTasks<ScheduledTask>().pipe(
        Effect.match({
          onSuccess: (data) => {
            setTasks((data.tasks ?? []) as ScheduledTask[]);
            setUnreadCount(data.unreadCount ?? 0);
          },
          onFailure: () => {
            // Silently swallow to match v1 `.catch(() => {})`
          },
        })
      )
    );
  }, []);

  // Initial load
  useEffect(() => { reload(); }, [reload]);

  // Listen for cross-iframe notifications
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data?.type === NOTIFY_TYPE) {
        reload();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [reload]);

  const createTask = useCallback(
    async (params: CreateTaskParams): Promise<ScheduledTask | null> => {
      const exit = await BrowserRuntime.runPromiseExit(
        createScheduledTask<ScheduledTask>(params)
      );
      if (exit._tag !== 'Success') return null;
      const data = exit.value;
      if (data.task) {
        reload();
        notifyChanged();
        return data.task;
      }
      return null;
    },
    [reload],
  );

  // All PATCH-style operations funnel through this helper: silent fallback + reload + notifyChanged
  const runPatch = useCallback(
    async (id: string, action: Parameters<typeof patchScheduledTask>[1], fields?: Record<string, unknown>) => {
      await BrowserRuntime.runPromise(
        patchScheduledTask(id, action, fields).pipe(
          Effect.orElse(() => Effect.void)
        )
      );
      reload();
      notifyChanged();
    },
    [reload],
  );

  const pauseTask = useCallback((id: string) => runPatch(id, 'pause'), [runPatch]);

  const resumeTask = useCallback((id: string) => runPatch(id, 'resume'), [runPatch]);

  const deleteTask = useCallback(async (id: string) => {
    await BrowserRuntime.runPromise(
      deleteScheduledTask(id).pipe(Effect.orElse(() => Effect.void))
    );
    reload();
    notifyChanged();
  }, [reload]);

  const updateTask = useCallback(
    (
      id: string,
      fields: Partial<
        Pick<
          ScheduledTask,
          'message' | 'type' | 'delayMinutes' | 'intervalMinutes' | 'activeFrom' | 'activeTo' | 'cron'
        >
      >,
    ) => runPatch(id, 'update', fields as Record<string, unknown>),
    [runPatch],
  );

  const triggerTask = useCallback((id: string) => runPatch(id, 'trigger'), [runPatch]);

  const markRead = useCallback((id: string) => runPatch(id, 'markRead'), [runPatch]);

  const markAllRead = useCallback(() => runPatch('_', 'markAllRead'), [runPatch]);

  const reorderTasks = useCallback(
    (orderedIds: string[]) => runPatch('_', 'reorder', { orderedIds }),
    [runPatch],
  );

  return {
    tasks,
    unreadCount,
    reload,
    createTask,
    pauseTask,
    resumeTask,
    triggerTask,
    deleteTask,
    updateTask,
    markRead,
    markAllRead,
    reorderTasks,
  };
}
