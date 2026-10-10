/**
 * Constraint: OriginGateOnEveryEntry (relationship / permission, L4).
 *
 * `checkOriginGate` in src/lib/auth.ts is the boundary for every request the
 * server accepts: the Host check (DNS rebinding) and the Origin check (CSRF /
 * cross-site WebSocket). It only protects what is routed through it, so both
 * entry points of the one server in server.mjs must call it before anything
 * else — the HTTP request handler and the WebSocket upgrade handler.
 *
 * Why: the docs used to name the extra Origin check on /ws/bash in
 * src/lib/wsServer.ts as "the only gate", which pointed future edits at the
 * wrong file. This check pins the real boundary where it lives.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const SERVER = readFileSync(join(__dirname, '..', 'server.mjs'), 'utf8');

/** Body of the first `{ … }` block that starts at or after `from`. */
function blockAfter(text: string, from: number): string {
  const open = text.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('unbalanced braces');
}

/** First non-comment statement of a block. */
function firstStatement(body: string): string {
  return body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('//')) ?? '';
}

describe('OriginGateOnEveryEntry', () => {
  it('server.mjs creates exactly one HTTP server and registers one upgrade handler', () => {
    expect(SERVER.match(/\bcreateServer\(/g) ?? []).toHaveLength(1);
    expect(SERVER.match(/\.on\(\s*['"]upgrade['"]/g) ?? []).toHaveLength(1);
  });

  it('the HTTP request handler calls checkOriginGate first', () => {
    const body = blockAfter(SERVER, SERVER.search(/\bcreateServer\(/));
    expect(firstStatement(body)).toMatch(/auth\.checkOriginGate\(/);
  });

  it('the upgrade handler calls checkOriginGate first', () => {
    const body = blockAfter(SERVER, SERVER.search(/\.on\(\s*['"]upgrade['"]/));
    expect(firstStatement(body)).toMatch(/auth\.checkOriginGate\(/);
  });
});
