import { describe, it, expect } from 'vitest';
import { splitMinutes, toMinutes, formatMinutes } from './scheduleDuration';

describe('splitMinutes', () => {
  it('picks the largest unit that divides evenly', () => {
    expect(splitMinutes(4320)).toEqual({ value: 3, unit: 'day' });
    expect(splitMinutes(720)).toEqual({ value: 12, unit: 'hour' });
    expect(splitMinutes(90)).toEqual({ value: 90, unit: 'minute' });
    expect(splitMinutes(1500)).toEqual({ value: 25, unit: 'hour' });
  });
});

describe('toMinutes', () => {
  it('converts amount + unit to minutes', () => {
    expect(toMinutes('2', 'day')).toBe(2880);
    expect(toMinutes('1.5', 'hour')).toBe(90);
    expect(toMinutes('45', 'minute')).toBe(45);
  });

  it('rejects empty, zero and negative input', () => {
    expect(toMinutes('', 'hour')).toBe(0);
    expect(toMinutes('0', 'day')).toBe(0);
    expect(toMinutes('-3', 'minute')).toBe(0);
  });
});

describe('formatMinutes', () => {
  it('formats with the matching unit key', () => {
    const t = (key: string, opts?: Record<string, unknown>) => `${key}:${opts?.count}`;
    expect(formatMinutes(1440, t)).toBe('scheduledTasks.duration.day:1');
    expect(formatMinutes(360, t)).toBe('scheduledTasks.duration.hour:6');
    expect(formatMinutes(25, t)).toBe('scheduledTasks.duration.minute:25');
  });
});
