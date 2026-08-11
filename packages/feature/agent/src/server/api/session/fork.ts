import { createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { Effect } from 'effect';
import { ensureParentDir } from '@cockpit/shared-utils';
import {
  dynamicHandler,
  ok,
  parseJsonRaw,
} from '@cockpit/effect-runtime/server';
import {
  FSError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import {
  resolveSessionPath,
  isForkableStore,
  newSessionPathInStore,
} from './sessionStore';
import { isHumanTurnStart } from '../../../shared/transcriptTurns';
import { copyReferencedArtifacts } from './sessionArtifacts';
import { buildCodexForkLines } from './codexFork';

export const runtime = 'nodejs';

/**
 * 'prefix' — keep everything from the start of the session up to and including the target
 *            turn (branch off a conversation, the original behaviour).
 * 'single' — keep ONLY the target turn, dropping all preceding context (lift one
 *            question-and-answer out into a session of its own).
 */
type ForkScope = 'prefix' | 'single';

interface ForkRequestBody {
  cwd: string;
  // Optional: the message uuid to start forking from; if omitted, copy everything
  fromMessageUuid?: string;
  // Defaults to 'prefix' so existing callers keep their behaviour
  scope?: ForkScope;
}

/**
 * Re-issue every uuid in an excerpted turn and re-link the parent chain.
 *
 * Required, not cosmetic: 'single' drops every preceding turn, so the first kept entry's
 * parentUuid points at a uuid that no longer exists in the new file. Fresh uuids also stop
 * two excerpts of the same turn from colliding inside one project directory. Parents that
 * survived the cut are remapped through `idMap`; the one that did not (the turn's opening
 * user message) falls back to the previous entry, which is null for the first line — making
 * the excerpt a well-formed transcript that starts at a root.
 */
function rechainEntries(
  entries: Record<string, unknown>[],
  newSessionId: string
): void {
  const idMap = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry.uuid === 'string') idMap.set(entry.uuid, randomUUID());
  }
  let prevUuid: string | null = null;
  for (const entry of entries) {
    entry.sessionId = newSessionId;
    const oldParent =
      typeof entry.parentUuid === 'string' ? entry.parentUuid : null;
    entry.parentUuid = (oldParent && idMap.get(oldParent)) ?? prevUuid;
    if (typeof entry.uuid === 'string') {
      const mapped = idMap.get(entry.uuid)!;
      entry.uuid = mapped;
      prevUuid = mapped;
    }
  }
}

/**
 * POST: Fork a session, creating a new branched session
 *
 * How it works:
 * 1. Read the JSONL file of the original session (from whichever engine store holds it)
 * 2. Generate a new sessionId
 * 3. Replace the sessionId in all records
 * 4. Write the new JSONL file back into the SAME store
 *
 * Fork logic (truncate by turn):
 * - Find the message with the specified uuid
 * - Continue copying all subsequent messages in that turn (assistant reply, tool_use,
 *   tool_result, etc.)
 * - Stop when the next "real user message" is encountered
 *
 * With scope='single' the same turn boundary applies, but everything before the turn is
 * dropped too. The target uuid may be an assistant message — the turn is then rewound to
 * the real user message that opened it, so excerpting works from either bubble.
 */
export const POST = dynamicHandler<
  { sessionId: string },
  FSError | NotFoundError | ValidationError
