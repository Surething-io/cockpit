// The contract the user-message modal jumps on: every row's `turnIndex` must be
// the exact cursor that brings that row's bubble into a paginated window.
//
// The two halves are tested together on purpose. They are only useful if they
// agree — an index that counts turns differently from the paginator hands the UI
// a cursor that lands next to the message instead of on it, and the jump quietly
// scrolls to the wrong place rather than failing.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { parseTranscriptFile, parseUserMessageIndex } from './transcriptParsers';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeTranscript(lines: unknown[]): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'user-messages-index-'));
  dirs.push(dir);
  const filePath = join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return filePath;
}

const user = (uuid: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  uuid,
  timestamp: `2026-01-0${(Number(uuid.replace(/\D/g, '')) % 9) + 1}T10:00:00.000Z`,
  message: { role: 'user', content: text },
  ...extra,
});

const assistant = (uuid: string, text: string) => ({
  type: 'assistant',
  uuid,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});

// A plain 3-turn conversation.
const conversation = () => [
  user('u1', 'first question'),
  assistant('a1', 'first answer'),
  user('u2', 'second question'),
  assistant('a2', 'second answer'),
  user('u3', 'third question'),
  assistant('a3', 'third answer'),
];

describe('parseUserMessageIndex', () => {
  it('lists every user message with the turn index that loads it', async () => {
    const file = writeTranscript(conversation());
    const index = await parseUserMessageIndex(file, 'claude');

    expect(index.totalTurns).toBe(3);
    expect(index.entries.map((e) => e.content)).toEqual([
      'first question',
      'second question',
      'third question',
    ]);
    expect(index.entries.map((e) => e.turnIndex)).toEqual([0, 1, 2]);
    expect(index.entries.map((e) => e.id)).toEqual(['u1', 'u2', 'u3']);
    expect(index.entries[0].timestamp).toBe('2026-01-02T10:00:00.000Z');
  });

  it('is not truncated by the window the chat happens to have paged in', async () => {
    const file = writeTranscript(conversation());
    // What the chat holds after an initial load of a single turn.
    const page = await parseTranscriptFile(file, { limit: 1 });
    expect(page.messages.filter((m) => m.role === 'user')).toHaveLength(1);

    const index = await parseUserMessageIndex(file, 'claude');
    expect(index.entries).toHaveLength(3);
  });

  it('excludes harness-injected user lines that render no bubble', async () => {
    const file = writeTranscript([
      user('u1', 'real question'),
      assistant('a1', 'answer'),
      // Skill body loaded by a tool call — folded into that call, never a bubble.
      user('inj1', 'SKILL BODY', { isMeta: true, sourceToolUseID: 'call-1' }),
      // Background-task notification — rendered as a muted system row.
      user('inj2', '<summary>done</summary>', { origin: { kind: 'task-notification' } }),
      user('u2', 'follow up'),
      assistant('a2', 'answer'),
    ]);
    const index = await parseUserMessageIndex(file, 'claude');
    expect(index.entries.map((e) => e.content)).toEqual(['real question', 'follow up']);
  });

  it('gives a turnIndex that fromTurnIndex resolves back to the same message', async () => {
    const file = writeTranscript(conversation());
    const index = await parseUserMessageIndex(file, 'claude');

    for (const entry of index.entries) {
      const page = await parseTranscriptFile(file, { fromTurnIndex: entry.turnIndex });
      expect(page.messages.some((m) => m.id === entry.id)).toBe(true);
      expect(page.startTurnIndex).toBe(entry.turnIndex);
      // The window runs to the tail, so it is contiguous with whatever was
      // already on screen and can replace it wholesale.
      expect(page.messages[page.messages.length - 1].id).toBe('a3');
      expect(page.hasMore).toBe(entry.turnIndex > 0);
    }
  });

  it('keeps the turn split aligned when the session opens mid-reply', async () => {
    // A resumed session whose first line is an assistant message: turn 0 is that
    // prefix, so the first USER message lives in turn 1. Counting user bubbles
    // instead of turns would place it at 0 and jump one turn too far back.
    const file = writeTranscript([
      assistant('a0', 'orphan reply'),
      user('u1', 'first question'),
      assistant('a1', 'answer'),
    ]);
    const index = await parseUserMessageIndex(file, 'claude');
    expect(index.totalTurns).toBe(2);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].turnIndex).toBe(1);

    const page = await parseTranscriptFile(file, { fromTurnIndex: 1 });
    expect(page.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('stays exact when the session grew after the index was read', async () => {
    // The staleness `fromTurnIndex` exists to kill: a client that turned its
    // turnIndex into `limit = totalTurns - turnIndex` would slide the window
    // forward by however many turns landed in between and lose the target.
    const file = writeTranscript(conversation());
    const index = await parseUserMessageIndex(file, 'claude');
    const target = index.entries[0];
    const staleLimit = index.totalTurns - target.turnIndex;

    fs.appendFileSync(
      file,
      [user('u4', 'fourth question'), assistant('a4', 'fourth answer')]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n'
    );

    const byLimit = await parseTranscriptFile(file, { limit: staleLimit });
    expect(byLimit.messages.some((m) => m.id === target.id)).toBe(false);

    const byCursor = await parseTranscriptFile(file, { fromTurnIndex: target.turnIndex });
    expect(byCursor.messages.some((m) => m.id === target.id)).toBe(true);
  });
});
