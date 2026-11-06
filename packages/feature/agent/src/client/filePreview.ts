import { isMarkdownFile, isHtmlFile, isImageFile, isCsvFile, resolveRelativePath } from '@cockpit/feature-explorer';
import { relativeToRoot } from '@cockpit/shared-utils/pathWithin';

export interface FilePreviewRequest {
  path: string;
  source: 'link' | 'tool';
}

/** Only an explicit tool-file gesture may launch executable HTML. */
export function getFilePreviewKind({ path, source }: FilePreviewRequest): 'image' | 'html' | 'csv' | 'markdown' | 'text' {
  if (isImageFile(path)) return 'image';
  if (isHtmlFile(path) && source === 'tool') return 'html';
  if (isCsvFile(path)) return 'csv';
  if (isMarkdownFile(path)) return 'markdown';
  return 'text';
}

/**
 * Canonical spelling of an absolute path, for prefix-comparing it against cwd.
 * Drops a trailing slash and macOS's `/private` prefix — `/tmp/x` and
 * `/private/tmp/x` are the same file, and a bare string compare would call one
 * of them "outside the project".
 */
function normalizeAbsPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  return trimmed.startsWith('/private/') ? trimmed.slice('/private'.length) : trimmed;
}

/**
 * A local file link parsed out of an AI reply.
 *
 * `rel` is always the cwd-relative candidate (the Explorer tree's contract).
 * `abs` is non-null only when the href was absolute *and* not under cwd — the
 * one case the string alone can't settle, because `/docs/x.md` is equally
 * plausible as a repo-root-relative link or as another project's real path.
 * The click handler resolves that with a single stat rather than guessing.
 */
interface LocalFileLink {
  rel: string;
  abs: string | null;
  lineNumber?: number;
}

export function parseLocalFileLink(href: string, cwd?: string): LocalFileLink | null {
  if (!href || href.startsWith('#') || href.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:')) return null;

  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* keep raw */ }
  if (decoded.startsWith('file://')) decoded = decoded.slice('file://'.length);

  const hashIdx = decoded.indexOf('#');
  const hash = hashIdx >= 0 ? decoded.slice(hashIdx + 1) : '';
  let pathPart = hashIdx >= 0 ? decoded.slice(0, hashIdx) : decoded;

  const queryIdx = pathPart.indexOf('?');
  const query = queryIdx >= 0 ? pathPart.slice(queryIdx + 1) : '';
  pathPart = queryIdx >= 0 ? pathPart.slice(0, queryIdx) : pathPart;

  let lineNumber: number | undefined;
  const hashLine = hash.match(/^L?(\d+)(?:-L?\d+)?$/i)?.[1];
  const queryLine = query.match(/(?:^|[&;])(?:line|L)=(\d+)(?:$|[&;])/i)?.[1];
  const suffixLineMatch = pathPart.match(/:(\d+)(?::\d+)?$/);
  const lineText = hashLine || queryLine || suffixLineMatch?.[1];
  if (lineText) {
    lineNumber = Number(lineText);
    if (suffixLineMatch) pathPart = pathPart.slice(0, -suffixLineMatch[0].length);
  }

  pathPart = pathPart.trim();
  if (!pathPart) return null;

  const line = lineNumber && lineNumber > 0 ? { lineNumber } : {};
  const root = cwd ? normalizeAbsPath(cwd) : '';

  if (pathPart.startsWith('/')) {
    const abs = normalizeAbsPath(pathPart);
    const inside = root ? relativeToRoot(root, abs) : null;
    if (inside === '') return null; // the project dir itself, not a file
    if (inside) {
      // Plainly inside the project — the Explorer tree can show it.
      return { rel: resolveRelativePath('', inside), abs: null, ...line };
    }
    // Outside cwd (or no cwd at all): ambiguous, keep BOTH readings.
    return { rel: resolveRelativePath('', abs), abs, ...line };
  }

  return { rel: resolveRelativePath('', pathPart), abs: null, ...line };
}
