import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { refreshSessionTitle, titleStore, writeSessionTitle } from '../../effect/sessionTitles';
import { isSessionBot, setSessionBot } from '../lib/sessionBots';
import { readCachedSessionTitles } from '../sessionTitleCache';
import { readLogicalTranscript } from '../../effect/logicalTranscript';
import { defaultSessionTitle } from '../transcriptViews';
import { resolveSessionPath } from './session/sessionStore';
import { broadcastSessionTitle } from '../sessionTitleBroadcast';
import type { SessionTitlesResponse } from '../../shared/sessionTitle';

const refreshTitle = (cwd: string, sessionId: string, store: { sessionPath: string; engine: string }) => Effect.gen(function* () {
  const { info, changed } = yield* refreshSessionTitle(cwd, sessionId, titleStore(store.engine),
    readLogicalTranscript(store.sessionPath, store.engine, (view) => view.projection.pipe(Effect.map(defaultSessionTitle)), 'scan'));
  const change = { cwd, sessionId, ...info };
  if (changed) yield* broadcastSessionTitle(change);
  return change;
});

export const POST = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown; sessionIds?: unknown; customTitle?: unknown; mentionable?: unknown; cachedOnly?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd) {
    return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'cwd is required' }));
  }
  if (body.cachedOnly !== undefined && typeof body.cachedOnly !== 'boolean') {
    return yield* Effect.fail(new ValidationError({ field: 'cachedOnly', reason: 'must be a boolean' }));
  }
  if (Object.hasOwn(body, 'sessionIds')) {
    if (!Array.isArray(body.sessionIds) || body.sessionIds.some((id) => typeof id !== 'string' || !id)
      || Object.hasOwn(body, 'sessionId') || Object.hasOwn(body, 'customTitle') || Object.hasOwn(body, 'mentionable')) {
      return yield* Effect.fail(new ValidationError({ field: 'sessionIds', reason: 'expected an array of session ids for a title batch' }));
    }
    const cwd = body.cwd;
    const ids = [...new Set(body.sessionIds as string[])];
    if (body.cachedOnly) {
      const response: SessionTitlesResponse = { titles: yield* readCachedSessionTitles(cwd, ids) };
      return ok(response);
    }
    const titles = yield* Effect.forEach(ids, (sessionId) => Effect.gen(function* () {
      const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
      if (!store) return null;
      return yield* refreshTitle(cwd, sessionId, store);
    }).pipe(Effect.catchAll((error) => Effect.logWarning('Cannot read session title in batch', { sessionId, error }).pipe(Effect.as(null)))), { concurrency: 4 });
    const response: SessionTitlesResponse = { titles: titles.filter((title) => title !== null) };
    return ok(response);
  }
  if (typeof body.sessionId !== 'string' || !body.sessionId) {
    return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'sessionId is required' }));
  }
  if (body.cachedOnly) {
    return yield* Effect.fail(new ValidationError({ field: 'cachedOnly', reason: 'only supported for title batches' }));
  }
  const { cwd, sessionId } = body;
  const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
  if (!store) return yield* Effect.fail(new NotFoundError({ resource: 'session', id: sessionId }));
  const refreshed = yield* refreshTitle(cwd, sessionId, store);
  const fallback = refreshed.defaultTitle;
  const kind = titleStore(store.engine);
  // One save may rename and tick "can be @-mentioned" (a session Bot, server/lib/sessionBots)
  // together: the title first, so a rejected title (multi-line, contains @) changes neither.
  const hasTitle = Object.hasOwn(body, 'customTitle');
  const hasMentionable = Object.hasOwn(body, 'mentionable');
  if (hasMentionable && typeof body.mentionable !== 'boolean') {
    return yield* Effect.fail(new ValidationError({ field: 'mentionable', reason: 'must be a boolean' }));
  }
  const record = hasTitle ? yield* writeSessionTitle(cwd, sessionId, kind, body.customTitle) : null;
  const mentionable = hasMentionable
    ? yield* setSessionBot(cwd, sessionId, body.mentionable as boolean)
    : yield* isSessionBot(cwd, sessionId);
  if (record) {
    const defaultTitle = record.defaultTitle ?? fallback;
    const change = {
      cwd, sessionId, title: record.customTitle ?? defaultTitle, defaultTitle, customTitle: record.customTitle,
      titleRevision: record.revision, ...(mentionable && { mentionable: true }),
    };
    // Saving is authoritative even if a client disconnects before notification.
    yield* broadcastSessionTitle(change);
    return ok(change);
  }
  return ok({ ...refreshed, ...(mentionable && { mentionable: true }) });
}));
