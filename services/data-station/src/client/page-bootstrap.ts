/** Reads the first-screen data the server embeds in the page, so the default board renders without waiting for requests. */
import { z } from 'zod';
import { platformSchema } from '../shared/work-schema';
import { PAGE_BOOTSTRAP_ELEMENT, type PageBootstrap } from '../shared/types';
import type { CatalogDisplayCache } from './catalog-display-cache';
import { boardDaysQuery, periodQuery } from './board-queries';

/** A confirmed account as `/api/session` and the embedded page data report it. */
export const sessionSchema = z.object({
  id: z.string().min(1).max(500), name: z.string(), role: z.enum(['admin', 'member']), mode: z.enum(['local-preview', 'server']),
  muse: z.object({ username: z.string().min(1).max(200), admin: z.boolean() }).optional(),
  department: z.string().max(200).optional(),
});


/**
 * Parses embedded first-screen data. The account is validated like `/api/session`; board fields carry the same trust as API responses from the same server.
 * @param text Content of the embedded JSON element.
 * @returns The data, or null when it is missing or malformed.
 */
export function parsePageBootstrap(text: string | null | undefined): PageBootstrap | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<Record<keyof PageBootstrap, unknown>>;
    const session = sessionSchema.safeParse(raw.session);
    const platform = platformSchema.safeParse(raw.platform);
    if (!session.success || !platform.success) return null;
    const value = raw as PageBootstrap;
    return { session: session.data, platform: platform.data, directory: value.directory ?? null, period: value.period ?? null, days: value.days ?? null };
  } catch (_error) {
    // Malformed embedded data leaves the page to read everything over the API.
    return null;
  }
}

let read: PageBootstrap | null | undefined;

/** Returns the page's embedded first-screen data, read once per page load; null when the page has none. */
export function readPageBootstrap(): PageBootstrap | null {
  if (read === undefined) read = parsePageBootstrap(typeof document === 'undefined' ? null : document.getElementById(PAGE_BOOTSTRAP_ELEMENT)?.textContent);
  return read;
}

/**
 * Holds the embedded default board in a display cache as data read at `version`, so its first render needs no request.
 * Nothing is held unless the directory, the latest day of its default board and that board's day list are all present.
 * @param cache Cache of the embedded account.
 * @param bootstrap Embedded first-screen data.
 * @param version Data version the page starts at.
 */
export function seedDisplayCache(cache: CatalogDisplayCache, bootstrap: PageBootstrap, version: number): void {
  const { platform, directory, period, days } = bootstrap;
  if (!directory?.defaultBoard || !period || !days || period.board !== directory.defaultBoard || period.platform !== platform || period.period !== 'day') return;
  cache.saveDirectory(platform, directory);
  cache.savePeriod(periodQuery(platform, period.board, 'day', ''), period, version);
  cache.savePeriod(periodQuery(platform, period.board, 'day', period.date), period, version);
  cache.saveBoardDays(boardDaysQuery(platform, period.board), days, version);
}
