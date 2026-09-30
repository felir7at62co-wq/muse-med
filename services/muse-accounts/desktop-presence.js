/** Observe the account's desktop without replacing its open workspace or unsent draft. */
(() => {
 let pending, timer, stopped = false, dialog;
 function dismiss() { if (dialog) { dialog.close(); dialog.remove(); dialog = undefined; } }
 function notice(message, expired = false) {
  if (!dialog) {
   dialog = document.createElement('dialog');
   dialog.setAttribute('aria-label', 'Muse 连接状态');
   Object.assign(dialog.style, { width: 'min(420px, calc(100vw - 32px))', padding: '28px', border: '1px solid #ddd', borderRadius: '18px', color: '#191919', background: '#fff', font: '16px system-ui, sans-serif' });
   const title = document.createElement('h2');
   title.style.fontSize = '20px'; title.style.marginTop = '0';
   const detail = document.createElement('p'); detail.setAttribute('role', 'status'); detail.style.lineHeight = '1.7';
   const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新连接';
   Object.assign(retry.style, { padding: '10px 16px', borderRadius: '8px', border: '1px solid #222', background: '#222', color: '#fff', font: 'inherit' });
   retry.addEventListener('click', () => { void check(); });
   const login = document.createElement('a'); login.href = '/login'; login.textContent = '重新登录'; login.hidden = true;
   dialog.append(title, detail, retry, login);
   dialog.addEventListener('cancel', event => event.preventDefault());
   document.body.append(dialog); dialog.showModal();
  }
  dialog.children[0].textContent = message;
  dialog.children[1].textContent = expired ? '登录已失效，请重新登录。未发送的内容仍保留在当前页面。' : '请在电脑上打开 Muse，并登录同一账号。连接恢复后会继续显示当前工作区。';
  dialog.children[2].hidden = expired; dialog.children[3].hidden = !expired;
 }
 async function check() {
  if (stopped || pending || document.hidden) return;
  const controller = new AbortController(); pending = controller;
  const deadline = setTimeout(() => controller.abort(), 10000);
  try {
   const response = await fetch('/api/desktop/status', { cache: 'no-store', redirect: 'manual', signal: controller.signal });
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
