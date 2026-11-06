import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { readProjectTitles, readSessionTitle, titleFromProject, titleStore, writeSessionTitle } from '../../effect/sessionTitles';
import { encodePath } from '@cockpit/shared-utils';
import { readLogicalTranscript } from '../../effect/logicalTranscript';
import { defaultSessionTitle } from '../transcriptViews';
import { resolveSessionPath } from './session/sessionStore';
import { getDefaultSessionTitle } from '../state/globalState';
import { broadcastSessionTitle } from '../sessionTitleBroadcast';
import type { SessionTitlesResponse } from '../../shared/sessionTitle';

export const POST = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown; sessionIds?: unknown; customTitle?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd) {
    return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'cwd is required' }));
  }
  if (Object.hasOwn(body, 'sessionIds')) {
    if (!Array.isArray(body.sessionIds) || body.sessionIds.some((id) => typeof id !== 'string' || !id)
      || Object.hasOwn(body, 'sessionId') || Object.hasOwn(body, 'customTitle')) {
      return yield* Effect.fail(new ValidationError({ field: 'sessionIds', reason: 'expected an array of session ids for a read-only batch' }));
    }
    const cwd = body.cwd;
    const metadata = yield* readProjectTitles(encodePath(cwd));
    const titles = yield* Effect.forEach([...new Set(body.sessionIds as string[])], (sessionId) => Effect.gen(function* () {
      const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
      if (!store) return null;
      const fallback = yield* readLogicalTranscript(store.sessionPath, store.engine, (view) => view.projection.pipe(Effect.map(defaultSessionTitle)), 'scan');
      return { cwd, sessionId, ...titleFromProject(metadata, sessionId, fallback, titleStore(store.engine), cwd) };
    }).pipe(Effect.catchAll((error) => Effect.logWarning('Cannot read session title in batch', { sessionId, error }).pipe(Effect.as(null)))), { concurrency: 4 });
    const response: SessionTitlesResponse = { titles: titles.filter((title) => title !== null) };
    return ok(response);
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'sessionId is required' }));
  }
  const { cwd, sessionId } = body;
  const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
  if (!store) return yield* Effect.fail(new NotFoundError({ resource: 'session', id: sessionId }));
  const fallback = yield* Effect.tryPromise({ try: () => getDefaultSessionTitle(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot read default title', cause }) });
  const kind = titleStore(store.engine);
  if (Object.hasOwn(body, 'customTitle')) {
    const record = yield* writeSessionTitle(cwd, sessionId, kind, body.customTitle);
    const change = { cwd, sessionId, title: record.customTitle ?? fallback, defaultTitle: fallback, customTitle: record.customTitle, titleRevision: record.revision };
    // Saving is authoritative even if a client disconnects before notification.
    yield* broadcastSessionTitle(change);
    return ok(change);
  }
  return ok({ cwd, sessionId, ...yield* readSessionTitle(cwd, sessionId, fallback, kind) });
}));
