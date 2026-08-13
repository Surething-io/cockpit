// Path -> directory-name encoding, kept in its own module (and its own package
// export subpath) because paths.ts imports node fs/os/path and so cannot be
// pulled into a browser bundle. Client code deep-imports
// '@cockpit/shared-utils/encodePath'; server code gets it re-exported from
// paths.ts. Keeping one implementation matters — the client used to carry its
// own copy of the rule and silently drifted from the server's.

/** Claude truncates the encoded name at this length before appending a hash. */
const CLAUDE_ENCODED_MAX_LEN = 200;

/**
 * Java's String.hashCode (h = h * 31 + c, wrapped to int32), base-36.
 * Only used for paths whose encoded form exceeds CLAUDE_ENCODED_MAX_LEN.
 */
function claudePathHash(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Encode a path to a safe directory name.
 *
 * This MUST match Claude CLI's encoding: getClaudeProjectDir() reads the
 * transcripts Claude itself wrote under ~/.claude/projects/<encoded-cwd>/.
 * A mismatch fails silently — we look in a directory that does not exist and
 * report an empty history rather than an error.
 *
 * Verified against claude 2.1.231 by decompiling its `Rv`/`zmo`/`Gey`:
 *
 *   zmo = (s) => s.replace(/[^a-zA-Z0-9]/g, '-')
 *   Rv  = (s) => { const t = zmo(s)
 *                  return t.length <= 200 ? t : `${t.slice(0, 200)}-${Gey(s)}` }
 *   Gey = (s) => Math.abs(hashCode(s)).toString(36)
 *
 * Note Gey hashes the ORIGINAL path, not the substituted one.
 *
 * The rule is platform-independent — `\` and `:` also fall into [^a-zA-Z0-9],
 * so a Windows cwd needs no special case (C:\Users\me -> C--Users-me).
 *
 * e.g. /Users/you/Work        -> -Users-you-Work
 * e.g. /foo/bar.worktrees/baz -> -foo-bar-worktrees-baz
 * e.g. /Users/me/my_project   -> -Users-me-my-project
 *
 * The previous implementation only substituted `/` and `.`, so any path
 * containing `_`, a space, or another non-alphanumeric character resolved to a
 * directory Claude never wrote.
 */
export function encodePath(path: string): string {
  const encoded = path.replace(/[^a-zA-Z0-9]/g, '-');
  return encoded.length <= CLAUDE_ENCODED_MAX_LEN
    ? encoded
    : `${encoded.slice(0, CLAUDE_ENCODED_MAX_LEN)}-${claudePathHash(path)}`;
}
