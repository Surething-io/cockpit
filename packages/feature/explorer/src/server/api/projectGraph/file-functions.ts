/**
 * File-mode endpoint — Code Map's default view for a selected file.
 *
 * GET /api/projectGraph/file-functions?cwd=<abs>&path=<rel>&refresh=0|1
 *
 * Returns every function-like symbol in the focal file (functions /
 * classes / methods) plus the intra-file call edges among them. Powers
 * the canvas when the user has a file selected but hasn't drilled into
 * a specific function yet.
 *
 * Backed by the project-wide code index, so the request is < 10 ms once
 * the index is warm. `?refresh=1` forces a full rebuild.
 *
 * Files outside the index (unsupported language: .json, .md, .css,
 * binary, beyond the file cap …) get a 200 with an empty
 * FileFunctionsResponse if they exist on disk — the client falls
 * through to its whole-file fallback and renders the file as a single
 * code block. Only "the file genuinely doesn't exist" returns 404.
 *
 * Status codes:
 *   200 — FileFunctionsResponse JSON (real or empty fallback)
 *   400 — missing cwd / path
 *   404 — file does not exist on disk
 *   500 — build failed
 */

import { readFile, stat } from 'node:fs/promises';
import {
  fileFunctionsFromIndex,
  getCodeIndex,
  invalidateIndex,
  refreshFocalFile,
} from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import type { FunctionNode } from '@cockpit/feature-explorer/server/codeMap/projectGraph/types';
import { resolveSafePath, validateCwd } from '@cockpit/feature-explorer/server/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cwdParam = new URL(request.url).searchParams.get('cwd');
  const filePath = new URL(request.url).searchParams.get('path');
  const cwdCheck = await validateCwd(cwdParam);
  if (!cwdCheck.ok) {
    return Response.json({ error: cwdCheck.reason }, { status: 400 });
  }
  const cwd = cwdCheck.abs;
  if (!filePath) {
    return Response.json({ error: 'Missing path parameter' }, { status: 400 });
  }
  const forceRefresh = new URL(request.url).searchParams.get('refresh') === '1';

  try {
    const index = await getCodeIndex(cwd, { forceRefresh });

    // Single-file mtime check before projecting. Cheap (~µs stat;
    // ~10-50 ms re-parse only when stale). Without this, the index
    // stays at whatever buildCodeIndex captured at process start
    // and chip ranges drift from on-disk content as the user (or
    // the agent) edits files. `refreshFocalFile` returns true when
    // it actually re-parsed; either way, the projection that
    // follows reads from the in-place-mutated `index.files` entry.
    await refreshFocalFile(cwd, filePath, index);
    const payload = fileFunctionsFromIndex(index, filePath);
    if (payload) {
      return Response.json(payload, {
        // Defensive: keep this endpoint out of any HTTP caches.
        // Server already gates freshness via mtime; an intermediary
        // (browser disk cache, dev server) holding a stale response
        // would defeat that.
        headers: { 'Cache-Control': 'no-cache' },
      });
    }

    // Not in the index — could be an unsupported language (e.g. .json,
    // .md, .css), a binary, or simply beyond the project's file cap.
    // If the file actually exists on disk we return a synthetic
    // projection so the client can still render its contents.
    const fullPath = resolveSafePath(cwd, filePath);
    if (fullPath) {
      const stats = await stat(fullPath).catch(() => null);
      if (stats?.isFile()) {
        // Markdown gets a richer treatment: chunked by headings, each
        // section becomes its own block named after the heading. This
        // makes long docs (READMEs / spec pages) navigable in the same
        // chip view as code files.
        if (/\.mdx?$/i.test(filePath)) {
          const text = await readFile(fullPath, 'utf-8').catch(() => null);
          if (text) {
            return Response.json(
              {
                filePath,
                language: 'markdown',
                fileCount: index.files.size,
                mtimeMs: stats.mtimeMs,
                functions: chunkMarkdown(filePath, text),
                intraCalls: [],
                externalCalls: [],
                methodCalls: [],
                upstreamCalls: [],
                downstreamCalls: [],
              },
              { headers: { 'Cache-Control': 'no-cache' } },
            );
          }
        }
        // Generic text fallback — single block; client renders the
        // whole file as one Shiki-highlighted code block.
        return Response.json(
          {
            filePath,
            language: 'text',
            fileCount: index.files.size,
            mtimeMs: stats.mtimeMs,
            functions: [],
            intraCalls: [],
            externalCalls: [],
            methodCalls: [],
            upstreamCalls: [],
            downstreamCalls: [],
          },
          { headers: { 'Cache-Control': 'no-cache' } },
        );
      }
    }
    return Response.json(
      {
        error: 'File not found',
        hint: 'The file does not exist at the requested path.',
      },
      { status: 404 },
    );
  } catch (err) {
    console.error('[projectGraph/file-functions] failed:', err);
    invalidateIndex(cwd);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to load file functions' },
      { status: 500 },
    );
  }
}

/**
 * Chunk a Markdown document into blocks, one per heading section.
 *
 * Each ATX heading line (`#`, `##`, …, up to `######`) starts a new
 * block; the block extends until the next heading at any level. Lines
 * before the first heading become a "preamble" block (front-matter,
 * intro paragraph, etc.). A document with no headings yields a single
 * whole-file block.
 *
 * Code-fence awareness: lines inside ```fenced``` blocks are NOT treated
 * as headings even if they look like one — `# this is a comment` inside
 * a Python snippet is a comment, not a heading.
 *
 * Returns synthetic FunctionNode entries with `kind: 'unknown'`. The
 * client renders them as ordinary blocks; the heading text becomes the
 * block name so the user sees a navigable outline.
 */
function chunkMarkdown(filePath: string, text: string): FunctionNode[] {
  const lines = text.split('\n');
  const headings: { line: number; name: string }[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // ATX heading: 1–6 `#`, optional whitespace, then heading text. The
    // CommonMark spec requires whitespace after the `#`s, but real-world
    // Chinese / CJK Markdown often omits it (`##标题`) because IMEs
    // don't auto-insert spaces. We accept both forms — `\s*` instead of
    // `\s+` — so those files chunk the same as English ones. Trailing
    // `#`s (the closing-style `## Heading ##`) are stripped as before.
    const m = /^(#{1,6})\s*(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      headings.push({ line: i + 1, name: m[2].trim() });
    }
  }

  // No headings → single whole-file block. Same shape as the generic
  // text fallback, just with markdown syntax highlighting.
  if (headings.length === 0) {
    return [
      {
        filePath,
        qualifiedName: '__file__',
        name: basename(filePath),
        kind: 'unknown',
        startLine: 1,
        endLine: Math.max(1, lines.length),
      },
    ];
  }

  const blocks: FunctionNode[] = [];
  // Preamble (everything before the first heading) — only if non-empty.
  if (headings[0].line > 1) {
    blocks.push({
      filePath,
      qualifiedName: '__preamble__',
      name: 'preamble',
      kind: 'unknown',
      startLine: 1,
      endLine: headings[0].line - 1,
    });
  }
  // Each heading section: from heading line to the line before the
  // next heading (or end-of-file for the last).
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const endLine = next ? next.line - 1 : lines.length;
    blocks.push({
      filePath,
      // Line-suffixed qname guarantees uniqueness even when two headings
      // share the same text (common in TOC-style docs).
      qualifiedName: `__heading_${h.line}__`,
      name: h.name,
      kind: 'unknown',
      startLine: h.line,
      endLine: Math.max(h.line, endLine),
    });
  }
  return blocks;
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
