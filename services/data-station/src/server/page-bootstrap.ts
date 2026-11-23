/** First-screen data embedded in the served page, so a signed-in visit shows its default board without further requests. */
import type { BoardDirectory, BoardPeriodView, DataOrigin, PageBootstrap, Platform, SessionInfo } from '../shared/types.ts';
import { PAGE_BOOTSTRAP_ELEMENT } from '../shared/types.ts';
import type { DataRepository } from './repository.ts';
import type { ScriptLibrary } from './script-library.ts';

/** Board opened first per platform when it has been collected; otherwise the first board name. */
const PREFERRED_BOARDS: Record<Platform, string> = {
  hongguo: '综合热播榜', lvpaopao: '绿泡泡 · 口碑榜', douyin: '公开短剧作品监测（视频粒度，非榜单）',
  qimao: '男生榜 · 大热榜 · 日榜', fanqie: '男频 · 阅读榜 · 都市脑洞',
};

/** Platform whose board the page embeds; the client opens it unless the visitor last chose another. */
export const BOOTSTRAP_PLATFORM: Platform = 'hongguo';

/**
 * Lists a platform's collected board names and the board opened first.
 * @param repository Data store.
 * @param platform Platform whose boards are listed.
 * @param origin Data origin.
 * @returns Board names and the preferred board when collected, else the first name, else null.
 */
export async function boardDirectory(repository: DataRepository, platform: Platform, origin: DataOrigin): Promise<BoardDirectory> {
  const { boards } = await repository.listWorks({ platform, origin, page: 1, limit: 1 });
  return { boards, defaultBoard: boards.includes(PREFERRED_BOARDS[platform]) ? PREFERRED_BOARDS[platform] : boards[0] ?? null };
}

/**
 * Adds each listed work's current script metadata to a board period without modifying the shared view.
 * @param view Computed board period.
 * @param scripts Script library, when configured.
 * @returns A copy whose works carry `script`, null when none exists.
 */
export async function withScripts(view: BoardPeriodView, scripts: ScriptLibrary | undefined): Promise<BoardPeriodView> {
  const metadata = await scripts?.metadataForWorks(view.items.map(item => item.work.id));
  return { ...view, items: view.items.map(item => ({ ...item, work: { ...item.work, script: metadata?.[item.work.id] ?? null } })) };
}

/**
 * Builds the first-screen data for a confirmed account: the latest live day of the bootstrap platform's default board.
 * @param repository Data store.
 * @param scripts Script library, when configured.
 * @param session Confirmed account and server mode.
 * @returns The embedded data; board fields are null when the platform has no collected board.
 */
export async function buildPageBootstrap(repository: DataRepository, scripts: ScriptLibrary | undefined, session: SessionInfo): Promise<PageBootstrap> {
  const platform = BOOTSTRAP_PLATFORM;
  const directory = await boardDirectory(repository, platform, 'live');
  if (!directory.defaultBoard) return { session, platform, directory: null, period: null, days: null };
  const scope = { platform, board: directory.defaultBoard, origin: 'live' as const };
  const [view, days] = await Promise.all([repository.boardPeriod({ ...scope, period: 'day' }), repository.boardDays(scope)]);
  return { session, platform, directory, period: view ? await withScripts(view, scripts) : null, days: view ? days : null };
}

/**
 * Inserts first-screen data as a non-executable JSON element before the closing body tag.
 * `<` is escaped so no value can close the element; the page's script-src policy is unaffected.
 * @param html Served page.
 * @param bootstrap Data for the confirmed account.
 * @returns The page with the element.
 */
export function withPageBootstrap(html: string, bootstrap: PageBootstrap): string {
  const element = `<script type="application/json" id="${PAGE_BOOTSTRAP_ELEMENT}">${JSON.stringify(bootstrap).replace(/</g, '\\u003c')}</script>`;
  const end = html.lastIndexOf('</body>');
  return end < 0 ? html + element : html.slice(0, end) + element + html.slice(end);
}
