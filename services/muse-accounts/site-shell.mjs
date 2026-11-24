/** Shared document and navigation for the account website; caller-owned content stays escaped by its renderer. */
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
// Existing Muse Bot star, DS Bot / Fei2411 and contributors, Apache-2.0.
const mark='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M40.1 4.4l1.5-.4 1.9.1 5.2 1.1 1.9.9 13.2 14.9 17.1-.8 5.2 1.1 1.8.9 1.7 1.6.7 2.4-.4 1.9-9.7 23.6 5.6 23.7.1 1.9-.6 1.4-2.1 1.8-2.3.5-19.9-1.8-16.6 15.5-1.9 1-1.9.3-7-1.5-2.6-2.1-.9-2.4-2.8-24.1-16-13.6-1.1-1.5-.5-1.9.4-1.9 1.2-1.5 18.9-13.6 7.1-24.6 1-1.7z"/><g fill="#fff" transform="rotate(-10 60 51)"><rect x="50" y="44" width="7" height="19" rx="3.5"/><rect x="62" y="40" width="7" height="19" rx="3.5"/></g></svg>';

/** Render navigation without advertising administrator operations to ordinary users.
 * @param {object} options Known page identifier, account label and administrator visibility.
 * @returns {string} Escaped same-origin navigation HTML.
 */
export function siteNavigation({active='',username='',admin=false,auth=false}={}){
 const links=[['workbench','/workbench','工作台'],['computers','/computers','我的电脑'],['feedback','/feedback','意见箱'],['data','/data/','数据站'],...(admin?[['users','/admin','用户管理'],['usage','/admin/usage','Token 用量']]:[])];
 return `<header class="site-topbar${auth?' site-topbar-auth':''}"><div class="site-topbar-inner"><a class="site-brand" href="${auth?'/login':'/workbench'}" aria-label="Muse 首页"><span class="site-brand-mark">${mark}</span><span>Muse<span class="site-brand-caption">创作工作台</span></span></a>${auth?'<span class="site-auth-caption">让灵感成形，让故事发生</span>':`<nav class="site-navigation" aria-label="主导航">${links.map(([id,href,label])=>`<a href="${href}"${active===id?' aria-current="page"':''}>${label}</a>`).join('')}<a class="site-identity" href="/account"${active==='account'?' aria-current="page"':''}>${escape(username||'我的账户')}</a></nav>`}</div></header>`;
}

/** Wrap already escaped page content in the website's shared shell and same-origin assets.
 * @param {object} options Page title, escaped content, presentation classes and existing asset URLs.
 * @returns {string} Complete HTML document without inline executable code.
 */
export function renderSitePage({title,body,auth=false,active='',admin=false,username='',mainClass='',mainAttributes='',styles=[],scripts=[],afterMain='',bodyAttributes=''}={}){
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" href="/favicon.ico"><title>${escape(title)} · Muse</title>${styles.map(href=>`<link rel="stylesheet" href="${escape(href)}">`).join('')}<link rel="stylesheet" href="/assets/site-shell.css">${scripts.map(src=>`<script src="${escape(src)}" defer></script>`).join('')}</head><body class="site-body page-${escape(active||'account')}${auth?' site-auth':''}" ${bodyAttributes}><a class="site-skip" href="#main-content">跳到主要内容</a>${siteNavigation({active,username,admin,auth})}<main id="main-content" class="site-main ${auth?'auth ':''}${escape(mainClass)}" ${mainAttributes}>${body}</main>${afterMain}</body></html>`;
}
