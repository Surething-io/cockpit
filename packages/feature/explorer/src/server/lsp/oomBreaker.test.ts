/**
 * Out-of-memory circuit breaker in LSPServerRegistry.
 *
 * Regression cover for a tsserver that hit its heap limit ~27s into every
 * project load: each hover respawned it and waited out the whole doomed
 * load (37s). The breaker must stop the respawn loop, but must not trip on
 * a one-off OOM or on ordinary exits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __lspHealthTesting as H } from './LSPServerRegistry';

const KEY = 'typescript:/repo';
const SOON = 30_000;

describe('LSP OOM breaker', () => {
  beforeEach(() => {
    H.clear();
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('tolerates a single OOM', () => {
    H.recordExit(KEY, true, SOON);
    expect(H.isTripped(KEY)).toBe(false);
  });

  it('trips on back-to-back OOMs during load', () => {
    H.recordExit(KEY, true, SOON);
    H.recordExit(KEY, true, SOON);
    expect(H.isTripped(KEY)).toBe(true);
  });

  it('a clean exit in between resets the streak', () => {
    H.recordExit(KEY, true, SOON);
    H.recordExit(KEY, false, SOON);
    H.recordExit(KEY, true, SOON);
    expect(H.isTripped(KEY)).toBe(false);
  });

  it('an OOM after long uptime starts a new streak', () => {
    H.recordExit(KEY, true, SOON);
    H.recordExit(KEY, true, 60 * 60 * 1000);
    expect(H.isTripped(KEY)).toBe(false);
  });

  it('allows exactly one more attempt after the cooldown', () => {
    H.recordExit(KEY, true, SOON);
    H.recordExit(KEY, true, SOON);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(H.isTripped(KEY)).toBe(false);
    H.recordExit(KEY, true, SOON);
    expect(H.isTripped(KEY)).toBe(true);
  });

  it('is scoped per (language, cwd)', () => {
    H.recordExit(KEY, true, SOON);
    H.recordExit(KEY, true, SOON);
    expect(H.isTripped('typescript:/other')).toBe(false);
  });
});
