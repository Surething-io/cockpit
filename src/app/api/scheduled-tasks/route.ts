import { NextRequest, NextResponse } from 'next/server';
import { scheduledTaskManager, getNextCronTime, type ScheduledTask } from '@/lib/scheduledTasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/scheduled-tasks
 * 获取当前实例的所有定时任务
 */
export async function GET() {
  try {
    const tasks = await scheduledTaskManager.getTasks();
    const unreadCount = await scheduledTaskManager.getUnreadCount();
    return NextResponse.json({ tasks, unreadCount });
  } catch (error) {
    console.error('Failed to get scheduled tasks:', error);
    return NextResponse.json({ tasks: [], unreadCount: 0 });
  }
}

/**
 * POST /api/scheduled-tasks
 * 创建新定时任务
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cwd, tabId, sessionId, message, type, delayMinutes, intervalMinutes, activeFrom, activeTo, cron } = body;

    if (!cwd || !tabId || !sessionId || !message || !type) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const now = Date.now();
    let nextFireTime: number;

    if (type === 'once' && delayMinutes) {
      nextFireTime = now + delayMinutes * 60000;
    } else if (type === 'interval' && intervalMinutes) {
      nextFireTime = now + intervalMinutes * 60000;
    } else if (type === 'cron' && cron) {
      nextFireTime = getNextCronTime(cron);
    } else {
      return NextResponse.json({ error: 'Invalid type or missing time config' }, { status: 400 });
    }

    const task: Omit<ScheduledTask, 'port'> = {
      id: `task-${now}-${Math.random().toString(36).slice(2, 8)}`,
      cwd,
      tabId,
      sessionId,
      message,
      type,
      delayMinutes: type === 'once' ? delayMinutes : undefined,
      intervalMinutes: type === 'interval' ? intervalMinutes : undefined,
      activeFrom: type === 'interval' ? activeFrom : undefined,
      activeTo: type === 'interval' ? activeTo : undefined,
      cron: type === 'cron' ? cron : undefined,
      nextFireTime,
      paused: false,
      createdAt: now,
    };

    const created = await scheduledTaskManager.addTask(task);
    return NextResponse.json({ task: created });
  } catch (error) {
    console.error('Failed to create scheduled task:', error);
    return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
  }
}

/**
 * PATCH /api/scheduled-tasks
 * 更新任务（暂停/恢复/标记已读/修改）
 */
export async function PATCH(request: NextRequest) {
  try {
    const { id, action, fields } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Missing task id' }, { status: 400 });
    }

    let task: ScheduledTask | null = null;

    if (action === 'pause') {
      task = await scheduledTaskManager.pauseTask(id);
    } else if (action === 'resume') {
      task = await scheduledTaskManager.resumeTask(id);
    } else if (action === 'trigger') {
      await scheduledTaskManager.triggerTask(id);
      return NextResponse.json({ success: true });
    } else if (action === 'markRead') {
      await scheduledTaskManager.markRead(id);
      return NextResponse.json({ success: true });
    } else if (action === 'markAllRead') {
      await scheduledTaskManager.markAllRead();
      return NextResponse.json({ success: true });
    } else if (action === 'reorder' && fields?.orderedIds) {
      await scheduledTaskManager.reorderTasks(fields.orderedIds);
      return NextResponse.json({ success: true });
    } else if (action === 'update' && fields) {
      // 编辑任务：重新计算 nextFireTime
      const now = Date.now();
      const updatedFields = { ...fields };
      if (fields.type === 'once' && fields.delayMinutes) {
        updatedFields.nextFireTime = now + fields.delayMinutes * 60000;
        updatedFields.completed = false;
      } else if (fields.type === 'interval' && fields.intervalMinutes) {
        updatedFields.nextFireTime = now + fields.intervalMinutes * 60000;
      } else if (fields.type === 'cron' && fields.cron) {
        updatedFields.nextFireTime = getNextCronTime(fields.cron);
      }
      updatedFields.paused = false; // 编辑后自动恢复
      task = await scheduledTaskManager.updateTask(id, updatedFields);
    } else if (fields) {
      task = await scheduledTaskManager.updateTask(id, fields);
    }

    if (!task && action !== 'markRead' && action !== 'markAllRead') {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ task });
  } catch (error) {
    console.error('Failed to update scheduled task:', error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

/**
 * DELETE /api/scheduled-tasks
 * 删除任务
 */
export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) {
      return NextResponse.json({ error: 'Missing task id' }, { status: 400 });
    }

    const success = await scheduledTaskManager.deleteTask(id);
    if (!success) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete scheduled task:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
