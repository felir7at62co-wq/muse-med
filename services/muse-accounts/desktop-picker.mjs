/** Account-owned computer list using the gateway's existing page layout. */
import {desktopPrefix} from './desktop-route.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const platforms={win32:'Windows',darwin:'macOS',linux:'Linux',unknown:'电脑'};

/**
 * Render selectable online computers and retained offline installations.
 * @param {object[]} devices Private account device records with live presence.
 * @param {string|undefined} selected Previously selected installation; reconnection stays on this target.
 * @returns {string} Escaped page content with the polling observer.
 */
export function desktopPicker(devices,selected){
 const current=devices.find(d=>d.id===selected);
 const rows=devices.map(d=>`<li class="computer"><div><span class="computer-name">${escape(d.name)}</span><span class="computer-meta">${platforms[d.platform]} · ${d.state==='online'?'在线':'离线'}</span>${d.lastSeenAt===null?'':`<span class="computer-meta">最近连接：<time datetime="${new Date(d.lastSeenAt).toISOString()}">${escape(new Date(d.lastSeenAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}</time></span>`}</div>${d.state==='online'?`<a class="computer-open" href="${desktopPrefix(d.id)}">进入</a>`:'<button type="button" disabled>离线</button>'}</li>`).join('');
 return `<div class="eyebrow">MUSE</div><h1>选择电脑</h1><p>${current?`${escape(current.name)} 当前离线，请在这台电脑上启动 Muse。连接恢复后会返回这台电脑。`:'选择要操作的电脑。每台电脑保留自己的工作区、文件和会话。'}</p><p id="computer-status" role="status">${devices.some(d=>d.state==='online')?'点击“进入”打开对应电脑': '您的电脑上的 Muse 未启动，请打开 Muse 并登录同一个账号'}</p><ul id="computer-list" data-selected="${selected??''}" data-fingerprint="${escape(JSON.stringify(devices))}">${rows}</ul><nav><button id="retry-computers" type="button">刷新电脑列表</button><a href="/account">Muse 账号</a></nav><style>h1{font-weight:500}#computer-list{list-style:none;margin:24px 0;padding:0}.computer{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-bottom:1px solid #e3e3df}.computer-name{display:block;font-weight:500;overflow-wrap:anywhere}.computer-meta{display:block;margin-top:6px;font-size:13px;color:#666}.computer-open{padding:10px 18px;border:1px solid #ddd;border-radius:8px;text-decoration:none;white-space:nowrap}.computer button:disabled{background:transparent;color:#777;cursor:default}.computer-open:focus-visible{outline:2px solid #222;outline-offset:3px}@media(prefers-color-scheme:dark){body{background:#181818;color:#eee}main{background:#222;border-color:#444}p,small,.computer-meta,.computer button:disabled{color:#bbb}a{color:#eee}.computer,.computer-open{border-color:#555}.computer-open:focus-visible{outline-color:#eee}}</style><script src="/desktop-picker.js" defer></script>`;
}