>((req, { sessionId: originalSessionId }) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ForkRequestBody;
    const { cwd, fromMessageUuid } = body;
    const scope: ForkScope = body.scope === 'single' ? 'single' : 'prefix';
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: 'cwd', reason: 'missing' })
      );
    }
    if (scope === 'single' && !fromMessageUuid) {
      return yield* Effect.fail(
        new ValidationError({ field: 'fromMessageUuid', reason: 'missing' })
      );
    }
    // Probe every engine store, not just Claude's: the button is offered on deepseek /
    // kimi / ollama chats too, whose transcripts live under different roots
    // entirely — and deepseek/kimi have two roots each (SDK vs Built-in Agent mode), so
    // resolveSessionPath is also what decides which of the two the fork gets written into.
    const store = resolveSessionPath(cwd, originalSessionId);
    if (!store) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: originalSessionId })
      );
    }
    if (!isForkableStore(store)) {
      return yield* Effect.fail(
        new ValidationError({
          field: 'engine',
          reason: `cannot create sessions in the ${store.engine} store`,
        })
      );
    }
    const originalPath = store.sessionPath;

    const result = yield* Effect.tryPromise({
      try: async () => {
        const newSessionId = randomUUID();
        let newLines: string[] = [];
        // scope='single' needs the whole turn as objects to re-chain, so it buffers the
        // current turn instead of emitting lines as it goes.
        let turn: Record<string, unknown>[] = [];
        const fileStream = createReadStream(originalPath);
        const rl = createInterface({
          input: fileStream,
          crlfDelay: Infinity,
        });

        const codexLines: string[] = [];
        let state: 'collecting' | 'found_target' | 'done' = 'collecting';
        for await (const line of rl) {
          if (state === 'done') break;
          if (!line.trim()) continue;
          if (store.engine === 'codex') {
            codexLines.push(line);
            continue;
          }
          try {
            const entry = JSON.parse(line);
            if (state === 'found_target') {
              if (isHumanTurnStart(entry)) {
                state = 'done';
                break;
              }
            } else if (scope === 'single' && isHumanTurnStart(entry)) {
              // A new turn starts here and we have not hit the target yet, so everything
              // buffered so far belongs to an earlier turn the excerpt does not want.
              // This is also what rewinds an assistant target back to its opening user
              // message: whichever turn is buffered when the uuid matches is the one kept.
              turn = [];
            }
            if (fromMessageUuid && entry.uuid === fromMessageUuid) {
              state = 'found_target';
            }
            if (scope === 'single') {
              turn.push(entry);
            } else {
              entry.sessionId = newSessionId;
              newLines.push(JSON.stringify(entry));
            }
          } catch {
            // Corrupt line. 'prefix' preserves it verbatim (minus the session id) to stay
            // byte-faithful to the original; 'single' drops it, since a line that cannot be
            // parsed cannot be re-chained and would break an otherwise clean excerpt.
            if (scope === 'prefix') {
              const modifiedLine = line.replace(
                new RegExp(originalSessionId, 'g'),
                newSessionId
              );
              newLines.push(modifiedLine);
            }
          }
        }

        if (store.engine === 'codex') {
          const built = buildCodexForkLines(
            codexLines,
            originalSessionId,
            newSessionId,
            fromMessageUuid,
            scope
          );
          newLines = built.newLines;
          state = built.targetMissed ? 'collecting' : 'found_target';
        } else if (scope === 'single') {
          rechainEntries(turn, newSessionId);
          for (const entry of turn) newLines.push(JSON.stringify(entry));
        }

        // Guard against silent full-file copy: if caller provided a target
        // uuid but we never matched it, the truncation logic effectively
        // degraded to "copy entire file" — surface that as a soft signal so
        // the handler can return an error instead of writing a misleading
        // forked session.
        return {
          newSessionId,
          newLines,
          targetMissed: !!fromMessageUuid && state === 'collecting',
        };
      },
      catch: (cause) =>
        new FSError({ path: originalPath, op: 'read', cause }),
    });

    if (result.targetMissed) {
      return yield* Effect.fail(
        new NotFoundError({
          resource: 'message',
          id: fromMessageUuid ?? '(unknown)',
        })
      );
    }

    // Write back into the store the original came from — a deepseek fork dropped into
    // ~/.claude/projects would be invisible to the engine that has to resume it.
    const newPath = newSessionPathInStore(store, cwd, result.newSessionId);
    if (!newPath) {
      return yield* Effect.fail(
        new ValidationError({
          field: 'engine',
          reason: `cannot create sessions in the ${store.engine} store`,
        })
      );
    }
    yield* Effect.tryPromise({
      try: async () => {
        await ensureParentDir(newPath);
        await writeFile(newPath, result.newLines.join('\n') + '\n', 'utf-8');
      },
      catch: (cause) => new FSError({ path: newPath, op: 'write', cause }),
    });

    // The transcript alone is not the session: Task and Workflow entries resolve their
    // drill-ins through a directory named after the session id, so without this every one
    // of them opens nothing in the fork. Runs after the write and never throws — a fork
    // missing some drill-ins is degraded but usable, and the new session already exists.
    const artifactCount = copyReferencedArtifacts(
      originalPath,
      newPath,
      result.newLines
    );

    return ok({
      success: true,
      originalSessionId,
      newSessionId: result.newSessionId,
      messageCount: result.newLines.length,
      artifactCount,
    });
  })
);
