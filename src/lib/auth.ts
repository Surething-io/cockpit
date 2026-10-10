/**
 * auth.ts — shared-token access gate (opt-in via `cockpit --token <value>`).
 *
 * Consumed by server.mjs (plain boot): the request / upgrade / share gate. Kept
 * stdlib-only (node:crypto) and NOT Effect-wrapped so it imports cleanly into
 * the plain server boot. (Outside the EFFECT.md enforced globs — src/app/api/**
 * + src/lib/effect/** — so plain code is fine here.)
 *
 * Model (KISS):
 *   - Token mode is OFF unless COCKPIT_TOKEN is set (the --token flag sets it) →
 *     when off, everything is open (backward compatible).
 *   - When on, LOCAL requests are exempt; every non-local request must present
 *     the token (cookie / Authorization: Bearer / ?token=).
 *
 * "Local" = the TCP peer is loopback AND the request carries no forwarding
 * header. socket.remoteAddress can't be spoofed by a client; the forwarding-
 * header check defeats same-host proxies/tunnels (ngrok / Caddy / nginx) which
 * connect over loopback but relay a remote user — they all set X-Forwarded-For,
 * so a forwarded request never counts as local. The only blind spot is a
 * same-host proxy that strips all forwarding headers (a misconfiguration);
 * that is indistinguishable from genuine localhost and cannot be told apart.
 */
import { timingSafeEqual } from 'crypto';
import { hostname as osHostname } from 'os';

export const COOKIE_NAME = 'cockpit_token';
const QUERY_KEY = 'token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export function tokenEnabled(): boolean {
  return Boolean(process.env.COCKPIT_TOKEN);
}

