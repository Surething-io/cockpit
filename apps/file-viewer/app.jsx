/**
 * file-viewer — preview a local file (markdown / json / image / pdf).
 *
 * Built-in, but written against the PUBLIC contract only, so it doubles as the
 * reference app (see ~/.cockpit/skills/html/SKILL.md):
 *   - all data goes through cockpit.bash — no privileged endpoints
 *   - libs come from /html-lib (same-origin, offline)
 *   - theming is the `cockpit-theme` meta, handled by the SDK
 * Opened as /apps/builtin/file-viewer/index.html?file=<absolute path>.
 */
// React/ReactDOM come from the /html-lib script tags in index.html; `cockpit`
// is the SDK injected by the server.
/* global React, ReactDOM, cockpit */
const { useState, useEffect, useRef, useCallback } = React;

/** Inline an image up to this size as a data URL; refuse beyond it. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------- bash layer

/**
 * Single-quote a value for safe interpolation into a bash command string.
 * Everything is literal inside '...', so only the quote itself needs escaping:
 * close, insert an escaped quote, reopen.
 */
const sh = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

/**
 * Run one foreground command and return stdout, collapsing BOTH failure classes
 * into a thrown Error:
 *   - cockpit.bash() throws        -> spawn / infrastructure failure
 *   - resolves with exitCode !== 0 -> the command ran and failed; surface its
 *                                     stderr rather than a generic message
 */
async function bash(command) {
  let res;
  try {
    res = await cockpit.bash(command);
  } catch (e) {
    throw new Error('cannot run command: ' + ((e && e.message) || e));
  }
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout || '').trim();
    throw new Error(detail || ('command exited with ' + res.exitCode));
  }
  return res.stdout;
}

const readText = (absPath) => bash('cat -- ' + sh(absPath));

const fileSize = async (absPath) => {
  const n = parseInt((await bash('wc -c < ' + sh(absPath))).trim(), 10);
  return Number.isFinite(n) ? n : 0;
};

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};

/** Read a binary file as a data URL, guarding against oversized payloads. */
async function toDataUrl(absPath) {
  const size = await fileSize(absPath);
  if (size > MAX_INLINE_BYTES) {
    throw new Error(
      'file is ' + (size / 1048576).toFixed(1) + ' MB, over the ' +
      (MAX_INLINE_BYTES / 1048576) + ' MB inline limit'
    );
  }
  const mime = IMAGE_MIME[extOf(absPath)] || 'application/octet-stream';
  // base64 reads stdin on both macOS and GNU coreutils; the output is wrapped,
  // so strip whitespace before building the URL.
  const b64 = (await bash('base64 < ' + sh(absPath))).replace(/\s+/g, '');
  return 'data:' + mime + ';base64,' + b64;
}

// ------------------------------------------------------------------- helpers

const extOf = (p) => {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
};
const dirOf = (p) => p.replace(/\\/g, '/').replace(/\/[^/]*$/, '') || '/';
const baseOf = (p) => p.split(/[/\\]/).pop();

/**
 * Lazily load a script (+ optional css) once; resolves when ready.
 * A rejected promise is evicted from the cache so a later attempt can retry —
 * caching the rejection would make one transient failure permanent for the page.
 */
const loadedLibs = {};
function loadLib(src, cssHref) {
  if (loadedLibs[src]) return loadedLibs[src];
  loadedLibs[src] = new Promise((resolve, reject) => {
    if (cssHref) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = cssHref;
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  }).catch((err) => {
    delete loadedLibs[src];
    throw err;
  });
  return loadedLibs[src];
}

/** Run an async task on mount; expose {data, error, loading}. */
function useAsync(task, deps) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: null });
    task()
      .then((data) => { if (alive) setState({ loading: false, data, error: null }); })
      .catch((err) => { if (alive) setState({ loading: false, data: null, error: err.message }); });
    return () => { alive = false; };
  }, deps);
  return state;
}

// ------------------------------------------------------------------- widgets

/**
 * Mount one of the /html-lib widgets into a plain DOM node. They ship their own
 * React copy, so they must own the node outright — hence the ref + imperative
 * render/unmount instead of rendering them as children.
 *
 * mount() is guarded symmetrically with unmount(): a throw from inside a passive
 * effect has no error boundary above it, so it would tear down the whole React
 * root and blank the page. On mount failure no cleanup is registered — there is
 * nothing mounted to tear down.
 */
