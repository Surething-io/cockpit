/**
 * POST /api/session-title/suggest   Body: { cwd, sessionId }  →  { title }
 *
 * The title dialog's "suggest" button. Asks the session's OWN engine, on the session's own
 * model, to name the conversation from a short excerpt (first questions + latest reply),
 * without creating or touching a session — see engines/shared/titleSuggestion.
 * Nothing is saved: the title only fills the dialog's input.
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { AgentError, AppError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { readLogicalTranscript } from '../../effect/logicalTranscript';
import { getEngineSpec } from '../engines/registry';
import {
  TITLE_SUGGESTION_TIMEOUT_MS, buildTitlePrompt, cleanSuggestedTitle, type TitleExcerpt,
} from '../engines/shared/titleSuggestion';
import { resolveSessionPath } from './session/sessionStore';
import { parseCodexTranscriptFile, parseTranscriptFile } from './session/transcriptParsers';

const USER_MESSAGES = 3;

export const excerptOf = (messages: ReadonlyArray<{ role: string; content: string }>): TitleExcerpt => ({
  userMessages: messages.filter((m) => m.role === 'user' && m.content.trim()).slice(0, USER_MESSAGES).map((m) => m.content),
  lastReply: [...messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? null,
});

export const POST = handler((req) => Effect.gen(function* () {
  const body = (yield* parseJsonRaw(req)) as { cwd?: unknown; sessionId?: unknown };
  if (typeof body.cwd !== 'string' || !body.cwd) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: 'cwd is required' }));
  if (typeof body.sessionId !== 'string' || !body.sessionId) return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'sessionId is required' }));
  const { cwd, sessionId } = body;
  const store = yield* Effect.tryPromise({ try: () => resolveSessionPath(cwd, sessionId), catch: (cause) => new AppError({ message: 'Cannot resolve session', cause }) });
  if (!store) return yield* Effect.fail(new NotFoundError({ resource: 'session', id: sessionId }));
  const spec = getEngineSpec(store.engine);
  if (!spec?.suggestTitle) return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: `${store.engine} cannot suggest titles` }));
  const suggest = spec.suggestTitle;

  const excerpt = yield* readLogicalTranscript(store.sessionPath, store.engine, (reader) => Effect.gen(function* () {
    const source = yield* reader.source;
    const parsed = yield* Effect.tryPromise({
      try: () => store.engine === 'codex' ? parseCodexTranscriptFile(source) : parseTranscriptFile(source),
      catch: (cause) => new AppError({ message: 'Cannot read the session transcript', cause }),
    });
    return excerptOf(parsed.messages);
  })).pipe(Effect.mapError((cause) => cause instanceof AppError ? cause : new AppError({ message: 'Cannot read the session transcript', cause })));
  if (excerpt.userMessages.length === 0) {
    return yield* Effect.fail(new ValidationError({ field: 'sessionId', reason: 'the session has no messages to name it by yet' }));
  }

  const raw = yield* Effect.tryPromise({
    // Either side ending the request cancels the engine call: the Effect's own interruption
    // (the timeout below) or the browser going away (dialog closed, page left) — which the
    // handler does not turn into an interruption, so it is wired in here.
    try: (signal) => suggest({ cwd, sessionId, prompt: buildTitlePrompt(excerpt), signal: AbortSignal.any([signal, req.signal]) }),
    catch: (cause) => new AgentError({ provider: store.engine, kind: 'unknown', cause }),
  }).pipe(
    Effect.timeoutFail({
      duration: TITLE_SUGGESTION_TIMEOUT_MS,
      onTimeout: () => new AgentError({ provider: store.engine, kind: 'timeout', cause: new Error('title suggestion timed out') }),
    }),
    Effect.withSpan('agent.sessionTitle.suggest', { attributes: { engine: store.engine } }),
  );
  const title = cleanSuggestedTitle(raw);
  if (!title) return yield* Effect.fail(new AgentError({ provider: store.engine, kind: 'protocol', cause: new Error('the model returned no usable title') }));
  return ok({ title });
}));
