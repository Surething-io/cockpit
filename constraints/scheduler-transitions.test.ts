/**
 * Constraint: SchedulerTransitions (state machine, L4).
 *
 * A scheduled task's run lifecycle moves only along TRANSITIONS in
 * scheduledTasks.ts, and only TaskStore writes scheduled-tasks.json. The table
 * is checked here row by row; the "only TaskStore writes" half is checked on
 * the source, so a new code path cannot quietly write the file around it.
 *
 * Why: run state used to be scattered field writes on in-memory objects, saved
 * by overwriting the whole file — which is how a once task could be sent twice
 * and a run's result could be lost.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  TRANSITIONS,
  canTransition,
  taskState,
  type ScheduledTask,
} from '../packages/feature/agent/src/server/scheduledTasks';

const SOURCE = join(__dirname, '../packages/feature/agent/src/server/scheduledTasks.ts');

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't', cwd: '/p', tabId: 'tab', sessionId: 's', message: 'm',
  type: 'once', nextFireTime: 0, paused: false, createdAt: 0, ...over,
});

const pending = task();
const firing = task({ firingSince: 1 });
const done = task({ completed: true });
const paused = task({ paused: true });
const interrupted = task({ lastResult: 'interrupted' });

describe('SchedulerTransitions', () => {
  it('derives each state from stored fields', () => {
    expect(taskState(pending)).toBe('pending');
    expect(taskState(firing)).toBe('firing');
    expect(taskState(done)).toBe('done');
    expect(taskState(paused)).toBe('paused');
    expect(taskState(interrupted)).toBe('interrupted');
    // a run in flight stays in flight even if the task is paused meanwhile
    expect(taskState(task({ firingSince: 1, paused: true }))).toBe('firing');
  });

  it('never starts a second run while one is in flight', () => {
    expect(canTransition(firing, 'due')).toBe(false);
    expect(canTransition(firing, 'trigger')).toBe(false);
  });

  it('a finished or paused task is never fired by the schedule', () => {
    expect(canTransition(done, 'due')).toBe(false);
    expect(canTransition(paused, 'due')).toBe(false);
  });

  it('only an in-flight run settles, and only it is interrupted at boot', () => {
    for (const t of [pending, done, paused, interrupted]) {
      expect(canTransition(t, 'settle')).toBe(false);
      expect(canTransition(t, 'boot')).toBe(false);
    }
    expect(canTransition(firing, 'settle')).toBe(true);
    expect(canTransition(firing, 'boot')).toBe(true);
  });

  it('every table row is reachable through canTransition', () => {
    const byState = { pending, firing, done, paused, interrupted };
    for (const row of TRANSITIONS) {
      expect(canTransition(byState[row.from], row.event), `${row.from} --${row.event}-->`).toBe(true);
    }
  });

  it('only TaskStore writes scheduled-tasks.json', () => {
    const text = readFileSync(SOURCE, 'utf8');
    const sf = ts.createSourceFile(SOURCE, text, ts.ScriptTarget.Latest, true);
    const WRITES = new Set(['writeJsonFile', 'mutateJsonFile']);
    const outside: string[] = [];
    const visit = (node: ts.Node, inStore: boolean): void => {
      const here = inStore || (ts.isClassDeclaration(node) && node.name?.text === 'TaskStore');
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && WRITES.has(node.expression.text) && !here) {
        outside.push(`line ${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, (c) => visit(c, here));
    };
    visit(sf, false);
    expect(outside).toEqual([]);
  });
});
