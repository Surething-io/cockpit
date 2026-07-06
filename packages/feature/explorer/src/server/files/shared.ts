/**
 * Shared primitives for file-content endpoints.
 *
 * One source of truth for: path safety, MIME, category classification, ETag,
 * binary sniffing, and size limits. All file-content routes (`/api/files/read`,
 * `/api/files/stat`, `/api/files/text`) MUST use these helpers — do not
 * re-implement any of this logic in route handlers.
 */
import { stat, lstat, readlink } from 'fs/promises';
import path from 'path';

// -------- Size limits --------

/** Hard upper bound for text preview (bytes). */
export const MAX_TEXT_SIZE = 10 * 1024 * 1024; // 10 MB

/** Hard upper bound for image preview via /read (bytes). */
export const MAX_IMAGE_SIZE = 50 * 1024 * 1024; // 50 MB

/** Hard upper bound for PDF preview via /read (bytes). */
export const MAX_PDF_SIZE = 100 * 1024 * 1024; // 100 MB

// -------- Extension tables --------

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif',
]);

// PDFs get their own category so the browser's native viewer can render them
// via an <iframe> pointing at /api/files/read (streamed bytes, no JS heap).
const PDF_EXTENSIONS = new Set(['.pdf']);

const BINARY_EXTENSIONS = new Set([
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.avi', '.mov', '.mkv', '.wav', '.flac',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
  '.pyc', '.class', '.o', '.a',
]);

const MIME_TABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
};

export function getMimeType(ext: string): string {
  return MIME_TABLE[ext.toLowerCase()] || 'application/octet-stream';
}

// -------- Path safety --------

/**
 * Resolve a relative `userPath` against `cwd` and reject any path that escapes
 * the cwd (e.g. `../../etc/passwd`). Returns the absolute, resolved path on
 * success, or `null` if it would escape.
 *
 * Notes:
 * - `path.resolve` normalises `..` segments before comparison.
 * - The check uses `path.sep` so it works on both POSIX and Windows.
 */
export function resolveSafePath(cwd: string, userPath: string): string | null {
  if (typeof userPath !== 'string' || userPath.length === 0) return null;
  const root = path.resolve(cwd);
  const full = path.resolve(root, userPath);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * Lightweight guard for routes that take an arbitrary `cwd` query param.
 *
 * Cockpit's threat model trusts the local user, but the dev server
 * still listens on localhost — a malicious page in the user's browser
 * could issue cross-origin fetches with crafted `cwd` values. We
 * don't try to whitelist roots (cockpit users open arbitrary
 * projects), but we do reject obvious garbage:
 *
 *   - non-string / empty
 *   - relative paths (must be absolute, normalised)
 *   - non-existent paths
 *   - paths that aren't directories
 *
 * Returns `{ ok: true, abs }` on success (the resolved absolute path)
 * or `{ ok: false, reason }` with a short reason string the caller
 * surfaces in a 400 response.
 *
 * Cost: one fs.stat — typically <1 ms on warm cache. Routes do this
 * once per request; for buildCodeIndex requests the next step
 * (parsing the project) dominates by orders of magnitude.
 */
export async function validateCwd(
  cwd: string | null | undefined,
): Promise<{ ok: true; abs: string } | { ok: false; reason: string }> {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { ok: false, reason: 'Missing cwd parameter' };
  }
  if (!path.isAbsolute(cwd)) {
    return { ok: false, reason: 'cwd must be an absolute path' };
  }
  const abs = path.resolve(cwd);
  let s;
  try {
    s = await stat(abs);
  } catch {
    return { ok: false, reason: 'cwd does not exist' };
  }
  if (!s.isDirectory()) {
    return { ok: false, reason: 'cwd is not a directory' };
  }
  return { ok: true, abs };
}

// -------- ETag --------

/**
 * Compute an ETag from size + mtime. Stable for unchanged files, changes
 * whenever bytes or mtime change. Cheap (no hashing).
 */
export function computeETag(size: number, mtimeMs: number): string {
  // Round mtime to integer ms — fractional ns from some FS shouldn't break equality.
  return `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;
}

// -------- Category --------

export type FileCategory = 'image' | 'pdf' | 'text' | 'binary' | 'too-large';

/**
 * Classify a file by extension + size. Cheap: never reads bytes.
 *
 * - `image`     — extension matches IMAGE_EXTENSIONS
 * - `binary`    — extension matches BINARY_EXTENSIONS
 * - `too-large` — size exceeds the per-category limit
 * - `text`      — everything else (caller is expected to do a binary-content
 *                  sniff when actually reading the bytes)
 */
export function classify(filePathOrExt: string, size: number): FileCategory {
  const ext = filePathOrExt.startsWith('.')
    ? filePathOrExt.toLowerCase()
    : path.extname(filePathOrExt).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    return size > MAX_IMAGE_SIZE ? 'too-large' : 'image';
  }
  if (PDF_EXTENSIONS.has(ext)) {
    return size > MAX_PDF_SIZE ? 'too-large' : 'pdf';
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return 'binary';
  }
  return size > MAX_TEXT_SIZE ? 'too-large' : 'text';
}

// -------- Binary sniffing (for content already read as utf-8) --------

/**
 * Heuristic: a string contains a null byte → binary, OR more than 10% of the
 * sampled prefix is non-printable control characters → binary.
 *
 * Only meaningful for text routes; image/binary routes don't need this.
 */
export function isBinaryContent(content: string): boolean {
  let nonPrintable = 0;
  const sampleSize = Math.min(content.length, 1000);
  for (let i = 0; i < sampleSize; i++) {
    const code = content.charCodeAt(i);
    if (code === 0) return true;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
  }
  return sampleSize > 0 && nonPrintable / sampleSize > 0.1;
}

// -------- Stat helpers --------

export interface FileStatInfo {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isSymlink: boolean;
  symlinkTarget?: string;
}

/**
 * Stat a path with symlink awareness.
 * - `lstat` first to detect symlinks (and capture target).
 * - `stat` (follows links) to get the resolved size/mtime/kind.
 */
export async function statWithSymlink(fullPath: string): Promise<FileStatInfo> {
  let isSymlink = false;
  let symlinkTarget: string | undefined;
  try {
    const ls = await lstat(fullPath);
    if (ls.isSymbolicLink()) {
      isSymlink = true;
      symlinkTarget = await readlink(fullPath);
    }
  } catch {
    // fall through; stat below will surface the real error
  }
  const s = await stat(fullPath);
  return {
    size: s.size,
    mtimeMs: s.mtimeMs,
    isDirectory: s.isDirectory(),
    isSymlink,
    symlinkTarget,
  };
}

// -------- Standard headers --------

/**
 * Headers every file-serving response should set so that browsers always
 * revalidate via conditional GET (ETag) instead of serving stale bytes.
 */
export function buildCacheHeaders(etag: string, mtimeMs: number): Record<string, string> {
  return {
    ETag: etag,
    'Last-Modified': new Date(mtimeMs).toUTCString(),
    'Cache-Control': 'no-cache, must-revalidate',
  };
}

/** True if request's If-None-Match matches the current ETag (304 candidate). */
export function ifNoneMatch(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  // Allow comma-separated list and trim whitespace; weak/strong both accepted.
  return headerValue
    .split(',')
    .map(s => s.trim().replace(/^W\//, ''))
    .includes(etag);
}
