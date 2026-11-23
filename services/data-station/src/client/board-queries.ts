/** Request queries of live board periods and day lists; the display cache keys entries by them. */
import type { BoardPeriod, Platform } from '../shared/types';

/** Request query of one live board period; an empty date asks for the latest collected day. */
export function periodQuery(platform: Platform, board: string, period: BoardPeriod, date: string): string {
  const query = new URLSearchParams({ platform, board, origin: 'live', period });
  if (date) query.set('date', date);
  return query.toString();
}

/** Request query of one live board's collected-day list. */
export function boardDaysQuery(platform: Platform, board: string): string {
  return new URLSearchParams({ platform, board, origin: 'live' }).toString();
}
