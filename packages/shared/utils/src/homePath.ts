/**
 * Leading-`~` expansion, shared by every layer that turns user-typed text into
 * a filesystem path (console input, terminal `cd`, path autocomplete, the
 * /apps/local route, COCKPIT_HOME).
 *
 * Node-free on purpose. The browser has no home directory and no way to learn
 * one synchronously, so client code only ever *preserves* a leading `~` (it
 * must not be joined against a cwd) and the server does the actual expansion.
 * Keeping both halves of that contract in one file is what stops them drifting
 * — the previous state of the world had the "is it rooted?" test in
 * htmlBashSdk.ts and three private copies of the expansion elsewhere.
 */

/**
 * Home-relative path? `~`, `~/x`, `~\x`.
 *
 * `~user/...` is deliberately NOT matched: it is POSIX-only, meaningless on
 * Windows, and resolving it needs /etc/passwd. It stays a literal directory
 * name, exactly as it behaves today.
 */
export function isHomeRelativePath(p: string): boolean {
  return /^~(?=$|[/\\])/.test(p.trim())
}

/**
 * Expand a leading `~` against `home`; anything else is returned untouched.
 * A trailing separator is preserved (`~/` -> `<home>/`), which path autocomplete
 * depends on to tell "list this directory" from "complete this basename".
 * With an empty `home` the input is returned as-is — callers that cannot
 * tolerate an unexpanded `~` must check `isHomeRelativePath` first rather than
 * letting a literal `~` reach the filesystem.
 */
export function expandHomePath(p: string, home: string): string {
  if (!home || !isHomeRelativePath(p)) return p
  return home.replace(/[/\\]+$/, "") + p.trim().slice(1)
}
