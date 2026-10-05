/** Observe the selected desktop without replacing its open workspace or unsent draft. */
(() => {
 const observer=document.currentScript;
 const base=new URL('./',observer.src),computerName=observer.dataset.name||'当前电脑';
 const style=document.createElement('style');
 style.textContent='body{padding-top:36px!important;box-sizing:border-box}#muse-desktop-context{box-sizing:border-box;position:fixed;z-index:1000;top:0;left:0;right:0;height:36px;display:flex;gap:12px;justify-content:space-between;align-items:center;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l3,#ddd);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#191919);font:13px system-ui,sans-serif}#muse-desktop-context span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}#muse-desktop-context a{color:inherit;white-space:nowrap}#muse-desktop-context a:focus-visible{outline:2px solid currentColor;outline-offset:3px}';
 document.head.append(style);
 const banner=document.createElement('nav');banner.id='muse-desktop-context';banner.setAttribute('aria-label','当前电脑');
 const name=document.createElement('span');name.textContent='电脑：'+computerName;
 function switchLink(){const link=document.createElement('a');link.href='/computers';link.target='_blank';link.rel='noopener';link.textContent='切换电脑';link.title='打开电脑列表，保留当前会话';link.style.color='inherit';return link;}
 banner.append(name,switchLink());document.body.append(banner);
 let pending, timer, stopped = false, dialog;
 function dismiss() { if (dialog) { dialog.close(); dialog.remove(); dialog = undefined; } }
 function notice(message, expired = false) {
  if (!dialog) {
   dialog = document.createElement('dialog');
   dialog.setAttribute('aria-label', 'Muse 连接状态');
   Object.assign(dialog.style, { boxSizing: 'border-box', width: 'min(420px, calc(100vw - 32px))', padding: '28px', border: '1px solid var(--dsw-alias-border-l3,#ddd)', borderRadius: 'var(--dsw-radius-lg,18px)', color: 'var(--dsw-alias-label-primary,#191919)', background: 'var(--dsw-alias-bg-base,#fff)', font: '16px system-ui, sans-serif' });
   const title = document.createElement('h2');
   title.style.fontWeight = '500'; title.style.fontSize = '20px'; title.style.marginTop = '0';
   const detail = document.createElement('p'); detail.setAttribute('role', 'status'); detail.style.lineHeight = '1.7';
   const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新连接';
   Object.assign(retry.style, { marginRight: '16px', padding: '10px 16px', borderRadius: '8px', border: '1px solid #222', background: '#222', color: '#fff', font: 'inherit' });
   retry.addEventListener('click', () => { void check(); });
   const login = document.createElement('a'); login.href = '/login'; login.textContent = '重新登录'; login.hidden = true; login.style.color = 'inherit'; login.style.marginRight = '16px';
   dialog.append(title, detail, retry, login,switchLink());
   dialog.addEventListener('cancel', event => event.preventDefault());
   document.body.append(dialog); dialog.showModal();
  }
  dialog.children[0].textContent = message;
  dialog.children[1].textContent = expired ? '登录已失效，请重新登录。未发送的内容仍保留在当前页面。' : `请在 ${computerName} 上打开 Muse，并登录同一账号。此页面会等待这台电脑，未发送的内容仍保留。`;
  dialog.children[2].hidden = expired; dialog.children[3].hidden = !expired;
 }
 async function check() {
  if (stopped || pending || document.hidden) return;
  const controller = new AbortController(); pending = controller;
  const deadline = setTimeout(() => controller.abort(), 10000);
  try {
   const response = await fetch(new URL('api/desktop/status',base), { cache: 'no-store', redirect: 'manual', signal: controller.signal });
   if (stopped) return;
   if (response.type === 'opaqueredirect' || response.status === 401 || (response.status >= 300 && response.status < 400)) { notice('Muse 登录已失效', true); return; }
   if (!response.ok) throw new Error('Desktop status unavailable');
   const status = await response.json();
   if (stopped) return;
   if (status.state === 'online') dismiss();
   else if (status.state === 'offline') notice('您的电脑上的 Muse 未启动');
   else throw new Error('Invalid desktop status');
  } catch (error) { if (!stopped) notice('暂时无法连接 Muse，正在重试'); }
  finally { clearTimeout(deadline); if (pending === controller) pending = undefined; }
 }
 function start() { stopped = false; clearInterval(timer); timer = setInterval(() => { void check(); }, 5000); void check(); }
 document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
 window.addEventListener('focus', () => { void check(); });
 window.addEventListener('pagehide', () => { stopped = true; clearInterval(timer); pending?.abort(); });
 window.addEventListener('pageshow', event => { if (event.persisted) start(); });
 start();
})();
