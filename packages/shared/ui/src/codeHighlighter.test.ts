import { describe, it, expect } from 'vitest';
import type { ThemedToken } from 'shiki';
import { tokensToHtml, escapeHtml, MAX_TOKENS_PER_LINE } from './codeHighlighter';

// Minimal ThemedToken stand-ins — only `content` and `color` are read.
const tok = (content: string, color = '#0550ae') => ({ content, color }) as ThemedToken;
const line = (n: number, content = 'x') => Array.from({ length: n }, () => tok(content));
const spanCount = (html: string) => (html.match(/<span/g) || []).length;

describe('tokensToHtml', () => {
  it('colours every token on a normal line', () => {
    const html = tokensToHtml([tok('const', '#cf222e'), tok(' '), tok('a', '#0550ae')]);
    expect(spanCount(html)).toBe(3);
    expect(html).toContain('style="color:#cf222e"');
  });

  it('emits bare text for tokens with no colour', () => {
    const html = tokensToHtml([{ content: 'plain' } as ThemedToken]);
    expect(spanCount(html)).toBe(0);
    expect(html).toBe('plain');
  });

  it('escapes HTML in token content', () => {
    const html = tokensToHtml([tok('<script>&"')]);
    expect(html).toContain('&lt;script&gt;&amp;&quot;');
    expect(html).not.toContain('<script>');
  });

  it('still colours a line sitting exactly on the cap', () => {
    const html = tokensToHtml(line(MAX_TOKENS_PER_LINE));
    expect(spanCount(html)).toBe(MAX_TOKENS_PER_LINE);
  });

  // Chrome's hit-test / scroll cost for one un-wrapped line box is quadratic
  // in its inline-fragment count, so a 663KB single-line JSON (53,643 tokens)
  // froze the tab for ~8.8s per scroll event. Past the cap the line degrades
  // to plain text.
  it('degrades a line past the cap to zero spans', () => {
    const html = tokensToHtml(line(MAX_TOKENS_PER_LINE + 1));
    expect(spanCount(html)).toBe(0);
  });

  // Char-exactness is load-bearing, not cosmetic: getHighlightedLineHtml picks
  // its fast plain-text branch by testing `html !== escapeHtml(line)`, and
  // column math / selection / Cmd+click all count characters in the rendered
  // text. A degraded line must contain exactly what it always did.
  it('degrades to exactly escapeHtml(rawLine)', () => {
    const tokens = [...line(MAX_TOKENS_PER_LINE), tok('tail')];
    const raw = tokens.map(t => t.content).join('');
    expect(tokensToHtml(tokens)).toBe(escapeHtml(raw));
  });

  it('still escapes HTML on the degraded path', () => {
    const tokens = [...line(MAX_TOKENS_PER_LINE), tok('<script>alert(1)</script>')];
    const html = tokensToHtml(tokens);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // The cap is on token count, not line length, precisely so this case keeps
  // its colour: a huge JSON string value is one token and renders fine, while
  // a dense minified line of the same width is the actual hazard.
  it('keeps colour on a long-but-simple line', () => {
    const html = tokensToHtml([tok('"'), tok('y'.repeat(60_000)), tok('"')]);
    expect(spanCount(html)).toBe(3);
  });
});
