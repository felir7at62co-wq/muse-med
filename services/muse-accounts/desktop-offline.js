/** Reconnect the account's own desktop without choosing a computer. */
const button = document.getElementById('retry-desktop');
const status = document.getElementById('desktop-status');
let pending = false;
let timer;
async function check() {
 if (pending || document.hidden) return;
 pending = true;
 try {
  const response = await fetch('/api/desktop/status', { cache: 'no-store', redirect: 'manual' });
  if (response.type === 'opaqueredirect' || response.status === 401) { location.assign('/login'); return; }
  if (response.ok && (await response.json()).state === 'online') { location.reload(); return; }
  status.textContent = '正在等待您的电脑上线…';
 } catch (error) { status.textContent = '连接暂时不可用，正在重试…'; }
 finally { pending = false; }
}
button.addEventListener('click', () => { void check(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
timer = setInterval(() => { void check(); }, 5000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
void check();
