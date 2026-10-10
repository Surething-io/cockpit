/**
 * Path containment on a segment boundary: `/a/foo/x` is inside `/a/foo`, `/a/foobar` is
 * not. A bare `p.startsWith(root)` gets the second one wrong, and `root + "/"` never
 * matches a Windows path — so every "is it under the project?" check goes through here.
 *
 * Node-free (client views use it too) and separator-agnostic: `/` and `\` both count.
 * Pure string logic — resolve `..` / `.` first (path.resolve on the server).
 */

const isSep = (c: string | undefined) => c === '/' || c === '\\'

/** `root` without trailing separators, except a bare filesystem root (`/`, `C:\`). */
function trimRoot(root: string): string {
  const t = root.replace(/[/\\]+$/, '')
  return t === '' || /^[A-Za-z]:$/.test(t) ? root : t
}

/**
 * `p` relative to `root` ('' for `root` itself), or null when `p` is not inside it.
 * The result keeps `p`'s own separators.
 */
export function relativeToRoot(root: string, p: string): string | null {
  if (!root) return null
  const r = trimRoot(root)
  if (p === r) return ''
  if (!p.startsWith(r)) return null
  if (isSep(r[r.length - 1])) return p.slice(r.length)
  return isSep(p[r.length]) ? p.slice(r.length + 1) : null
}

/** True when `p` is strictly inside `root` — or is `root` itself, with `allowRoot`. */
export function isPathWithin(root: string, p: string, allowRoot = false): boolean {
  const rel = relativeToRoot(root, p)
  return rel !== null && (allowRoot || rel !== '')
}
