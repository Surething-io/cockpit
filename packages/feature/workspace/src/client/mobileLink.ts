/**
 * Pure helpers for the top bar's "open on phone" QR code.
 */

/**
 * True when the page was opened through a loopback name. A phone cannot reach
 * the server through that address, so the QR code is only offered when the
 * browser reached cockpit through some other host (LAN IP, tunnel, domain).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The /m URL a phone should open. `cwd` + `sessionId` deep-link straight into
 * the chat (the mobile route only honours the pair together); the token is
 * swapped for a cookie by the server's access gate on the first request.
 */
export function buildMobileUrl(
  origin: string,
  opts: { cwd?: string; sessionId?: string; token?: string | null },
): string {
  const params = new URLSearchParams();
  if (opts.cwd && opts.sessionId) {
    params.set('cwd', opts.cwd);
    params.set('sessionId', opts.sessionId);
  }
  if (opts.token) params.set('token', opts.token);
  const qs = params.toString();
  return `${origin}/m${qs ? `?${qs}` : ''}`;
}
