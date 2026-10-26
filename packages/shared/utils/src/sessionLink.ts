/**
 * Cockpit session links — the one format every server reply and client link
 * handler agree on. Browser-safe (no node imports), exported via the
 * `@cockpit/shared-utils/sessionLink` subpath so client bundles never pull
 * in the node-only modules re-exported from the package index.
 *
 * The link is the real `/project` route (same shape as the workspace's
 * buildProjectUrl), relative on purpose: react-markdown's defaultUrlTransform
 * strips custom schemes, and a relative URL still works when opened directly.
 */

export interface SessionLinkTarget {
  cwd: string;
  sessionId: string;
}

export function buildSessionLink(cwd: string, sessionId: string): string {
  return `/project?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(sessionId)}&view=agent`;
}

const RELATIVE_BASE = 'http://cockpit.invalid';

/**
 * Parse a Cockpit session link. Accepts a root-relative `/project?cwd=…&sessionId=…`
 * (what the server emits), or an absolute URL only when its origin equals
 * `currentOrigin` — so an external site's look-alike link is never mistaken for a
 * local session. Protocol-relative (`//host/…`) and backslash (`/\\host/…`) forms are
 * rejected: they resolve to another host.
 */
export function parseSessionLink(
  href: string | undefined | null,
  currentOrigin?: string,
): SessionLinkTarget | null {
  if (!href) return null;
  const raw = href.trim();
  let url: URL;
  try {
    if (raw.startsWith('/')) {
      url = new URL(raw, RELATIVE_BASE);
      if (url.origin !== RELATIVE_BASE) return null;
    } else {
      if (!currentOrigin) return null;
      url = new URL(raw);
      if (url.origin !== currentOrigin) return null;
    }
  } catch {
    return null;
  }
  if (url.pathname !== '/project') return null;
  const cwd = url.searchParams.get('cwd');
  const sessionId = url.searchParams.get('sessionId');
  if (!cwd || !sessionId) return null;
  return { cwd, sessionId };
}

export type SessionLinkSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; target: SessionLinkTarget };

// A root-relative session link standing on its own: not glued to a URL-ish
// character, so `https://other.host/project?…` and `a/b/project?…` never match,
// while prose punctuation (CJK `链接：/project?…`, `(`, `[`) still may precede it.
// The body is ASCII URL characters only (buildSessionLink percent-encodes
// everything else), so a trailing `。` / `）` is not swallowed; trailing ASCII
// sentence punctuation is trimmed as GFM does for its autolinks.
const SESSION_LINK_IN_TEXT = /(?<![\w/.~%=&+@-])\/project\?[\w\-.~%!$&*+,;=:@/?#]+/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;

/**
 * Split plain text (user turns are not markdown-rendered) into text and
 * session-link segments — e.g. the `[Delegated from Cockpit session /project?…]`
 * line a delegated child session starts with. Only links parseSessionLink
 * accepts become `link` segments.
 */
export function splitSessionLinks(text: string): SessionLinkSegment[] {
  const segments: SessionLinkSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(SESSION_LINK_IN_TEXT)) {
    const href = m[0].replace(TRAILING_PUNCT, '');
    const target = parseSessionLink(href);
    if (!target) continue;
    const start = m.index!;
    if (start > last) segments.push({ kind: 'text', text: text.slice(last, start) });
    segments.push({ kind: 'link', text: href, target });
    last = start + href.length;
  }
  if (last < text.length) segments.push({ kind: 'text', text: text.slice(last) });
  return segments;
}
