import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { readSessionTitle, titleStore, writeSessionTitle } from '../../effect/sessionTitles';
import { resolveSessionPath } from './session/sessionStore';
import { getDefaultSessionTitle } from '../state/globalState';
import { broadcastSessionTitle } from '../sessionTitleBroadcast';

export const POST = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown; customTitle?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd || typeof body.sessionId !== 'string' || !body.sessionId) {
    return yield* Effect.fail(new ValidationError({ field: 'session', reason: 'cwd and sessionId are required' }));
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
