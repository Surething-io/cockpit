import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Effect } from 'effect';
import { FSError } from '@cockpit/effect-core';
import { isBinaryContent, MAX_TEXT_SIZE } from './shared';

type TextPreviewRead =
  | { kind: 'text'; content: string; size: number; mtimeMs: number }
  | { kind: 'binary' | 'too-large' | 'not-file'; size: number; mtimeMs: number };

/** Check the opened object and bound the read, including growth after stat.
 * O_NONBLOCK prevents a swapped-in FIFO from blocking open on POSIX. */
export const readTextPreview = (filePath: string): Effect.Effect<TextPreviewRead, FSError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)),
      catch: (cause) => new FSError({ path: filePath, op: 'read', cause }),
    }),
    (file) => Effect.tryPromise({
      try: async (): Promise<TextPreviewRead> => {
        const stat = await file.stat();
        const metadata = { size: stat.size, mtimeMs: stat.mtimeMs };
        if (!stat.isFile()) return { kind: 'not-file', ...metadata };
        if (stat.size > MAX_TEXT_SIZE) return { kind: 'too-large', ...metadata };
        const chunks: Buffer[] = [];
        let size = 0;
        while (size <= MAX_TEXT_SIZE) {
          const bytes = Buffer.alloc(Math.min(64 * 1024, MAX_TEXT_SIZE + 1 - size));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
          if (!bytesRead) break;
          chunks.push(bytes.subarray(0, bytesRead));
          size += bytesRead;
        }
        if (size > MAX_TEXT_SIZE) return { kind: 'too-large', size, mtimeMs: stat.mtimeMs };
        const content = Buffer.concat(chunks, size).toString('utf8');
        if (isBinaryContent(content)) return { kind: 'binary', size, mtimeMs: stat.mtimeMs };
        return { kind: 'text', content, size, mtimeMs: stat.mtimeMs };
      },
      catch: (cause) => new FSError({ path: filePath, op: 'read', cause }),
    }),
    (file) => Effect.tryPromise({
      try: () => file.close(),
      catch: (cause) => new FSError({ path: filePath, op: 'read', cause }),
    }).pipe(Effect.orDie),
  );
