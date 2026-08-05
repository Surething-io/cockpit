import { describe, it, expect } from 'vitest';
import { injectionKind, isHumanTurnStart } from './transcriptTurns';

const userText = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra,
});

describe('injectionKind', () => {
  it('returns null for a message a human typed', () => {
    expect(injectionKind(userText('hello'))).toBeNull();
  });

  it('classifies the harness injections', () => {
    expect(injectionKind(userText('x', { origin: { kind: 'task-notification' } }))).toBe('task-notification');
    expect(injectionKind(userText('x', { isMeta: true, sourceToolUseID: 'toolu_1' }))).toBe('skill');
    expect(injectionKind(userText('x', { isMeta: true }))).toBe('meta');
    expect(injectionKind(userText('x', { isCompactSummary: true }))).toBe('meta');
    expect(injectionKind(userText('x', { origin: { kind: 'something-new' } }))).toBe('meta');
  });

  it('treats an explicit human origin as human', () => {
    expect(injectionKind(userText('hi', { origin: { kind: 'human' } }))).toBeNull();
  });
});

describe('isHumanTurnStart', () => {
  it('accepts a typed message in either content form', () => {
    expect(isHumanTurnStart(userText('hello'))).toBe(true);
    expect(isHumanTurnStart({ type: 'user', message: { content: 'hello' } })).toBe(true);
  });

  it('rejects a background-task notification', () => {
    // The regression: these are type:'user' with ordinary text, and reading them as turns
    // cut a 700-line session into 58 "turns" instead of 21 — excerpting one produced a
    // system-event fragment, and forking truncated answers at the first notification.
    const notification = userText(
      '<task-notification>\n<task-id>a0db46bef87445ee4</task-id>\n</task-notification>',
      { origin: { kind: 'task-notification' } },
    );
    expect(isHumanTurnStart(notification)).toBe(false);
  });

  it('rejects skill bodies, meta rows and compaction notices', () => {
    expect(isHumanTurnStart(userText('x', { isMeta: true, sourceToolUseID: 't' }))).toBe(false);
    expect(isHumanTurnStart(userText('x', { isMeta: true }))).toBe(false);
    expect(isHumanTurnStart(userText('x', { isCompactSummary: true }))).toBe(false);
  });

  it('rejects a tool_result-only user entry', () => {
    // The engine reporting a tool's output — the tail of the previous turn, not a new one.
    expect(
      isHumanTurnStart({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] },
      }),
    ).toBe(false);
  });

  it('rejects non-user rows and empty content', () => {
    expect(isHumanTurnStart({ type: 'assistant', message: { content: [{ type: 'text' }] } })).toBe(false);
    expect(isHumanTurnStart({ type: 'queue-operation' })).toBe(false);
    expect(isHumanTurnStart({ type: 'user', message: { content: '' } })).toBe(false);
    expect(isHumanTurnStart({ type: 'user' })).toBe(false);
  });

  it('agrees with injectionKind on every user entry', () => {
    // The invariant the three former copies kept drifting from: anything the renderer
    // refuses to show as a user bubble must not open a turn either.
    const cases = [
      userText('typed'),
      userText('x', { origin: { kind: 'task-notification' } }),
      userText('x', { isMeta: true }),
      userText('x', { isCompactSummary: true }),
      userText('x', { isMeta: true, sourceToolUseID: 't' }),
    ];
    for (const c of cases) {
      expect(isHumanTurnStart(c)).toBe(injectionKind(c) === null);
    }
  });
});
