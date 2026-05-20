import { createReadStream, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { Effect } from 'effect';
import { getClaudeSessionPath } from '@cockpit/shared-utils';
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

export const runtime = 'nodejs';

interface ForkRequestBody {
  cwd: string;
  // Optional: the message uuid to start forking from; if omitted, copy everything
  fromMessageUuid?: string;
}

/**
 * Determine whether a message is a "real user message" (not a tool_result)
 * A real user message: type=user and content contains a text block (not only tool_result)
 */
function isRealUserMessage(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user') return false;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return false;
  const content = message.content;
  if (!Array.isArray(content)) return typeof content === 'string';
  // Check whether there is a text-type content block (genuine user input)
  return content.some(
    (block: Record<string, unknown>) => block.type === 'text'
  );
}

/**
 * POST: Fork a session, creating a new branched session
 *
 * How it works:
 * 1. Read the JSONL file of the original session
 * 2. Generate a new sessionId
 * 3. Replace the sessionId in all records
 * 4. Write the new JSONL file
 *
 * Fork logic (truncate by turn):
 * - Find the message with the specified uuid
 * - Continue copying all subsequent messages in that turn (assistant reply, tool_use, tool_result, etc.)
 * - Stop when the next "real user message" is encountered
 */
export const POST = dynamicHandler<
  { sessionId: string },
  FSError | NotFoundError | ValidationError
>((req, { sessionId: originalSessionId }) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as ForkRequestBody;
    const { cwd, fromMessageUuid } = body;
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: 'cwd', reason: 'missing' })
      );
    }
    const originalPath = getClaudeSessionPath(cwd, originalSessionId);
    if (!existsSync(originalPath)) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: originalSessionId })
      );
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        const newSessionId = randomUUID();
        const newLines: string[] = [];
        const fileStream = createReadStream(originalPath);
        const rl = createInterface({
          input: fileStream,
          crlfDelay: Infinity,
        });

        let state: 'collecting' | 'found_target' | 'done' = 'collecting';
        for await (const line of rl) {
          if (state === 'done') break;
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (state === 'found_target') {
              if (isRealUserMessage(entry)) {
                state = 'done';
                break;
              }
            }
            if (fromMessageUuid && entry.uuid === fromMessageUuid) {
              state = 'found_target';
            }
            entry.sessionId = newSessionId;
            newLines.push(JSON.stringify(entry));
          } catch {
            const modifiedLine = line.replace(
              new RegExp(originalSessionId, 'g'),
              newSessionId
            );
            newLines.push(modifiedLine);
          }
        }

        const newPath = getClaudeSessionPath(cwd, newSessionId);
        await writeFile(newPath, newLines.join('\n') + '\n', 'utf-8');
        return { newSessionId, messageCount: newLines.length };
      },
      catch: (cause) =>
        new FSError({ path: originalPath, op: 'write', cause }),
    });

    return ok({
      success: true,
      originalSessionId,
      newSessionId: result.newSessionId,
      messageCount: result.messageCount,
    });
  })
);
