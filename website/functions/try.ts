/**
 * Cloudflare Pages Function — `/try` (Try Online demo entrypoint).
 *
 * Ported from e2b/api/try.js (Vercel) so the entire demo flow lives under
 * cocking.cc and visitors never see vercel.app in their address bar.
 *
 * Two-step flow:
 *   1. GET /try            → confirmation page (also blocks link-preview bots)
 *   2. GET /try?confirm=1  → create E2B sandbox via API → 302 to sandbox URL
 *
 * Cooldown: 5 minutes per visitor (cookie-based) to prevent abuse.
 * Required env binding (set in Cloudflare Pages dashboard → Settings → Variables):
 *   E2B_API_KEY  (server-side, never exposed to the browser)
 */

const COOLDOWN_MS = 5 * 60 * 1000;
const E2B_API = 'https://api.e2b.dev';

const CONFIRM_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Cockpit Demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; max-width: 420px; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { color: #999; margin: 0 0 28px; line-height: 1.5; }
  a { display: inline-block; padding: 12px 32px; background: #4ab9b3; color: #0a0a0a; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600; transition: background 0.15s; }
  a:hover { background: #5fcdc7; }
  .footnote { margin-top: 24px; font-size: 12px; color: #555; }
</style></head>
<body><div class="card">
  <h1>Cockpit Demo</h1>
  <p>5-minute sandbox with Explorer &amp; Terminal.<br>(no AI chat in this demo)</p>
  <a href="?confirm=1">Start Demo →</a>
  <div class="footnote">Sandbox launches on e2b.dev</div>
</div></body></html>`;

interface Env {
  E2B_API_KEY: string;
}

interface SandboxResponse {
  sandboxID: string;
  domain?: string;
}

function isBot(ua: string | null): boolean {
  if (!ua) return true;
  return /axios|curl|wget|python|bot|crawler|spider|scraper|preview|fetch|http\.client/i.test(ua);
}

function readCooldownCookie(cookieHeader: string | null): number {
  if (!cookieHeader) return 0;
  const match = cookieHeader.match(/(?:^|;\s*)cockpit_demo=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  // Bot filter — including most link-preview crawlers (iMessage, Slack, etc.)
  if (isBot(request.headers.get('User-Agent'))) {
    return jsonError('Forbidden', 403);
  }

  // Step 1: confirmation page
  if (request.method === 'GET' && !url.searchParams.has('confirm')) {
    return new Response(CONFIRM_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  // Step 2: cooldown check
  const lastTry = readCooldownCookie(request.headers.get('Cookie'));
  const now = Date.now();
  if (lastTry && now - lastTry < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (now - lastTry)) / 1000);
    return jsonError(`Please wait ${waitSec}s before trying again.`, 429);
  }

  if (!env.E2B_API_KEY) {
    console.error('[/try] E2B_API_KEY is not configured');
    return jsonError('Demo is temporarily unavailable.', 503);
  }

  // Step 3: create sandbox via E2B API
  try {
    const apiRes = await fetch(`${E2B_API}/sandboxes`, {
      method: 'POST',
      headers: {
        'X-API-Key': env.E2B_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        templateID: 'cockpit-demo',
        timeout: 300,
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error('[/try] E2B API error:', apiRes.status, errBody);
      return jsonError('Failed to create demo sandbox.', 502);
    }

    const sandbox = (await apiRes.json()) as SandboxResponse;
    const domain = sandbox.domain || 'e2b.dev';
    const sandboxUrl = `https://3457-${sandbox.sandboxID}.${domain}/?cwd=${encodeURIComponent('/home/user/demo-project')}`;

    return new Response(null, {
      status: 302,
      headers: {
        'Location': sandboxUrl,
        'Set-Cookie': `cockpit_demo=${now}; Path=/; Max-Age=300; SameSite=Lax; Secure`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    console.error('[/try] Failed to create sandbox:', err);
    return jsonError('Failed to create demo sandbox.', 500);
  }
};

// Type stub — Cloudflare provides the real type at runtime via @cloudflare/workers-types.
type PagesFunction<E = unknown> = (context: {
  request: Request;
  env: E;
  next: () => Promise<Response>;
  [key: string]: unknown;
}) => Response | Promise<Response>;
