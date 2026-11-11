import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { resolveSessionPath } from './session/sessionStore';
import { buildClaudeContext } from '../context/claudeContext';
import { buildCodexContext } from '../context/codexContext';
import { buildGrokContext } from '../context/grokContext';
import { buildPiContext } from '../context/piContext';
import type { ContextSnapshot, ContextSummary } from '../../shared/contextSnapshot';

/**
 * POST { cwd, sessionId } → what the session's next request would carry (see shared/contextSnapshot).
 * With `summary: true` only the figures (ContextSummary) come back — for the token bar,
 * which needs the window size, not the multi-megabyte item contents.
 */
export const POST = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown; summary?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd) {
    return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'cwd is required' }));
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'sessionId is required' }));
  }
  const { cwd, sessionId } = body;
  const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
  if (!store) return yield* Effect.fail(new NotFoundError({ resource: 'session', id: sessionId }));
  const snapshot: ContextSnapshot = yield* (
    store.engine === 'claude' ? buildClaudeContext(cwd, sessionId, store.sessionPath)
      : store.engine === 'codex' ? buildCodexContext(store.sessionPath)
        : store.engine === 'grok' ? buildGrokContext(cwd, sessionId)
          : buildPiContext(store.sessionPath)
  );
  if (body.summary === true) {
    const { engine, model, usedTokens, contextWindow, capturedAt } = snapshot;
    const summary: ContextSummary = { engine, model, usedTokens, contextWindow, capturedAt };
    return ok(summary);
  }
  return ok(snapshot);
}).pipe(Effect.withSpan('agent.context.read')));
