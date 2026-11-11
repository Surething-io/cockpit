import { describe, it, expect } from 'vitest';
import { heapArgs } from './heapLimit.mjs';

describe('heapArgs', () => {
  it('keeps Node\'s default when nothing is configured', () => {
    expect(heapArgs({})).toEqual([]);
  });
  it('defers to an explicit NODE_OPTIONS limit', () => {
    expect(heapArgs({ NODE_OPTIONS: '--max-old-space-size=6000', COCKPIT_MAX_HEAP_MB: '12000' })).toEqual([]);
  });
  it('honours COCKPIT_MAX_HEAP_MB', () => {
    expect(heapArgs({ COCKPIT_MAX_HEAP_MB: '12000' })).toEqual(['--max-old-space-size=12000']);
  });
  it('ignores a non-positive or garbage override', () => {
    expect(heapArgs({ COCKPIT_MAX_HEAP_MB: '0' })).toEqual([]);
    expect(heapArgs({ COCKPIT_MAX_HEAP_MB: 'lots' })).toEqual([]);
  });
});
