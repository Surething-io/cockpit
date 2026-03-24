import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';
import { getClaudeSessionPath } from '@/lib/paths';

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
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId: originalSessionId } = await params;
    const body: ForkRequestBody = await request.json();
    const { cwd, fromMessageUuid } = body;

    if (!cwd) {
      return NextResponse.json(
        { error: 'Missing cwd parameter' },
        { status: 400 }
      );
    }

    // Get the original session file path
    const originalPath = getClaudeSessionPath(cwd, originalSessionId);

    if (!existsSync(originalPath)) {
      return NextResponse.json(
        { error: 'Original session not found' },
        { status: 404 }
      );
    }

    // Generate a new sessionId
    const newSessionId = randomUUID();

    // Read and process the JSONL file
    const newLines: string[] = [];
    const fileStream = createReadStream(originalPath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    // State machine:
    // - 'collecting': normally collecting messages
    // - 'found_target': target message found, continue collecting until the next real user message
    // - 'done': finished
    let state: 'collecting' | 'found_target' | 'done' = 'collecting';

    for await (const line of rl) {
      if (state === 'done') break;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // State handling
        if (state === 'found_target') {
          // Stop when the next real user message is encountered
          if (isRealUserMessage(entry)) {
            state = 'done';
            break;
          }
        }

        // Check whether the target message has been reached
        if (fromMessageUuid && entry.uuid === fromMessageUuid) {
          state = 'found_target';
        }

        // Replace the sessionId
        entry.sessionId = newSessionId;

        // Append the modified record to the new file content
        newLines.push(JSON.stringify(entry));
      } catch {
        // If parsing fails, keep the original line (but replace the sessionId string)
        const modifiedLine = line.replace(
          new RegExp(originalSessionId, 'g'),
          newSessionId
        );
        newLines.push(modifiedLine);
      }
    }

    // Write the new JSONL file
    const newPath = getClaudeSessionPath(cwd, newSessionId);
    await writeFile(newPath, newLines.join('\n') + '\n', 'utf-8');

    return NextResponse.json({
      success: true,
      originalSessionId,
      newSessionId,
      messageCount: newLines.length,
    });
  } catch (error) {
    console.error('Fork session error:', error);
    return NextResponse.json(
      { error: 'Failed to fork session' },
      { status: 500 }
    );
  }
}
