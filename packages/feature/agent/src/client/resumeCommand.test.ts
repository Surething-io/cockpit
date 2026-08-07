import { describe, it, expect } from 'vitest';
import { buildResumeCommand } from './resumeCommand';

const ID = '8f3a2b1c-0000-4000-8000-000000000000';

describe('buildResumeCommand', () => {
  it('resumes claude with the plain CLI flag', () => {
    expect(buildResumeCommand('claude', ID)).toBe(`claude -r ${ID}`);
  });

  // Interactive form for humans pasting it into a terminal.
  it('uses codex resume for codex', () => {
    expect(buildResumeCommand('codex', ID)).toBe(`codex resume ${ID}`);
  });

  it.each(['kimi', 'glm', 'deepseek', 'ollama'] as const)(
    'copies engine + session id for %s (no external CLI to resume)',
    (engine) => {
      expect(buildResumeCommand(engine, ID)).toBe(`${engine} ${ID}`);
    }
  );

  // A tab reopened from the session list before Chat backfills its engine.
  it('treats an unknown engine as claude', () => {
    expect(buildResumeCommand(undefined, ID)).toBe(`claude -r ${ID}`);
  });
});
