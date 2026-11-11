import { Effect } from 'effect';
import { open } from 'node:fs/promises';
import { FSError } from '@cockpit/effect-core';
import type { ContextCategory, ContextCategoryId, ContextItem } from '../../shared/contextSnapshot';

/** Per-item content cap. A single tool result can be megabytes; the viewer only needs to show it. */
export const MAX_ITEM_CONTENT = 200_000;

// CJK / kana / hangul / fullwidth: tokenizers spend roughly one token per char.
const WIDE = /[　-鿿가-힯豈-﫿＀-￯]/g;

/**
 * Character-based token estimate. Deliberately simple: the UI marks every
 * number produced here with "≈", and the provider's own total is shown next
 * to it whenever one exists.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const wide = text.match(WIDE)?.length ?? 0;
  return Math.ceil(wide + (text.length - wide) / 4);
}

export function textItem(id: string, label: string, text: string, format: ContextItem['format'] = 'text', extra?: Partial<ContextItem>): ContextItem {
  const truncated = text.length > MAX_ITEM_CONTENT;
  return {
    id, label, tokens: estimateTokens(text), format,
    content: truncated ? text.slice(0, MAX_ITEM_CONTENT) : text,
    ...(truncated ? { truncated } : {}),
    ...extra,
  };
}

/** Group items into categories in a fixed display order, dropping empty ones. */
export function categorize(buckets: Map<ContextCategoryId, ContextItem[]>, order: ContextCategoryId[]): ContextCategory[] {
  return order.flatMap((id) => {
    const items = buckets.get(id);
    if (!items?.length) return [];
    return [{ id, tokens: items.reduce((sum, item) => sum + (item.tokens ?? 0), 0), exact: false, items }];
  });
}

export function pushItem(buckets: Map<ContextCategoryId, ContextItem[]>, id: ContextCategoryId, item: ContextItem): void {
  const list = buckets.get(id);
  if (list) list.push(item); else buckets.set(id, [item]);
}

const CHUNK = 1 << 20;

/**
 * Lines from the LAST line matching `isStart` through EOF, in file order.
 *
 * Reads backwards in 1 MB chunks so a 100 MB+ append log costs only the bytes
 * after its last checkpoint (e.g. a compaction record). Splits on raw 0x0A,
 * which never occurs inside a UTF-8 multibyte sequence. When nothing matches,
 * the whole file is returned. `isStart` sees lines newest-first, exactly once
 * each, so it may carry state across calls.
 */
export const readLinesFromLastMatch = (path: string, isStart: (line: string) => boolean): Effect.Effect<string[], FSError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, 'r');
      try {
        const { size } = await handle.stat();
        const lines: string[] = [];
        let carry = Buffer.alloc(0);
        let pos = size;
        while (pos > 0) {
          const len = Math.min(CHUNK, pos);
          pos -= len;
          const chunk = Buffer.alloc(len);
          await handle.read(chunk, 0, len, pos);
          const buf = Buffer.concat([chunk, carry]);
          let end = buf.length;
          for (let i = buf.length - 1; i >= 0; i--) {
            if (buf[i] !== 0x0a) continue;
            const line = buf.subarray(i + 1, end).toString('utf8');
            end = i;
            if (!line.trim()) continue;
            lines.push(line);
            if (isStart(line)) return lines.reverse();
          }
          carry = buf.subarray(0, end);
        }
        // The file's first line has no newline before it; it still gets its isStart
        // call, since callers may capture state there (the result is the same either way).
        const first = carry.toString('utf8');
        if (first.trim()) {
          lines.push(first);
          isStart(first);
        }
        return lines.reverse();
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new FSError({ path, op: 'read', cause }),
  });

/** First line of a file without reading the rest (header records can be large; stops at the first newline). */
export const readFirstLine = (path: string): Effect.Effect<string | null, FSError> =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, 'r');
      try {
        const parts: Buffer[] = [];
        let pos = 0;
        for (;;) {
          const chunk = Buffer.alloc(CHUNK);
          const { bytesRead } = await handle.read(chunk, 0, CHUNK, pos);
          if (bytesRead === 0) break;
          const nl = chunk.subarray(0, bytesRead).indexOf(0x0a);
          if (nl >= 0) { parts.push(chunk.subarray(0, nl)); break; }
          parts.push(chunk.subarray(0, bytesRead));
          pos += bytesRead;
        }
        const line = Buffer.concat(parts).toString('utf8');
        return line.trim() ? line : null;
      } finally {
        await handle.close();
      }
    },
    catch: (cause) => new FSError({ path, op: 'read', cause }),
  });

export function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
