import type { ChatEngine } from './types';

/**
 * What the "copy resume command" button puts on the clipboard.
 *
 * Only the engines Cockpit drives through an external CLI can produce a runnable
 * command. The rest run in-process on Cockpit's own built-in agent loop (ollama,
 * kimi, glm, deepseek), so there is no command to paste; those copy
 * `<engine> <sessionId>`, the two identifiers needed to find the session again.
 *
 * Keep Codex's output in the interactive form humans paste into a terminal.
 */
export function buildResumeCommand(engine: ChatEngine | undefined, sessionId: string): string {
  switch (engine) {
    // A human pasting this wants to keep talking, which is the interactive form.
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'kimi':
    case 'glm':
    case 'deepseek':
    case 'ollama':
      return `${engine} ${sessionId}`;
    // `undefined` = a tab reopened from the session list, before Chat backfills the
    // engine from history. Every other consumer reads that as claude; so does this.
    case 'claude':
    default:
      return `claude -r ${sessionId}`;
  }
}
