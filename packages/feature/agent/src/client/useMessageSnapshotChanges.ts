import { useEffect, useState } from 'react';
import { Effect, Fiber, Schedule } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadSnapshotsByToolIds } from './effect/snapshotClient';
import { isMutatingToolName } from '../shared/toolMutation';
import type { ToolCallInfo } from './types';

/** Discover the FileDiff affordance only while its message's conversation is visible. */
export function useMessageSnapshotChanges(
  cwd: string | undefined, sessionId: string | null | undefined,
  toolCalls: ToolCallInfo[] | undefined, enabled: boolean,
): boolean {
  const [hasChanges, setHasChanges] = useState(false);
  useEffect(() => {
    if (!enabled || hasChanges || !cwd) return;
    const toolIds = (toolCalls ?? []).map((tool) => tool.id).filter(Boolean);
    if (!toolIds.length) return;
    const pendingWrites = toolCalls?.some((tool) => isMutatingToolName(tool.name)) ?? false;
    // Snapshot writes follow tool_result asynchronously. Bound retries to this
    // visible lifetime, and keep a confirmed result when the tab is revisited.
    const fiber = BrowserRuntime.runFork(loadSnapshotsByToolIds(cwd, toolIds, sessionId ?? undefined).pipe(
      Effect.catchAll((error) => Effect.logWarning('Cannot check message snapshots', error).pipe(Effect.as([]))),
      Effect.tap((commits) => Effect.sync(() => { if (commits.length > 0) setHasChanges(true); })),
      Effect.repeat({ while: (commits) => commits.length === 0 && pendingWrites, times: 2, schedule: Schedule.spaced('2 seconds') }),
    ));
    return () => { BrowserRuntime.runFork(Fiber.interrupt(fiber)); };
  }, [enabled, hasChanges, cwd, sessionId, toolCalls]);
  return hasChanges;
}
