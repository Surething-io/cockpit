import { Effect, Duration } from 'effect';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { FSError } from '@cockpit/effect-core';
import { COCKPIT_PROJECTS_DIR, encodePath } from '@cockpit/shared-utils';

/**
 * Claude Code computes its context breakdown inside the CLI process and only
 * answers `get_context_usage` while that process is alive — which, for
 * Cockpit, is only during a run. So the breakdown is captured at the end of
 * every turn and kept here, beside the session titles, for the inspector to
 * read while the session is idle.
 */

export interface StoredClaudeContextUsage {
  version: 1;
  capturedAt: string;
  usage: SDKControlGetContextUsageResponse;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function claudeContextUsagePath(cwd: string, sessionId: string): string | null {
  if (!SAFE_ID.test(sessionId)) return null;
  return join(COCKPIT_PROJECTS_DIR, encodePath(cwd), 'context-usage', `${sessionId}.json`);
}

export const saveClaudeContextUsage = (cwd: string, sessionId: string, usage: SDKControlGetContextUsageResponse): Effect.Effect<void, FSError> => {
  const path = claudeContextUsagePath(cwd, sessionId);
  if (!path) return Effect.void;
  const record: StoredClaudeContextUsage = { version: 1, capturedAt: new Date().toISOString(), usage };
  return Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a reader never sees a half-written file.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await rename(tmp, path);
    },
    catch: (cause) => new FSError({ path, op: 'write', cause }),
  });
};

export const readClaudeContextUsage = (cwd: string, sessionId: string): Effect.Effect<StoredClaudeContextUsage | null, FSError> => {
  const path = claudeContextUsagePath(cwd, sessionId);
  if (!path) return Effect.succeed(null);
  return Effect.tryPromise({
    try: async () => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as StoredClaudeContextUsage;
        return parsed?.version === 1 && parsed.usage && Array.isArray(parsed.usage.categories) ? parsed : null;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT' || cause instanceof SyntaxError) return null;
        throw cause;
      }
    },
    catch: (cause) => new FSError({ path, op: 'read', cause }),
  });
};

interface ContextUsageSource {
  getContextUsage(opts?: { detail?: 'summary' | 'full' }): Promise<SDKControlGetContextUsageResponse>;
}

/**
 * Ask the live CLI for its breakdown and persist it. `summary` answers from the
 * last response's usage plus local estimates, so it costs no extra API calls; the
 * per-category split is therefore an estimate (see CLI_SPLIT_EXACT in claudeContext).
 * Never fails or stalls the run: bounded, and every failure is only logged.
 */
export function captureClaudeContextUsage(source: ContextUsageSource, cwd: string, sessionId: string): Promise<void> {
  if (!cwd || !sessionId) return Promise.resolve();
  return Effect.runPromise(Effect.tryPromise({
    try: () => source.getContextUsage({ detail: 'summary' }),
    catch: (cause) => new FSError({ path: sessionId, op: 'read', cause }),
  }).pipe(
    Effect.timeoutFail({ duration: Duration.seconds(5), onTimeout: () => new FSError({ path: sessionId, op: 'read', cause: new Error('get_context_usage timed out') }) }),
    Effect.flatMap((usage) => saveClaudeContextUsage(cwd, sessionId, usage)),
    Effect.catchAll((error) => Effect.logWarning('Cannot capture Claude context usage', error)),
    Effect.withSpan('agent.context.claude.capture'),
  ));
}
