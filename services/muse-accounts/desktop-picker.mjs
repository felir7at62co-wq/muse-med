/** Account-owned computer list using the gateway's existing page layout. */
import {desktopPrefix} from './desktop-route.mjs';

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const platforms={win32:'Windows',darwin:'macOS',linux:'Linux',unknown:'电脑'};

/**
 * Render selectable online computers while retaining the selected installation for reconnection.
 * @param {object[]} devices Private account device records with live presence.
 * @param {string|undefined} selected Previously selected installation; reconnection stays on this target.
 * @returns {string} Escaped page content with the polling observer.
 */
export function desktopPicker(devices,selected){
 const current=devices.find(d=>d.id===selected);
 const online=devices.filter(d=>d.state==='online');
 const rows=online.map(d=>`<li class="computer"><div><span class="computer-name">${escape(d.name)}</span><span class="computer-meta">${platforms[d.platform]} · 在线</span>${d.lastSeenAt===null?'':`<span class="computer-meta">最近连接：<time datetime="${new Date(d.lastSeenAt).toISOString()}">${escape(new Date(d.lastSeenAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}</time></span>`}</div><a class="computer-open" href="${desktopPrefix(d.id)}">进入</a></li>`).join('');
 return `<div class="eyebrow">MUSE</div><h1>选择电脑</h1><p>${current?`${escape(current.name)} 当前离线，请在这台电脑上启动 Muse。连接恢复后会返回这台电脑。`:'选择要操作的电脑。每台电脑保留自己的工作区、文件和会话。'}</p><p id="computer-status" role="status">${online.length?'点击“进入”打开对应电脑': '您的电脑上的 Muse 未启动，请打开 Muse 并登录同一个账号'}</p><ul id="computer-list" data-selected="${selected??''}" data-fingerprint="${escape(JSON.stringify(online))}">${rows}</ul><nav><button id="retry-computers" type="button">刷新电脑列表</button><a href="/account">Muse 账号</a></nav><script src="/desktop-picker.js" defer></script>`;
}
