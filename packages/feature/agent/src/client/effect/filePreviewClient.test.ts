import { afterEach, describe, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { readFileForPreview } from './agentClient';

afterEach(() => vi.unstubAllGlobals());

describe('preview read errors', () => {
  it.each([[409, 'File appears to be binary'], [413, 'File too large (over 10MB)'], [404, 'file not found: /tmp/missing']])('preserves the error from HTTP %s', async (status, error) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error }, { status: status as number })));
    const result = await Effect.runPromise(Effect.either(readFileForPreview('/tmp/review.APElEH')));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left.message).toBe(error);
  });

  it('keeps an empty text response as a successful preview', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ content: '' })));
    expect(await Effect.runPromise(readFileForPreview('/tmp/empty'))).toEqual({ content: '' });
  });
});
