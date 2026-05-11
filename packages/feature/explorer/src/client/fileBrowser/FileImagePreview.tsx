'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Preview an image file. Two addressing modes:
 *
 *   - **cwd-relative** (default file-browser case): pass `cwd` + `path`.
 *     Talks to `/api/files/stat` + `/api/files/read`. Stat is fetched first
 *     to obtain the ETag, which is then appended to the `<img>` URL as
 *     `v=<etag>` so the browser cache key changes whenever the file does.
 *
 *   - **absolute path** (chat tool-call previews): pass `absPath`. Talks
 *     to `/api/file?path=...&raw=true`. Skips the stat round-trip — the
 *     server's `Cache-Control: no-cache` + ETag combo is enough for
 *     correctness on this one-shot rendering surface.
 *
 * Together these two modes cover every image preview in the app, so we have
 * exactly one component (and one set of cache semantics) for "show me this
 * image file".
 *
 * Bump `refreshKey` to force a re-mount/re-stat (file-watcher integration).
 */
type Source =
  | { cwd: string; path: string; absPath?: never }
  | { cwd?: never; path?: never; absPath: string };

export type FileImagePreviewProps = Source & {
  /** Bump to force re-stat (file watcher integration). */
  refreshKey?: number;
  /** Container className. Defaults to a centred, contained image area. */
  className?: string;
  /** Image className. Defaults to fit the container. */
  imgClassName?: string;
  alt?: string;
};

type StatState =
  | { kind: 'loading' }
  | { kind: 'ready'; etag: string | null; size: number }
  | { kind: 'missing' }
  | { kind: 'too-large'; size: number }
  | { kind: 'error'; message: string };

export function FileImagePreview(props: FileImagePreviewProps) {
  const {
    refreshKey,
    className = 'h-full flex items-center justify-center p-4 bg-secondary',
    imgClassName = 'max-w-full max-h-full object-contain',
    alt,
  } = props;

  const isAbsolute = 'absPath' in props && typeof props.absPath === 'string';
  const cwd = !isAbsolute ? props.cwd! : undefined;
  const relPath = !isAbsolute ? props.path! : undefined;
  const absPath = isAbsolute ? props.absPath! : undefined;

  const [state, setState] = useState<StatState>({ kind: 'loading' });
  const reqIdRef = useRef(0);

  useEffect(() => {
    const id = ++reqIdRef.current;
    setState({ kind: 'loading' });

    const run = async () => {
      // Absolute mode: skip stat. /api/file responds with no-cache + ETag,
      // so the browser will revalidate every time. This avoids an extra
      // round-trip for one-shot chat-side previews.
      if (isAbsolute) {
        if (id !== reqIdRef.current) return;
        setState({ kind: 'ready', etag: null, size: 0 });
        return;
      }

      try {
        const url = `/api/files/stat?cwd=${encodeURIComponent(cwd!)}&path=${encodeURIComponent(relPath!)}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (id !== reqIdRef.current) return;
        if (!res.ok) {
          setState({ kind: 'error', message: `stat failed (${res.status})` });
          return;
        }
        const data = await res.json();
        if (id !== reqIdRef.current) return;
        if (!data.exists) {
          setState({ kind: 'missing' });
          return;
        }
        if (data.category === 'too-large') {
          setState({ kind: 'too-large', size: data.size ?? 0 });
          return;
        }
        if (data.category !== 'image') {
          setState({ kind: 'error', message: `Not an image (${data.category})` });
          return;
        }
        // Fall back to mtime-derived value if etag is somehow missing.
        const etag: string = data.etag || `t-${data.mtimeMs ?? Date.now()}`;
        setState({ kind: 'ready', etag, size: data.size ?? 0 });
      } catch (err) {
        if (id !== reqIdRef.current) return;
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    };
    run();

    return () => {
      // Bump id so any in-flight result is ignored
      reqIdRef.current++;
    };
  }, [isAbsolute, cwd, relPath, absPath, refreshKey]);

  if (state.kind === 'loading') {
    return (
      <div className={className}>
        <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (state.kind === 'missing') {
    return (
      <div className={className}>
        <div className="text-sm text-muted-foreground">File not found</div>
      </div>
    );
  }

  if (state.kind === 'too-large') {
    return (
      <div className={className}>
        <div className="text-sm text-muted-foreground">
          Image too large to preview ({Math.round(state.size / 1024 / 1024)} MB)
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className={className}>
        <div className="text-sm text-red-11">{state.message}</div>
      </div>
    );
  }

  // Build the right `<img src>` for the addressing mode in use.
  // The `v=<etag>` query (cwd-mode only) has no semantic meaning on the
  // server; it only forces a different browser cache key when the file
  // changes, on top of the server-side conditional GET.
  const src = isAbsolute
    ? `/api/file?path=${encodeURIComponent(absPath!)}&raw=true`
    : `/api/files/read?cwd=${encodeURIComponent(cwd!)}` +
      `&path=${encodeURIComponent(relPath!)}` +
      `&v=${encodeURIComponent(state.etag!)}`;

  return (
    <div className={className}>
      <img src={src} alt={alt ?? (relPath || absPath)} className={imgClassName} />
    </div>
  );
}
