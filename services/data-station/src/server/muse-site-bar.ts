/** Server-rendered copy of the Muse website header so the data station shows it on first paint, in the same order and position. */
import type { UserIdentity } from '../shared/types.ts';

// Existing Muse Bot star, DS Bot / Fei2411 and contributors, Apache-2.0 (same mark as the Muse website header).
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M40.1 4.4l1.5-.4 1.9.1 5.2 1.1 1.9.9 13.2 14.9 17.1-.8 5.2 1.1 1.8.9 1.7 1.6.7 2.4-.4 1.9-9.7 23.6 5.6 23.7.1 1.9-.6 1.4-2.1 1.8-2.3.5-19.9-1.8-16.6 15.5-1.9 1-1.9.3-7-1.5-2.6-2.1-.9-2.4-2.8-24.1-16-13.6-1.1-1.5-.5-1.9.4-1.9 1.2-1.5 18.9-13.6 7.1-24.6 1-1.7z"/><g fill="#fff" transform="rotate(-10 60 51)"><rect x="50" y="44" width="7" height="19" rx="3.5"/><rect x="62" y="40" width="7" height="19" rx="3.5"/></g></svg>';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/**
 * Renders the Muse header with the same link order as the Muse gateway: 数据站 follows 意见箱 and precedes administrator links.
 * @param muse Signed-in Muse account; its admin flag shows Muse administrator links only.
 * @returns Escaped header HTML.
 */
export function renderMuseSiteBar(muse: NonNullable<UserIdentity['muse']>): string {
  const links: Array<[string, string]> = [['/workbench', '工作台'], ['/computers', '我的电脑'], ['/feedback', '意见箱'], ['/data/', '数据站'],
    ...(muse.admin ? [['/admin', '用户管理'], ['/admin/usage', 'Token 用量']] as Array<[string, string]> : [])];
  return `<header class="muse-site-bar" data-testid="muse-site-bar"><div class="muse-site-bar-inner"><a class="muse-site-brand" href="/workbench" aria-label="Muse 首页"><span class="muse-site-mark">${MARK}</span><span>Muse<span class="muse-site-caption">创作工作台</span></span></a>`
    + `<nav class="muse-site-navigation" aria-label="Muse 导航">${links.map(([href, label]) => `<a href="${href}"${href === '/data/' ? ' aria-current="page"' : ''}>${label}</a>`).join('')}`
    + `<a class="muse-site-identity" href="/account">${escape(muse.username)}</a></nav></div></header>`;
}

/**
 * Inserts the header right after the opening body tag of the built page.
 * @param html Built index page.
 * @param user Confirmed account, or null.
 * @returns The page with the header for Muse sign-in accounts, otherwise unchanged.
 */
export function withMuseSiteBar(html: string, user: UserIdentity | null): string {
  if (!user?.muse) return html;
  return html.replace(/<body([^>]*)>/i, (_tag, attributes: string) => `<body${attributes} class="has-muse-bar">${renderMuseSiteBar(user.muse!)}`);
}
