import { describe, expect, it } from 'vitest';
import { dateGroupOf } from './ProjectSessionsModal';

describe('dateGroupOf', () => {
  // 2026-10-29 15:00 local time
  const now = new Date(2026, 9, 29, 15, 0).getTime();
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime();

  it('splits by local calendar day, not by 24-hour windows', () => {
    expect(dateGroupOf(at(29, 0), now)).toBe('today');
    // 16 hours ago, but on the previous calendar day
    expect(dateGroupOf(at(28, 23), now)).toBe('yesterday');
    expect(dateGroupOf(at(28, 0), now)).toBe('yesterday');
  });

  it('covers the five days before yesterday as last 7 days, then earlier', () => {
    expect(dateGroupOf(at(27, 23), now)).toBe('last7Days');
    expect(dateGroupOf(at(23, 0), now)).toBe('last7Days');
    expect(dateGroupOf(at(22, 23), now)).toBe('earlier');
  });
});