function configuredToken(): string {
  return process.env.COCKPIT_TOKEN || '';
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function isLoopbackAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  // The whole 127.0.0.0/8 block, in both the IPv4 form and the IPv4-mapped IPv6 form a
  // dual-stack (`::`) listener reports. Matching only ::ffff:127.0.0.1 let a page
  // DNS-rebound to 127.0.0.2 skip the Host check (constraints/origin-gate-properties).
  return addr === '::1' || addr.startsWith('127.') || addr.toLowerCase().startsWith('::ffff:127.');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function tokenFromQuery(url: string): string | undefined {
  try {
    return new URL(url, 'http://localhost').searchParams.get(QUERY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

// Same URL minus the ?token= param (so the secret doesn't linger in the address
// bar / history after the cookie is set).
function stripTokenParam(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    u.searchParams.delete(QUERY_KEY);
    const qs = u.searchParams.toString();
    return u.pathname + (qs ? `?${qs}` : '') + (u.hash || '');
  } catch {
    return '/';
  }
}

export function makeCookie(token: string, secure: boolean): string {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export interface AccessInput {
  url: string;
  remoteAddr: string | undefined;
  cookieHeader: string | undefined;
  authHeader: string | undefined;
  /** Presence of any forwarding header → relayed by a proxy/tunnel. */
  forwarded: string | undefined;
  isWs: boolean;
  isHttps: boolean;
}

export type AccessDecision =
  | { action: 'pass' }
  | { action: 'redirect'; location: string; setCookie: string }
  | { action: 'deny' };

export function checkAccess(input: AccessInput): AccessDecision {
  // Token mode off → fully open (backward compatible).
  if (!tokenEnabled()) return { action: 'pass' };

  // Local callers (CLI / /cg curls / self-probe / browser on the host) are
  // exempt: genuine loopback peer with no forwarding header.
  if (!input.forwarded && isLoopbackAddr(input.remoteAddr)) {
    return { action: 'pass' };
  }

  const want = configuredToken();

  const cookieTok = parseCookies(input.cookieHeader)[COOKIE_NAME];
  if (cookieTok && safeEqual(cookieTok, want)) return { action: 'pass' };

  const auth = input.authHeader;
  const bearer =
    auth && auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  if (bearer && safeEqual(bearer, want)) return { action: 'pass' };

  const queryTok = tokenFromQuery(input.url);
  if (queryTok && safeEqual(queryTok, want)) {
    // WS can't carry a redirect — just accept the query token.
    if (input.isWs) return { action: 'pass' };
    // First visit via ?token= → set the cookie and bounce to a clean URL.
    return {
      action: 'redirect',
      location: stripTokenParam(input.url),
      setCookie: makeCookie(want, input.isHttps),
    };
  }

  return { action: 'deny' };
}

// ============================================================================
// Origin / Host gate — independent of token mode, always on.
//
// Two browser-borne attacks reach a local-only server even with no token:
//
//   1. DNS rebinding: an attacker page on evil.example re-resolves its own name
//      to 127.0.0.1. The browser then treats our responses as same-origin to the
//      attacker and lets it READ them (session transcripts, search results).
//      The only tell is the Host header, which still says evil.example.
//   2. Cross-site request forgery: any website can fire a "simple" POST
//      (text/plain body, no preflight) at http://127.0.0.1:<port>/api/... and
//      `parseJsonRaw` happily parses it — e.g. dispatching a bypassPermissions
//      agent run in an arbitrary cwd. Browsers always attach `Origin` to such
//      requests; curl, the cockpit CLI and skills never do.
//
// Rules (KISS):
//   - A LOOPBACK peer must address us by a loopback name, this machine's
//     hostname, or COCKPIT_ALLOWED_HOSTS. A forwarding header does NOT exempt
//     it: the header is client-controlled, and a DNS-rebound page can add it to
//     a same-origin request. It only defers to the token gate when token mode
//     is on (checkAccess then makes every forwarded request authenticate, and a
//     rebound page holds no cookie/bearer for this host). Tunnels without a
//     token must list their hostname in COCKPIT_ALLOWED_HOSTS.
//     Non-loopback peers (LAN with COCKPIT_HOST=0.0.0.0) are not checked here.
//   - A state-changing request (non GET/HEAD/OPTIONS) or a WebSocket upgrade
//     that carries an Origin must be same-origin with Host. No Origin → pass.
// ============================================================================

export interface OriginGateInput {
  method: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  remoteAddr: string | undefined;
  /** Presence of any forwarding header → relayed by a proxy/tunnel. */
  forwarded: string | undefined;
  isWs: boolean;
}

export type OriginGateDecision = { action: 'pass' } | { action: 'deny'; reason: string };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Hostname part of a Host header value: strips the port, keeps IPv6 brackets off. */
export function hostnameOfHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.trim().toLowerCase();
  if (!h) return null;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  const colon = h.lastIndexOf(':');
  return colon >= 0 ? h.slice(0, colon) : h;
}

function isLoopbackHostname(name: string): boolean {
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '::1' ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

function allowedExtraHostnames(): Set<string> {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const n = v?.trim().toLowerCase();
    if (n) out.add(n);
  };
  try {
    const hn = osHostname();
    add(hn);
    if (hn && !hn.includes('.')) add(`${hn}.local`);
  } catch {
    // os.hostname() never throws in practice; stay open to it.
  }
  const bind = process.env.COCKPIT_HOST;
  if (bind && bind !== '0.0.0.0' && bind !== '::') add(bind);
  for (const part of (process.env.COCKPIT_ALLOWED_HOSTS || '').split(',')) add(part);
  return out;
}

export function checkOriginGate(input: OriginGateInput): OriginGateDecision {
  if (isLoopbackAddr(input.remoteAddr)) {
    const name = hostnameOfHostHeader(input.host);
    const hostAllowed = !!name && (isLoopbackHostname(name) || allowedExtraHostnames().has(name));
    const deferToTokenGate = Boolean(input.forwarded) && tokenEnabled();
    if (!hostAllowed && !deferToTokenGate) {
      return { action: 'deny', reason: 'host not allowed' };
    }
  }

  const mutating = input.isWs || !SAFE_METHODS.has((input.method || 'GET').toUpperCase());
  if (mutating && input.origin !== undefined) {
    if (!input.host) return { action: 'deny', reason: 'missing host' };
    let originHost: string;
    try {
      originHost = new URL(input.origin).host;
    } catch {
      return { action: 'deny', reason: 'unparseable origin' };
    }
    if (!originHost || originHost.toLowerCase() !== input.host.trim().toLowerCase()) {
      return { action: 'deny', reason: 'cross-origin' };
    }
  }

  return { action: 'pass' };
}
