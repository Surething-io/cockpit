import { useState, useCallback, useEffect } from 'react';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { Effect } from 'effect';
import i18n from '@cockpit/shared-i18n';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadScheduledTasks,
  createScheduledTask,
  patchScheduledTask,
  deleteScheduledTask,
} from './effect/scheduledTasksClient';
import type { ScheduledTaskPatchRequest } from '../contract/scheduledTasks';

export interface ScheduledTask {
  id: string;
  cwd: string;
  tabId: string;
  sessionId: string;
  engine?: string;
  model?: string;
  language?: string;
  /** Mutually exclusive with taskFile — exactly one carries the instruction. */
  message: string;
  /** Absolute path to a file describing the task; read by the agent at fire time. */
  taskFile?: string;
  /**
   * Server-computed: the exact prompt the dispatcher will send. For a plain task
   * this equals `message`; for a taskFile task it is the "read this file first"
   * instruction. Read-only — never send it back.
   */
  resolvedPrompt?: string;
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
  engine?: string;
  model?: string;
  language?: string;
  message: string;
  taskFile?: string;
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
      // Language is stamped here, not at the call sites: it decides the wording of
      // a taskFile task's dispatched prompt, and a caller that forgot it would
      // silently fall back to English with nothing to notice. One funnel, one place.
      const exit = await BrowserRuntime.runPromiseExit(
        createScheduledTask<ScheduledTask>({ language: i18n.language, ...params })
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
    async (body: ScheduledTaskPatchRequest) => {
      await BrowserRuntime.runPromise(
        patchScheduledTask(body).pipe(Effect.orElse(() => Effect.void))
      );
      reload();
      notifyChanged();
    },
    [reload],
  );

  const pauseTask = useCallback((id: string) => runPatch({ id, action: 'pause' }), [runPatch]);

  const resumeTask = useCallback((id: string) => runPatch({ id, action: 'resume' }), [runPatch]);

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
          'message' | 'taskFile' | 'type' | 'delayMinutes' | 'intervalMinutes' | 'activeFrom' | 'activeTo' | 'cron'
        >
      >,
      // Editing re-stamps the language, so a task written before the user switched
      // locales follows them over on the next edit instead of being frozen forever.
    ) => runPatch({
      id,
      action: 'update',
      fields: { ...fields, language: i18n.language } as Record<string, unknown>,
    }),
    [runPatch],
  );

  const triggerTask = useCallback((id: string) => runPatch({ id, action: 'trigger' }), [runPatch]);

  const markRead = useCallback((id: string) => runPatch({ id, action: 'markRead' }), [runPatch]);

  const markAllRead = useCallback(() => runPatch({ action: 'markAllRead' }), [runPatch]);

  const reorderTasks = useCallback(
    (orderedIds: string[]) => runPatch({ action: 'reorder', fields: { orderedIds } }),
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