function useWidget(ref, ready, mount, unmount, deps, onError) {
  useEffect(() => {
    if (!ready || !ref.current) return;
    const el = ref.current;
    try {
      mount(el);
    } catch (e) {
      if (onError) onError(e.message || String(e));
      return;
    }
    return () => { try { unmount(el); } catch { /* already gone */ } };
  }, deps);
}

// --------------------------------------------------------------------- views

function Status({ kind, children }) {
  return <div className={'viewer-status ' + kind}>{children}</div>;
}

/**
 * Markdown. Relative image references are rewritten to their /apps/local/ URL
 * BEFORE render: rewriting the source (rather than patching <img> afterwards)
 * survives the widget's re-render on theme flips.
 *
 * URLs, not data: URLs. The markdown renderer runs every src through
 * react-markdown's defaultUrlTransform, which drops any protocol outside
 * http/https/mailto/xmpp — a `data:` image is silently stripped to no src at
 * all, in BOTH the `![](…)` and raw-HTML `<img>` forms. Referencing the file's
 * own address in the local namespace also avoids base64-ing every image through
 * the WS bridge, so there is no size cap and no per-image shell spawn.
 */
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;

/** Absolute local path → its /apps/local URL (per-segment encoded). */
const toLocalUrl = (absPath) =>
  '/apps/local/' +
  absPath
    .replace(/\\/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^\//, '');

function resolveRelativeImages(text, dir) {
  const isRemote = (s) => /^(https?:|data:|\/)/i.test(s);
  const found = [];
  const collect = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const src = m[1];
      if (src && !isRemote(src) && found.indexOf(src) < 0) found.push(src);
    }
  };
  collect(MD_IMAGE_RE);
  collect(HTML_IMAGE_RE);
  if (!found.length) return text;

  const urls = new Map(found.map((src) => {
    let rel = src;
    try { rel = decodeURIComponent(src); } catch { /* keep as written */ }
    return [src, toLocalUrl(dir + '/' + rel.replace(/^\.\//, ''))];
  }));

  // Substitute INSIDE each image match only. A document-wide substring replace
  // would corrupt any path that contains another as a substring (`img.png` is
  // inside `sub/img.png`) and would also rewrite prose or code blocks that
  // merely mention the filename.
  const substitute = (match, src) =>
    urls.has(src) ? match.replace(src, urls.get(src)) : match;
  return text
    .replace(MD_IMAGE_RE, substitute)
    .replace(HTML_IMAGE_RE, substitute);
}

function MarkdownView({ file }) {
  const ref = useRef(null);
  const [mountError, setMountError] = useState(null);
  const { loading, data, error } = useAsync(async () => {
    await loadLib('/html-lib/markdown.js', '/html-lib/markdown.css');
    return resolveRelativeImages(await readText(file), dirOf(file));
  }, [file]);

  useWidget(
    ref, !loading && data != null,
    (el) => window.CockpitMarkdown.render(el, data),
    (el) => window.CockpitMarkdown.unmount(el),
    [loading, data],
    setMountError
  );

  if (loading) return <Status kind="loading">loading…</Status>;
  const failure = error || mountError;
  if (failure) return <Status kind="error">{'file-viewer: ' + file + '\n\n' + failure}</Status>;
  return <div className="md-view" ref={ref} />;
}

/**
 * JSON. Default is the readable widget; the top-right button swaps to the raw
 * pretty-printed source rendered as a markdown fence. The two widgets are
 * separate React copies, so the inactive one is unmounted before the other
 * takes the node.
 */
function JsonView({ file }) {
  const ref = useRef(null);
  const t = useLang();
  const [mode, setMode] = useState('readable');
  // WHICH mode's lib is loaded — deliberately not a bare `libReady` boolean.
  // `setLibReady(false)` would only be *scheduled* by this effect, so the
  // useWidget effect running later in the SAME commit would still observe the
  // previous mode's `true` and mount a widget whose bundle is not loaded yet.
  // Comparing `loadedMode === mode` cannot go stale that way: on a mode switch
  // the two differ until the new bundle actually resolves.
  const [loadedMode, setLoadedMode] = useState(null);
  const [libError, setLibError] = useState(null);
  const { loading, data, error } = useAsync(() => readText(file), [file]);

  useEffect(() => {
    const lib = mode === 'readable'
      ? loadLib('/html-lib/json-viewer.js')
      : loadLib('/html-lib/markdown.js', '/html-lib/markdown.css');
    let alive = true;
    setLibError(null);
    lib
      .then(() => { if (alive) setLoadedMode(mode); })
      .catch((e) => { if (alive) setLibError(e.message); });
    return () => { alive = false; };
  }, [mode]);

  useWidget(
    ref, loadedMode === mode && !loading && data != null,
    (el) => {
      if (mode === 'readable') window.CockpitJson.render(el, data);
      else window.CockpitMarkdown.render(el, jsonToMarkdown(data), { toc: false });
    },
    (el) => {
      if (mode === 'readable') window.CockpitJson.unmount(el);
      else window.CockpitMarkdown.unmount(el);
    },
    [loadedMode, mode, loading, data],
    setLibError
  );

  const toggle = useCallback(
    () => setMode((m) => (m === 'readable' ? 'raw' : 'readable')),
    []
  );

  if (loading) return <Status kind="loading">loading…</Status>;
  if (error) return <Status kind="error">{'file-viewer: ' + file + '\n\n' + error}</Status>;
  if (libError) return <Status kind="error">{'file-viewer: ' + libError}</Status>;
  return (
    <>
      <button type="button" className="json-toggle" onClick={toggle}>
        {mode === 'readable' ? t('raw') : t('readable')}
      </button>
      <div className={mode === 'readable' ? 'json-view' : 'md-view'} ref={ref} />
    </>
  );
}

function jsonToMarkdown(text) {
  let body = text;
  try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show raw */ }
  // The fence must be longer than any backtick run inside the content.
  let fence = '```';
  const runs = body.match(/`+/g);
  if (runs) {
    const longest = Math.max.apply(null, runs.map((s) => s.length));
    while (fence.length <= longest) fence += '`';
  }
  return fence + 'json\n' + body + '\n' + fence;
}

function ImageView({ file }) {
  const [natural, setNatural] = useState(false);
  const { loading, data, error } = useAsync(() => toDataUrl(file), [file]);

  if (loading) return <Status kind="loading">loading…</Status>;
  if (error) return <Status kind="error">{'file-viewer: ' + file + '\n\n' + error}</Status>;
  return (
    <div
      className={'img-view' + (natural ? ' natural' : '')}
      onClick={() => setNatural((n) => !n)}
    >
      <img src={data} alt={baseOf(file)} />
    </div>
  );
}

function PdfView({ file }) {
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    loadLib('/html-lib/pdf-viewer.js', '/html-lib/pdf-viewer.css')
      .then(() => { if (alive) setReady(true); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);

  useWidget(
    ref, ready,
    (el) => window.CockpitPdf.render(el, { cwd: dirOf(file), path: baseOf(file) }),
    (el) => window.CockpitPdf.unmount(el),
    [ready, file],
    setError
  );

  if (error) return <Status kind="error">{'file-viewer: ' + error}</Status>;
  return <div className="pdf-view" ref={ref} />;
}

// ------------------------------------------------------------------ language

// App-local dictionary. The app only PERCEIVES the language, it does not import
// the host's i18n — same as any user app would.
const DICT = {
  zh: { readable: '可读', raw: '原文' },
  en: { readable: 'Readable', raw: 'Raw' },
};

/**
 * `cockpit.lang` is the host's language, recorded on <html lang> by the SDK.
 * Reading it (rather than listening for the one-shot broadcast) is what makes
 * this correct regardless of when the app happens to start. Falls back to the
 * browser's language outside Cockpit.
 */
const pickLang = () => {
  const host = (typeof cockpit !== 'undefined' && cockpit.lang) || '';
  const lang = host || navigator.language;
  return lang.indexOf('zh') === 0 ? 'zh' : 'en';
};

/** Re-render on host language change; the broadcast still arrives live. */
function useLang() {
  const [lang, setLang] = useState(pickLang);
  useEffect(() => {
    const onMessage = (e) => {
      if (e.data?.type === 'cockpit:language-change') setLang(pickLang());
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return (key) => DICT[lang][key];
}

// ----------------------------------------------------------------------- app

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

function App() {
  const file = new URLSearchParams(location.search).get('file');
  useEffect(() => {
    if (file) document.title = baseOf(file) || 'File Viewer';
  }, [file]);

  if (!file) {
    return <Status kind="error">file-viewer: missing ?file=&lt;absolute path&gt;</Status>;
  }
  const ext = extOf(file);
  if (ext === 'md') return <MarkdownView file={file} />;
  if (ext === 'json') return <JsonView file={file} />;
  if (ext === 'pdf') return <PdfView file={file} />;
  if (IMAGE_EXTS.indexOf(ext) >= 0) return <ImageView file={file} />;
  return <Status kind="error">{'file-viewer: unsupported file type .' + ext + '\n' + file}</Status>;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
