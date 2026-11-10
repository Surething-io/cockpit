import { describe, it, expect } from 'vitest';
import { heapArgs, heapLimitMb } from './heapLimit.mjs';

const GB = 1024 ** 3;

describe('heapLimitMb', () => {
  it('keeps Node\'s default on machines up to 16 GB', () => {
    expect(heapLimitMb(8 * GB)).toBeNull();
    expect(heapLimitMb(16 * GB)).toBeNull();
  });
  it('uses a quarter of RAM above that, capped at 16 GB', () => {
    expect(heapLimitMb(32 * GB)).toBe(8192);
    expect(heapLimitMb(64 * GB)).toBe(16384);
    expect(heapLimitMb(256 * GB)).toBe(16384);
  });
});

describe('heapArgs', () => {
  it('passes the computed limit', () => {
    expect(heapArgs({}, 64 * GB)).toEqual(['--max-old-space-size=16384']);
  });
  it('defers to an explicit NODE_OPTIONS limit', () => {
    expect(heapArgs({ NODE_OPTIONS: '--max-old-space-size=6000' }, 64 * GB)).toEqual([]);
  });
  it('honours COCKPIT_MAX_HEAP_MB', () => {
    expect(heapArgs({ COCKPIT_MAX_HEAP_MB: '12000' }, 8 * GB)).toEqual(['--max-old-space-size=12000']);
  });
  it('passes nothing on a small machine', () => {
    expect(heapArgs({}, 8 * GB)).toEqual([]);
  });
});
