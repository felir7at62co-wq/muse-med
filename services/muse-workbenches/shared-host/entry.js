'use strict';
const mount = location.pathname.split('/')[1];
const statusText = document.getElementById('status');
const loginLink = document.querySelector('main a');
const button = document.querySelector('main button');
async function enter() {
  button.disabled = true;
  try {
    window.museWorkbenchStorage.detach();
    const res = await fetch('/' + mount + '/_session', { method: 'POST', cache: 'no-store' });
    if (!res.ok) {
      loginLink.hidden = res.status !== 401;
      throw new Error(res.status === 401 ? '请登录 Muse，然后回到此页进入工作台。' : res.status === 403 ? '此 Muse 账号尚未开通工作台。' : '暂时无法连接工作台，请稍后重试。');
    }
    const session = await res.json();
    window.museWorkbenchStorage.select(session.user.id);
    localStorage.removeItem('sf_claim_prod');
    localStorage.setItem('sf_session_prod', session.token);
    location.replace('/jingliu/sfp/');
  } catch (error) {
    statusText.textContent = error.message;
    button.hidden = false;
    button.disabled = false;
  }
}
button.addEventListener('click', enter);
void enter();
