import type { BoardPeriod } from './types.ts';

/** Asia/Shanghai has kept UTC+8 without daylight saving since 1991, so day boundaries use a fixed offset. */
export const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

/** Returns the Beijing calendar date (`YYYY-MM-DD`) of an instant. */
export function beijingDate(iso: string): string {
  return new Date(Date.parse(iso) + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/** Moves a `YYYY-MM-DD` date by whole days. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Returns the inclusive first and last Beijing date of the period containing `date`.
 * Weeks run Monday to Sunday; months are calendar months.
 */
export function periodRange(period: BoardPeriod, date: string): { start: string; end: string; daysInPeriod: number } {
  if (period === 'day') return { start: date, end: date, daysInPeriod: 1 };
  if (period === 'week') {
    const weekday = (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
    const start = addDays(date, -weekday);
    return { start, end: addDays(start, 6), daysInPeriod: 7 };
  }
  const start = `${date.slice(0, 7)}-01`;
  const first = new Date(`${start}T00:00:00.000Z`);
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  return { start, end: addDays(next, -1), daysInPeriod: Math.round((Date.parse(next) - first.getTime()) / DAY_MS) };
}
