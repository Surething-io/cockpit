import type { ChatEngine } from './types';

/**
 * What the "copy resume command" button puts on the clipboard.
 *
 * Only the engines Cockpit drives through an external CLI can produce a runnable
 * command. The rest run in-process — the Agent SDK against an Anthropic-compatible
 * endpoint (kimi / glm / deepseek) or Cockpit's own builtin loop (ollama) — so there
 * is no command to paste; those copy `<engine> <sessionId>`, the two identifiers
 * needed to find the session again.
 *
 * Keep in sync with the spawn sites: `server/engines/claude.ts` (claude2's
 * CLAUDE_CONFIG_DIR) and `server/engines/codex.ts` (`resume <threadId>`).
 */
export function buildResumeCommand(engine: ChatEngine | undefined, sessionId: string): string {
  switch (engine) {
    // claude2 is not a second CLI — it is the same `claude` pointed at ~/.claude2
    // (CLAUDE2_DIR in shared-utils/paths). Its transcripts live in
    // ~/.claude2/projects, so a bare `claude -r` searches ~/.claude/projects and
    // reports the session as unknown. The env prefix is what makes it resumable.
    case 'claude2':
      return `CLAUDE_CONFIG_DIR=~/.claude2 claude -r ${sessionId}`;
    // Cockpit spawns `codex exec resume` because it needs one-shot JSON output.
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
