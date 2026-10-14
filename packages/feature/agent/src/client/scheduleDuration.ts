/**
 * Scheduled tasks store durations as plain minutes (delayMinutes /
 * intervalMinutes). These helpers let the UI speak hours and days on top of
 * that without changing the stored shape.
 */

export type DurationUnit = 'minute' | 'hour' | 'day';

export const UNIT_MINUTES: Record<DurationUnit, number> = {
  minute: 1,
  hour: 60,
  day: 1440,
};

/** Largest unit that divides `minutes` evenly, so 1440 reads as "1 day", 90 as "90 minutes". */
export function splitMinutes(minutes: number): { value: number; unit: DurationUnit } {
  if (minutes > 0 && minutes % UNIT_MINUTES.day === 0) return { value: minutes / UNIT_MINUTES.day, unit: 'day' };
  if (minutes > 0 && minutes % UNIT_MINUTES.hour === 0) return { value: minutes / UNIT_MINUTES.hour, unit: 'hour' };
  return { value: minutes, unit: 'minute' };
}

/** Parsed custom input in minutes, or 0 when it is not a positive amount. */
export function toMinutes(value: string, unit: DurationUnit): number {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * UNIT_MINUTES[unit]);
}

/** Human-readable duration, e.g. "1 day" / "6 hours" / "90 minutes". */
export function formatMinutes(
  minutes: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const { value, unit } = splitMinutes(minutes);
  return t(`scheduledTasks.duration.${unit}`, { count: value });
}
