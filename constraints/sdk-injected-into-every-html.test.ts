/**
 * Constraint: SdkInjectedIntoEveryHtml (invariant, L2 — property-based).
 *
 * Every .html / .htm document the /apps route serves gets window.cockpit, in
 * both address spaces, whatever the document contains and whatever the query
 * string says. There is no marker to opt in with. The one documented carve-out:
 * a local .html over MAX_INJECTABLE_HTML_BYTES (8 MB) is streamed raw.
 * Non-HTML files are never rewritten.
 *
 * Why: two earlier designs gated injection on a marker and both failed
 * silently — `?bash=1` was lost on form navigation, and `<meta name=
 * "cockpit-name">` let a page register as an app yet run without the SDK.
 * AGENTS.md says "Do not add a marker back"; this makes that rule executable.
 */
import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GET } from '../packages/feature/explorer/src/server/api/apps';
import { toLocalAppUrl } from '../packages/shared/utils/src/htmlBashSdk';

const SDK_SIGNATURE = 'window.cockpit = {';
const dir = mkdtempSync(join(tmpdir(), 'cockpit-sdk-inject-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
async function serve(fileName: string, body: string, query = ''): Promise<{ status: number; text: string }> {
  const file = join(dir, `${n++}-${fileName}`);
  writeFileSync(file, body);
  const res = await (GET as (req: Request) => Promise<Response>)(
    new Request(`http://localhost${toLocalAppUrl(file)}${query}`),
  );
  return { status: res.status, text: await res.text() };
}

// ── Generators: documents that used to (or could) suppress injection ──────────

const meta = fc.constantFrom(
  '',
  '<meta name="cockpit-name" content="my-app">',
  '<meta name="cockpit-name" content="">',
  '<meta charset="utf-8">',
);
const body = fc.string({ maxLength: 200 }).map((s) => s.replace(/</g, '&lt;'));
const document = fc
  .tuple(fc.boolean(), fc.boolean(), fc.boolean(), fc.constantFrom('head', 'HEAD', 'Head'), meta, body)
  .map(([doctype, withHtml, withHead, headTag, m, b]) => {
    const head = withHead ? `<${headTag}>${m}</${headTag}>` : m;
    const inner = `${head}<body>${b}</body>`;
    return `${doctype ? '<!doctype html>' : ''}${withHtml ? `<html lang="en">${inner}</html>` : inner}`;
  });
const htmlName = fc.constantFrom('index.html', 'page.htm', 'Report.HTML', 'a b (1).html');
const query = fc.constantFrom('', '?bash=0', '?bash=1', '?', '?q=', '?x=1&y=2');

describe('SdkInjectedIntoEveryHtml', () => {
  it('every local .html / .htm document gets window.cockpit, whatever it contains', async () => {
    await fc.assert(
      fc.asyncProperty(document, htmlName, query, async (doc, name, q) => {
        const { status, text } = await serve(name, doc, q);
        return status === 200 && text.includes(SDK_SIGNATURE);
      }),
      { numRuns: 120 },
    );
  });

  it('every built-in app document gets window.cockpit', async () => {
    for (const app of ['file-viewer', 'devkit']) {
      for (const suffix of ['index.html', 'index.html?file=/tmp/x.md']) {
        const res = await (GET as (req: Request) => Promise<Response>)(
          new Request(`http://localhost/apps/builtin/${app}/${suffix}`),
        );
        expect(res.status, `${app}/${suffix}`).toBe(200);
        expect(await res.text(), `${app}/${suffix}`).toContain(SDK_SIGNATURE);
      }
    }
  });

  it('non-HTML files are served unmodified', async () => {
    await fc.assert(
      fc.asyncProperty(document, fc.constantFrom('x.txt', 'x.md', 'app.jsx', 'data.json', 'style.css'), async (doc, name) => {
        const { text } = await serve(name, doc);
        return text === doc;
      }),
      { numRuns: 60 },
    );
  });

  it('the only carve-out: a local .html over 8 MB is streamed raw', async () => {
    const big = `<html><head></head><body>${'x'.repeat(8 * 1024 * 1024 + 1)}</body></html>`;
    const { text } = await serve('huge.html', big);
    expect(text.includes(SDK_SIGNATURE)).toBe(false);
    expect(text.length).toBe(big.length);
  });
});
