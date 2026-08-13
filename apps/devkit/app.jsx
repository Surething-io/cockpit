/**
 * DevKit -- seven high-frequency developer conversions, all pure computation.
 *
 * Deliberately does NOT use `cockpit.bash`: every tool here is input -> output
 * with no filesystem, network or system dependency, so shelling out would only
 * buy a ~50ms process spawn per keystroke and a "is that binary installed?"
 * failure mode. MD5 comes from ./md5.js, SHA from the browser's crypto.subtle.
 */
// React/ReactDOM come from the /html-lib script tags in index.html; `md5` is
// the global exported by the sibling ./md5.js script tag.
/* global React, ReactDOM, md5 */
const { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } = React;

/* ------------------------------------------------------------------ utils */

// crypto.subtle is a secure-context API. localhost (how Cockpit is normally
// reached) qualifies; a LAN IP does not, so the SHA rows degrade to a notice
// instead of throwing. getRandomValues has no such restriction, which is why
// UUIDs are built from it rather than from crypto.randomUUID.
const SUBTLE = typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null;

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decodeBase64(text) {
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeBase64Url(segment) {
  let s = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Decode a compact JWS. Decoding only -- the signature is shown but never
 * checked, because verifying needs the key (a shared secret for HS algorithms,
 * a public key for RS and ES ones) which this tool has no way to obtain.
 * The UI says so explicitly: a decoded token is not a trusted one.
 */
function decodeJwt(raw) {
  const token = raw.replace(/\s+/g, '');
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length === 5) {
    return { error: 'This looks like a JWE (5 segments) — the payload is encrypted and cannot be decoded without the key.' };
  }
  if (parts.length !== 3) {
    return { error: `A compact JWT has 3 dot-separated segments; this one has ${parts.length}.` };
  }

  const out = { signature: parts[2] };
  try {
    out.header = JSON.parse(decodeBase64Url(parts[0]));
  } catch (e) {
    return { error: `Header is not valid Base64URL-encoded JSON.\n\n${e.message}` };
  }
  try {
    out.payload = JSON.parse(decodeBase64Url(parts[1]));
  } catch (e) {
    return { error: `Payload is not valid Base64URL-encoded JSON.\n\n${e.message}` };
  }
  return out;
}

function relativeFromNow(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const units = [[86400000, 'day'], [3600000, 'hour'], [60000, 'minute'], [1000, 'second']];
  for (const [size, name] of units) {
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const plural = `${n} ${name}${n === 1 ? '' : 's'}`;
      return diff < 0 ? `${plural} ago` : `in ${plural}`;
    }
  }
  return 'just now';
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function uuidV4() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
  let h = '';
  for (let i = 0; i < 16; i++) h += b[i].toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

function formatLocal(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatUTC(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

// Digit count picks the unit, the way every timestamp tool does it.
function parseEpoch(raw) {
  const s = raw.trim();
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return { error: 'Digits only — seconds, milliseconds, microseconds or nanoseconds.' };
  const digits = s.replace('-', '').length;
  let ms, unit;
  if (digits <= 10) { ms = Number(s) * 1000; unit = 'seconds'; }
  else if (digits <= 13) { ms = Number(s); unit = 'milliseconds'; }
  else if (digits <= 16) { ms = Number(s) / 1000; unit = 'microseconds'; }
  else { ms = Number(s) / 1e6; unit = 'nanoseconds'; }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return { error: 'Out of the representable date range.' };
  return { date, unit };
}

function useDebounced(value, delay) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/* ------------------------------------------------------- shared components */

const ToastContext = createContext(() => {});

function CopyButton({ text, label }) {
  const toast = useContext(ToastContext);
  const onClick = useCallback(async () => {
    if (!text) return;
    try {
      // navigator.clipboard is also secure-context only; the textarea fallback
      // keeps copy working when DevKit is opened over a LAN IP.
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(`${label || 'Result'} copied`);
    } catch (e) {
      toast(`Copy failed: ${e.message}`);
    }
  }, [text, label, toast]);

  return (
    <button className="btn mini" onClick={onClick} disabled={!text}
            style={{ opacity: text ? 1 : 0.4, cursor: text ? 'pointer' : 'default' }}>
      Copy
    </button>
  );
}

function Segmented({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value}
                className={'seg-btn' + (o.value === value ? ' active' : '')}
                onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Input on the left, output on the right, controls above. */
function Workbench({ controls, value, onChange, placeholder, outputLabel, result }) {
  const failed = !!(result && result.error);
  const text = failed ? result.error : (result ? result.value : '');
  return (
    <div className="panel">
      <div className="bar">{controls}</div>
      <div className="cols">
        <div className="box">
          <div className="box-hd"><span>Input</span></div>
          <div className="box-body">
            <textarea className="io" value={value} spellCheck={false}
                      placeholder={placeholder}
                      onChange={(e) => onChange(e.target.value)} />
          </div>
        </div>
        <div className="box">
          <div className="box-hd">
            <span>{failed ? 'Error' : (outputLabel || 'Output')}</span>
            <CopyButton text={failed ? '' : text} label={outputLabel || 'Output'} />
          </div>
          <div className="box-body">
            <pre className={'io' + (failed ? ' error' : '')}>{text}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ panels */

function TextCodecPanel({ state, patch, kind }) {
  const debounced = useDebounced(state.text, 150);

  const result = useMemo(() => {
    if (!debounced) return { value: '' };
    try {
      if (kind === 'base64') {
        return { value: state.mode === 'encode' ? encodeBase64(debounced) : decodeBase64(debounced) };
      }
      return {
        value: state.mode === 'encode'
          ? encodeURIComponent(debounced)
          : decodeURIComponent(debounced),
      };
    } catch (e) {
      const hint = kind === 'base64'
        ? 'Not valid Base64 — check for stray characters or wrong padding.'
        : 'Not valid percent-encoding — check for a lone "%" or a bad escape.';
      return { error: `${e.message}\n\n${hint}` };
    }
  }, [debounced, state.mode, kind]);

  const controls = (
    <>
      <Segmented value={state.mode} onChange={(mode) => patch({ mode })}
                 options={[{ value: 'encode', label: 'Encode' }, { value: 'decode', label: 'Decode' }]} />
      <button className="btn" onClick={() => patch({ text: '' })}>Clear</button>
      <span className="bar-note">
        {kind === 'base64' ? 'UTF-8 safe — handles non-ASCII text.' : 'encodeURIComponent / decodeURIComponent.'}
      </span>
    </>
  );

  return (
    <Workbench controls={controls}
               value={state.text}
               onChange={(text) => patch({ text })}
               placeholder={state.mode === 'encode' ? 'Text to encode…' : 'Text to decode…'}
               outputLabel={state.mode === 'encode' ? 'Encoded' : 'Decoded'}
               result={result} />
  );
}

function JsonPanel({ state, patch }) {
  const debounced = useDebounced(state.text, 150);

  const result = useMemo(() => {
    if (!debounced.trim()) return { value: '' };
    try {
      const parsed = JSON.parse(debounced);
      return {
        value: state.mode === 'pretty'
          ? JSON.stringify(parsed, null, 2)
          : JSON.stringify(parsed),
      };
    } catch (e) {
      return { error: e.message };
    }
  }, [debounced, state.mode]);

  const controls = (
    <>
      <Segmented value={state.mode} onChange={(mode) => patch({ mode })}
                 options={[{ value: 'pretty', label: 'Pretty' }, { value: 'minify', label: 'Minify' }]} />
      <button className="btn" onClick={() => patch({ text: '' })}>Clear</button>
      <span className="bar-note">Parses as you type — the error message doubles as validation.</span>
    </>
  );

  return (
    <Workbench controls={controls}
               value={state.text}
               onChange={(text) => patch({ text })}
               placeholder='{"hello": "world"}'
               outputLabel={state.mode === 'pretty' ? 'Formatted' : 'Minified'}
               result={result} />
  );
}

const HASH_ALGOS = [
  { key: 'md5', label: 'MD5', subtle: null },
  { key: 'sha1', label: 'SHA-1', subtle: 'SHA-1' },
  { key: 'sha256', label: 'SHA-256', subtle: 'SHA-256' },
  { key: 'sha512', label: 'SHA-512', subtle: 'SHA-512' },
];

function HashPanel({ state, patch }) {
  const debounced = useDebounced(state.text, 150);
  const [digests, setDigests] = useState({});

  useEffect(() => {
    if (!debounced) { setDigests({}); return; }

    let cancelled = false;
    const bytes = new TextEncoder().encode(debounced);
    const next = { md5: md5(bytes) };

    if (!SUBTLE) {
      setDigests(next);
      return;
    }

    Promise.all(
      HASH_ALGOS.filter((a) => a.subtle).map((a) =>
        SUBTLE.digest(a.subtle, bytes).then((buf) => [a.key, toHex(buf)])
      )
    ).then((pairs) => {
      if (cancelled) return;
      for (const [key, hex] of pairs) next[key] = hex;
      setDigests({ ...next });
    }).catch(() => {
      if (!cancelled) setDigests(next);
    });

    // Guard against an out-of-order resolve overwriting a newer input.
    return () => { cancelled = true; };
  }, [debounced]);

  const controls = (
    <>
      <button className="btn" onClick={() => patch({ text: '' })}>Clear</button>
      <span className="bar-note">
        {SUBTLE
          ? 'MD5 computed locally; SHA via the browser\'s WebCrypto.'
          : 'SHA needs a secure context — open DevKit over localhost to enable it.'}
      </span>
    </>
  );

  return (
    <div className="panel">
      <div className="bar">{controls}</div>
      <div className="cols">
        <div className="box">
          <div className="box-hd"><span>Input</span></div>
          <div className="box-body">
            <textarea className="io" value={state.text} spellCheck={false}
                      placeholder="Text to hash…"
                      onChange={(e) => patch({ text: e.target.value })} />
          </div>
        </div>
        <div className="box">
          <div className="box-hd"><span>Digests</span></div>
          <div className="rows">
            {HASH_ALGOS.map((algo) => {
              const unavailable = algo.subtle && !SUBTLE;
              const value = digests[algo.key];
              const shown = unavailable
                ? 'unavailable outside a secure context'
                : (value || '—');
              return (
                <div className="row" key={algo.key}>
                  <span className="row-label">{algo.label}</span>
                  <span className={'row-value' + (value && !unavailable ? '' : ' muted')}>{shown}</span>
                  <CopyButton text={unavailable ? '' : (value || '')} label={algo.label} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Only the time claims get special treatment -- they are the ones unreadable as
// raw numbers. Everything else is already legible in the payload JSON above.
const TIME_CLAIMS = [
  { key: 'exp', label: 'Expires' },
  { key: 'iat', label: 'Issued' },
  { key: 'nbf', label: 'Not before' },
];

function JwtPanel({ state, patch }) {
  const debounced = useDebounced(state.text, 150);
  const decoded = useMemo(() => decodeJwt(debounced), [debounced]);

  const headerJson = decoded && decoded.header ? JSON.stringify(decoded.header, null, 2) : '';
  const payloadJson = decoded && decoded.payload ? JSON.stringify(decoded.payload, null, 2) : '';

  const claims = useMemo(() => {
    if (!decoded || !decoded.payload) return [];
    return TIME_CLAIMS
      .filter((c) => typeof decoded.payload[c.key] === 'number')
      .map((c) => {
        const seconds = decoded.payload[c.key];
        const date = new Date(seconds * 1000);
        const valid = !Number.isNaN(date.getTime());
        return {
          key: c.key,
          label: c.label,
          text: valid ? `${formatLocal(date)}  (${relativeFromNow(date.getTime())})` : 'not a valid time',
          // Only `exp` in the past is an actual problem; a past `iat` is normal.
          bad: valid && c.key === 'exp' && date.getTime() < Date.now(),
        };
      });
  }, [decoded]);

  const algNone = decoded && decoded.header &&
    typeof decoded.header.alg === 'string' && decoded.header.alg.toLowerCase() === 'none';

  return (
    <div className="panel">
      <div className="bar">
        <button className="btn" onClick={() => patch({ text: '' })}>Clear</button>
        <span className="bar-note">Decoded, not verified — the signature is never checked.</span>
      </div>

      <div className="cols">
        <div className="box">
          <div className="box-hd"><span>Token</span></div>
          <div className="box-body">
            <textarea className="io" value={state.text} spellCheck={false}
                      placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…"
                      onChange={(e) => patch({ text: e.target.value })} />
          </div>
        </div>

        <div className="box">
          <div className="box-hd"><span>{decoded && decoded.error ? 'Error' : 'Decoded'}</span></div>
          <div className="stack">
            {!decoded && (
              <div className="section"><span className="kv-v muted">Paste a JWT on the left.</span></div>
            )}

            {decoded && decoded.error && (
              <div className="section"><pre className="mono-block error">{decoded.error}</pre></div>
            )}

            {decoded && decoded.header && (
              <>
                <div className="section">
                  <div className="section-hd">
                    <span className="section-title">Header</span>
                    <CopyButton text={headerJson} label="Header" />
                  </div>
                  <pre className="mono-block">{headerJson}</pre>
                  {algNone && (
                    <span className="kv-v error">alg is &quot;none&quot; — this token is unsigned.</span>
                  )}
                </div>

                <div className="section">
                  <div className="section-hd">
                    <span className="section-title">Payload</span>
                    <CopyButton text={payloadJson} label="Payload" />
                  </div>
                  <pre className="mono-block">{payloadJson}</pre>
                </div>

                {claims.length > 0 && (
                  <div className="section">
                    <span className="section-title">Time claims</span>
                    {claims.map((c) => (
                      <div className="kv" key={c.key}>
                        <span className="kv-k">{c.label}</span>
                        <span className={'kv-v' + (c.bad ? ' error' : '')}>
                          {c.text}{c.bad ? '  — expired' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="section">
                  <span className="section-title">Signature</span>
                  <pre className="mono-block muted">{decoded.signature || '(empty)'}</pre>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TimestampPanel({ state, patch }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fromEpoch = useMemo(() => parseEpoch(state.epoch), [state.epoch]);

  const fromDate = useMemo(() => {
    const s = state.date.trim();
    if (!s) return null;
    // Normalise "2024-01-01 12:00:00" to the ISO-ish form Date reliably takes.
    const date = new Date(/^\d{4}-\d{2}-\d{2} /.test(s) ? s.replace(' ', 'T') : s);
    if (Number.isNaN(date.getTime())) {
      return { error: 'Unrecognised date — try 2024-01-01 12:00:00 or an ISO string.' };
    }
    return { date };
  }, [state.date]);

  const nowSeconds = String(Math.floor(now / 1000));

  return (
    <div className="panel">
      <div className="bar">
        <span className="bar-note">Now</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{nowSeconds}</span>
        <CopyButton text={nowSeconds} label="Timestamp (s)" />
        <span style={{ fontFamily: 'var(--font-mono)' }}>{String(now)}</span>
        <CopyButton text={String(now)} label="Timestamp (ms)" />
        <span className="bar-note">{formatLocal(new Date(now))}</span>
      </div>

      <div className="cols">
        <div className="box">
          <div className="box-hd"><span>Timestamp → Date</span></div>
          <div className="section">
            <div className="bar">
              <input className="text-in" value={state.epoch} spellCheck={false}
                     placeholder="1700000000"
                     onChange={(e) => patch({ epoch: e.target.value })} />
              <button className="btn" onClick={() => patch({ epoch: nowSeconds })}>Now</button>
            </div>
            {!fromEpoch && <div className="kv"><span className="kv-v muted">Enter a timestamp above.</span></div>}
            {fromEpoch && fromEpoch.error && (
              <div className="kv"><span className="kv-v error">{fromEpoch.error}</span></div>
            )}
            {fromEpoch && fromEpoch.date && (
              <>
                <div className="kv"><span className="kv-k">Detected</span><span className="kv-v muted">{fromEpoch.unit}</span></div>
                <div className="kv"><span className="kv-k">Local</span><span className="kv-v">{formatLocal(fromEpoch.date)}</span></div>
                <div className="kv"><span className="kv-k">UTC</span><span className="kv-v">{formatUTC(fromEpoch.date)}</span></div>
                <div className="kv"><span className="kv-k">ISO</span><span className="kv-v">{fromEpoch.date.toISOString()}</span></div>
              </>
            )}
          </div>
        </div>

        <div className="box">
          <div className="box-hd"><span>Date → Timestamp</span></div>
          <div className="section">
            <div className="bar">
              <input className="text-in" value={state.date} spellCheck={false}
                     placeholder="2024-01-01 12:00:00"
                     onChange={(e) => patch({ date: e.target.value })} />
              <button className="btn" onClick={() => patch({ date: formatLocal(new Date(now)) })}>Now</button>
            </div>
            {!fromDate && <div className="kv"><span className="kv-v muted">Enter a date above.</span></div>}
            {fromDate && fromDate.error && (
              <div className="kv"><span className="kv-v error">{fromDate.error}</span></div>
            )}
            {fromDate && fromDate.date && (
              <>
                <div className="kv">
                  <span className="kv-k">Seconds</span>
                  <span className="kv-v">{Math.floor(fromDate.date.getTime() / 1000)}</span>
                  <CopyButton text={String(Math.floor(fromDate.date.getTime() / 1000))} label="Seconds" />
                </div>
                <div className="kv">
                  <span className="kv-k">Millis</span>
                  <span className="kv-v">{fromDate.date.getTime()}</span>
                  <CopyButton text={String(fromDate.date.getTime())} label="Milliseconds" />
                </div>
                <div className="kv"><span className="kv-k">ISO</span><span className="kv-v">{fromDate.date.toISOString()}</span></div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UuidPanel({ state, patch }) {
  const generate = useCallback((count) => {
    const list = [];
    for (let i = 0; i < count; i++) list.push(uuidV4());
    patch({ list });
  }, [patch]);

  // Generate once on first mount so the panel is never empty.
  const listRef = useRef(state.list);
  listRef.current = state.list;
  useEffect(() => {
    if (listRef.current.length === 0) generate(state.count);
  }, []);

  const shown = useMemo(() => state.list.map((u) => {
    let v = state.dashes ? u : u.replace(/-/g, '');
    return state.upper ? v.toUpperCase() : v;
  }), [state.list, state.dashes, state.upper]);

  const text = shown.join('\n');

  return (
    <div className="panel">
      <div className="bar">
        <button className="btn" onClick={() => generate(state.count)}>Generate</button>
        <label className="check">
          Count
          <input className="num" type="number" min="1" max="50" value={state.count}
                 onChange={(e) => {
                   const n = Math.min(50, Math.max(1, Number(e.target.value) || 1));
                   patch({ count: n });
                 }} />
        </label>
        <label className="check">
          <input type="checkbox" checked={state.upper} onChange={(e) => patch({ upper: e.target.checked })} />
          Uppercase
        </label>
        <label className="check">
          <input type="checkbox" checked={state.dashes} onChange={(e) => patch({ dashes: e.target.checked })} />
          Dashes
        </label>
        <span className="bar-note">v4, from crypto.getRandomValues.</span>
      </div>

      <div className="cols" style={{ gridTemplateColumns: '1fr' }}>
        <div className="box">
          <div className="box-hd">
            <span>{shown.length} UUID{shown.length === 1 ? '' : 's'}</span>
            <CopyButton text={text} label="UUIDs" />
          </div>
          <div className="box-body">
            <pre className="io">{text}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- app */

const TABS = [
  { id: 'base64', label: 'Base64' },
  { id: 'url', label: 'URL' },
  { id: 'json', label: 'JSON' },
  { id: 'hash', label: 'Hash' },
  { id: 'jwt', label: 'JWT' },
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'uuid', label: 'UUID' },
];

const INITIAL = {
  base64: { mode: 'encode', text: '' },
  url: { mode: 'encode', text: '' },
  json: { mode: 'pretty', text: '' },
  hash: { text: '' },
  jwt: { text: '' },
  timestamp: { epoch: '', date: '' },
  uuid: { count: 5, upper: false, dashes: true, list: [] },
};

function App() {
  const [active, setActive] = useState('base64');
  // Every tool's state lives here, so switching tabs never loses input even
  // though only the active panel is mounted.
  const [state, setState] = useState(INITIAL);
  const [toastMsg, setToastMsg] = useState(null);

  const toastTimerRef = useRef(null);
  const toast = useCallback((message) => {
    setToastMsg(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMsg(null), 1600);
  }, []);
  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  const patchers = useMemo(() => {
    const out = {};
    for (const tab of TABS) {
      out[tab.id] = (changes) =>
        setState((prev) => ({ ...prev, [tab.id]: { ...prev[tab.id], ...changes } }));
    }
    return out;
  }, []);

  let panel;
  if (active === 'base64') panel = <TextCodecPanel kind="base64" state={state.base64} patch={patchers.base64} />;
  else if (active === 'url') panel = <TextCodecPanel kind="url" state={state.url} patch={patchers.url} />;
  else if (active === 'json') panel = <JsonPanel state={state.json} patch={patchers.json} />;
  else if (active === 'hash') panel = <HashPanel state={state.hash} patch={patchers.hash} />;
  else if (active === 'jwt') panel = <JwtPanel state={state.jwt} patch={patchers.jwt} />;
  else if (active === 'timestamp') panel = <TimestampPanel state={state.timestamp} patch={patchers.timestamp} />;
  else panel = <UuidPanel state={state.uuid} patch={patchers.uuid} />;

  return (
    <ToastContext.Provider value={toast}>
      <div className="app">
        <div className="tabs">
          {TABS.map((tab) => (
            <button key={tab.id}
                    className={'tab' + (tab.id === active ? ' active' : '')}
                    onClick={() => setActive(tab.id)}>
              {tab.label}
            </button>
          ))}
        </div>
        {panel}
        {toastMsg && <div className="toast">{toastMsg}</div>}
      </div>
    </ToastContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
