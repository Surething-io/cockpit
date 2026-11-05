import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Effect } from 'effect';
import { FSError, NotFoundError, ValidationError } from '@cockpit/effect-core';
import { handler } from '@cockpit/effect-runtime/server';
import { MAX_IMAGE_SIZE } from '@cockpit/feature-explorer/server/files/shared';
import { readLogicalTranscript } from '../../../effect/logicalTranscript';
import { resolveSessionPath } from './sessionStore';
import { codexFilePath } from './codexTools';
import { findCodexUploadImage } from './codexUploadImage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Restore bytes from this session, never from the requested upload path on disk. */
export const GET = handler((req) => Effect.gen(function* () {
  const params = new URL(req.url).searchParams;
  const cwd = params.get('cwd');
  const sessionId = params.get('sessionId');
  const requestedPath = params.get('path');
  if (!cwd || !sessionId || !requestedPath) {
    return yield* Effect.fail(new ValidationError({ field: 'image', reason: 'cwd, sessionId and path are required' }));
  }
  const uploadPath = codexFilePath(requestedPath);
  if (uploadPath.includes('\0') || !path.isAbsolute(uploadPath)) {
    return yield* Effect.fail(new ValidationError({ field: 'path', reason: 'Expected an absolute upload path' }));
  }
  const store = yield* Effect.tryPromise({
    try: () => resolveSessionPath(cwd, sessionId),
    catch: (cause) => new FSError({ path: cwd, op: 'read', cause }),
  });
  if (!store || store.engine !== 'codex') {
    return yield* Effect.fail(new NotFoundError({ resource: 'session image', id: sessionId }));
  }
  const image = yield* readLogicalTranscript(store.sessionPath, store.engine, (view) => Effect.gen(function* () {
    const source = yield* view.source;
    const text = typeof source === 'string' ? yield* Effect.tryPromise({
      try: () => readFile(source, 'utf8'),
      catch: (cause) => new FSError({ path: source, op: 'read', cause }),
    }) : source.text;
    return findCodexUploadImage(text, uploadPath);
  }));
  if (!image) {
    return yield* Effect.fail(new NotFoundError({ resource: 'session image', id: uploadPath }));
  }
  // Apply the same decoded image limit as the normal file preview, before allocating bytes.
  if (image.data.length > Math.ceil(MAX_IMAGE_SIZE / 3) * 4) {
    return new Response(null, { status: 413 });
  }
  if (!image.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 === 1) {
    return yield* Effect.fail(new ValidationError({ field: 'image', reason: 'Invalid base64 image data' }));
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > MAX_IMAGE_SIZE) return new Response(null, { status: 413 });
  return new Response(bytes, { headers: {
    'Content-Type': image.media_type,
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  } });
}).pipe(Effect.withSpan('session.image')));
