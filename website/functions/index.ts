/**
 * Cloudflare Pages Function — runs at the edge for the exact path "/".
 *
 * Strategy:
 *   1. If the visitor has a `lang_pref` cookie → respect it (302 → /<pref>/).
 *   2. Otherwise read `Accept-Language` and pick zh / en (default en).
 *   3. Set `lang_pref` cookie so subsequent visits skip detection.
 *   4. Issue a 302 (not 301) — users may switch language later via the
 *      switcher, and we want browsers/proxies to re-check.
 *
 * Notes:
 *   - All locale pages (/en/*, /zh/*) are static HTML and served by Pages
 *     directly without invoking any Function. Only "/" pays the edge cost.
 *   - If this Function fails for any reason, Pages serves the static
 *     `index.html` shipped at the project root, which contains a JS-based
 *     fallback redirect (see app/page.tsx + components/RootRedirect.tsx).
 */

interface Env {}

const SUPPORTED = ['en', 'zh'] as const;
type Locale = (typeof SUPPORTED)[number];
const DEFAULT: Locale = 'en';

function pickFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT;
  // Format: "zh-CN,zh;q=0.9,en;q=0.8"
  const langs = header.toLowerCase();
  if (langs.includes('zh')) return 'zh';
  return 'en';
}

function pickFromCookie(cookieHeader: string | null): Locale | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)lang_pref=(en|zh)\b/);
  return (match?.[1] as Locale) ?? null;
}

export const onRequest: PagesFunction<Env> = (context) => {
  const { request } = context;
  const url = new URL(request.url);

  // Only intercept exactly "/", let everything else fall through to static files.
  if (url.pathname !== '/' && url.pathname !== '') {
    return context.next();
  }

  const cookiePref = pickFromCookie(request.headers.get('Cookie'));
  const target: Locale = cookiePref ?? pickFromAcceptLanguage(request.headers.get('Accept-Language'));

  const headers = new Headers({
    Location: `/${target}/`,
    'Cache-Control': 'private, no-cache, no-store, must-revalidate',
    Vary: 'Cookie, Accept-Language',
  });

  // Persist preference for 1 year if not already set
  if (!cookiePref) {
    headers.append(
      'Set-Cookie',
      `lang_pref=${target}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
  }

  return new Response(null, { status: 302, headers });
};

// Type stub for environments that don't have @cloudflare/workers-types installed.
// At deploy time, Cloudflare's runtime provides the real PagesFunction type.
type PagesFunction<E = unknown> = (context: {
  request: Request;
  env: E;
  next: () => Promise<Response>;
  // Other fields exist but are unused here.
  [key: string]: unknown;
}) => Response | Promise<Response>;
