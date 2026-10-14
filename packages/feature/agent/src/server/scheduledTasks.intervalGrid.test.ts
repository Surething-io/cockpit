/**
 * Interval tasks fire on a fixed grid (anchor + k * interval) instead of
 * "last run end + interval", so run duration never accumulates as drift and a
 * missed slot is skipped rather than replayed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const MIN = 60_000;
const DAY = 1440 * MIN;

let home: string;
let nextIntervalFire: typeof import('./scheduledTasks').nextIntervalFire;

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so it must be set before the import.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;
  ({ nextIntervalFire } = await import('./scheduledTasks'));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.COCKPIT_HOME;
});

describe('nextIntervalFire', () => {
  const anchor = Date.UTC(2026, 9, 15, 1, 0); // any fixed instant

  it('returns the anchor itself while it is still ahead', () => {
    expect(nextIntervalFire(anchor, 1440, anchor - 5 * MIN)).toBe(anchor);
  });

  it('does not drift with run duration', () => {
    // Run fired at the anchor and took 5 minutes: next slot is still anchor + 1 day.
    expect(nextIntervalFire(anchor, 1440, anchor + 5 * MIN)).toBe(anchor + DAY);
  });

  it('steps strictly past now when settling exactly on a grid point', () => {
    expect(nextIntervalFire(anchor, 60, anchor)).toBe(anchor + 60 * MIN);
  });

  it('skips missed slots instead of replaying them', () => {
    // Down for 3.5 days: the next slot is day 4, not day 1.
    expect(nextIntervalFire(anchor, 1440, anchor + 3.5 * DAY)).toBe(anchor + 4 * DAY);
  });
});
