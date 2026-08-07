/**
 * Shared session-title derivation.
 *
 * Previously this logic was copy-pasted into 4 server modules (session-by-path,
 * sessions, sessions/project-encoded, state/globalState). It is pure string
 * logic (no IO), so it lives here as plain functions rather than an Effect.
 *
 * Title priority (highest first):
 *   1. aiTitle  — the `{"type":"ai-title","aiTitle":...}` line written by the
 *                 cockpit/SDK runtime. Stable, single value per session, and
 *                 higher quality than `summary` (which accumulates many stale
 *                 compaction entries).
 *   2. summary  — the `{"type":"summary","summary":...}` line written by the
 *                 standard Claude transcript.
 *   3. first meaningful user message (bare `/command` gets its follow-up
 *                 content appended).
 *   4. 'Untitled Session'.
 *
 * The manual pinned-session rename is handled client-side and overrides this
 * derived title, so it stays above aiTitle without any logic here.
 */

/** Filter command/system tags and extract the meaningful user text. */
export function filterCommandTags(text: string): string {
  // First try to extract command-args (the user's actual input).
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim()) {
    return argsMatch[1].trim();
  }
  // If no args, try to extract the command-name (e.g. /qa).
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch && nameMatch[1].trim()) {
    return nameMatch[1].trim();
  }
  // Otherwise strip all command/system tags and their content.
  let filtered = text.replace(/<command-message>[^<]*<\/command-message>/g, '');
  filtered = filtered.replace(/<command-name>[^<]*<\/command-name>/g, '');
  filtered = filtered.replace(/<command-args>[^<]*<\/command-args>/g, '');
  filtered = filtered.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  filtered = filtered.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  return filtered.trim();
}

/**
 * Generate a session title. Prefers aiTitle, then summary, then the first
 * meaningful user message; no truncation (callers truncate for display).
 */
export function generateTitle(aiTitle: string, summary: string, userMessages: string[]): string {
  if (aiTitle) return aiTitle;
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // Bare command (starts with /): record it and keep looking for follow-up content.
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // Combine a previously-seen command with the first real content.
    if (commandName) {
      return `${commandName} ${filtered}`;
    }

    // Plain message used directly as the title.
    return filtered;
  }

  // Only a command with no follow-up content.
  if (commandName) return commandName;

  return 'Untitled Session';
}
