'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, Image as ImageIcon } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { CodeViewer } from '../CodeViewer';
import { fetchFileText, fetchFileStat } from '../effect/filesClient';

/**
 * Source view for an HTML small-app: a sidebar listing the entry `.html` plus the
 * sibling files it depends on (discovered by scanning from the HTML outward —
 * `./app.jsx`, and transitively `./api.mjs` referenced inside it, etc.), and a
 * right pane that renders the selected file (text → CodeViewer, image → <img>).
 *
 * Discovery is a bounded BFS constrained to the app's own directory: text files
 * are read (via /api/files/text) and re-scanned; images are listed (existence via
 * /api/files/stat) but rendered as raw bytes. All reads reuse the explorer's
 * filesClient — no new backend route.
 */

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const TXT_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'json', 'html', 'htm',
  'md', 'markdown', 'txt', 'yml', 'yaml', 'sh', 'bash', 'xml', 'csv',
]);
const MAX_FILES = 40;

type FileKind = 'text' | 'image';
interface AppFile { abs: string; rel: string; kind: FileKind }

const normSlash = (p: string) => p.replace(/\\/g, '/');
const baseOf = (p: string) => { const s = normSlash(p); return s.slice(s.lastIndexOf('/') + 1); };
const dirOf = (p: string) => { const s = normSlash(p); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const extOf = (p: string) => { const b = baseOf(p).toLowerCase(); const i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1); };
const classify = (p: string): FileKind | null => {
  const e = extOf(p);
  if (IMG_EXT.has(e)) return 'image';
  if (TXT_EXT.has(e)) return 'text';
  return null;
};

/** Same-directory relative refs like `./app.jsx`, `./sub/x.js`, `"node ./api.mjs"`. */
function extractRefs(text: string): string[] {
  const re = /(?<![.\w])\.\/([\w./-]+\.\w+)/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

/** Resolve `ref` against `dir`; return the abs path only if it stays inside `dir`. */
function resolveWithin(dir: string, ref: string): string | null {
  const d = normSlash(dir).replace(/\/+$/, '');
  const parts: string[] = [];
  for (const seg of (d + '/' + ref).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); continue; }
    parts.push(seg);
  }
  const abs = '/' + parts.join('/');
  return abs === d || abs.startsWith(d + '/') ? abs : null;
}

export function HtmlAppSource({ entryPath, entryContent }: {
  entryPath: string;
  entryContent: string;
  cwd?: string;
}) {
  // Read deps with the app's OWN directory as cwd — every dep lives inside it, so
  // permission always passes. The chat/session cwd may be a different project
  // (e.g. app files under llm-eval while the session runs in cockpit) → denied.
  const appDir = useMemo(() => dirOf(entryPath), [entryPath]);
  const relOf = (abs: string) => (abs.startsWith(appDir + '/') ? abs.slice(appDir.length + 1) : baseOf(abs));

  // Content cache for text files (entry seeded synchronously).
  const contentRef = useRef<Map<string, string>>(new Map());
  const [files, setFiles] = useState<AppFile[]>([]);
  const [sel, setSel] = useState(entryPath);
  const [scanning, setScanning] = useState(true);

  useEffect(() => {
    contentRef.current = new Map([[entryPath, entryContent]]);
    const seed: AppFile = { abs: entryPath, rel: baseOf(entryPath), kind: 'text' };
    setFiles([seed]);
    setSel(entryPath);
    setScanning(true);

    let cancelled = false;
    (async () => {
      const seen = new Set([entryPath]);
      const acc: AppFile[] = [seed];
      const queue: string[] = [entryContent];
      while (queue.length && acc.length < MAX_FILES && !cancelled) {
        const text = queue.shift() as string;
        for (const ref of extractRefs(text)) {
          if (acc.length >= MAX_FILES) break;
          const abs = resolveWithin(appDir, ref);
          if (!abs || seen.has(abs)) continue;
          seen.add(abs);
          const kind = classify(abs);
          if (!kind) continue;
          if (kind === 'image') {
            const st = await BrowserRuntime.runPromise(fetchFileStat(appDir, abs)).catch(() => null);
            if (st?.ok && st.data && !cancelled) { acc.push({ abs, rel: relOf(abs), kind }); setFiles([...acc]); }
          } else {
            const res = await BrowserRuntime.runPromise(fetchFileText(appDir, abs)).catch(() => null);
            if (res?.ok && res.data?.content != null) {
              contentRef.current.set(abs, res.data.content);
              queue.push(res.data.content);
              if (!cancelled) { acc.push({ abs, rel: relOf(abs), kind }); setFiles([...acc]); }
            }
          }
        }
      }
      if (!cancelled) setScanning(false);
    })();
    return () => { cancelled = true; };
  }, [entryPath, entryContent, appDir]);

  const selFile = files.find((f) => f.abs === sel);
  // Single-file app (no deps found): skip the sidebar, show the file full-width.
  const showSidebar = files.length > 1 || scanning;

  return (
    <div className="flex h-full">
      {showSidebar && (
        <div className="w-56 flex-shrink-0 border-r border-border overflow-y-auto">
          {files.map((f) => (
            <button
              key={f.abs}
              onClick={() => setSel(f.abs)}
              data-tooltip={f.rel}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 min-w-0 transition-colors ${
                sel === f.abs ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              {f.kind === 'image'
                ? <ImageIcon className="w-3.5 h-3.5 flex-shrink-0" />
                : <FileCode2 className="w-3.5 h-3.5 flex-shrink-0" />}
              <span className="truncate">{f.rel}</span>
            </button>
          ))}
          {scanning && <div className="px-3 py-1.5 text-xs text-muted-foreground">…</div>}
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-hidden">
        {selFile?.kind === 'image' ? (
          <div className="h-full flex items-center justify-center p-4 overflow-auto bg-background">
            <img
              src={`/api/file?path=${encodeURIComponent(sel)}&raw=true`}
              alt={baseOf(sel)}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : (
          <CodeViewer key={sel} content={contentRef.current.get(sel) ?? ''} filePath={sel} cwd={appDir} />
        )}
      </div>
    </div>
  );
}

export default HtmlAppSource;
