'use strict';

const { audience, prefix, parent: parentOrigin } = document.querySelector('main').dataset;
const button = document.querySelector('#login');
const message = document.querySelector('#message');
const pendingKey = 'muse-login-' + audience;

async function post(path, data) {
  const result = await fetch(prefix + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    cache: 'no-store',
  });
  const response = await result.json();
  if (!result.ok) throw new Error(typeof response.detail === 'string' ? response.detail : '登录失败，请重新登录');
  return response;
}

function desktopGrant({ requestId, challenge }) {
  if (!parentOrigin) throw new Error('此工作台尚未设置 Muse 桌面入口');
  return new Promise((resolve, reject) => {
    function stop() {
      window.removeEventListener('message', receive);
      clearTimeout(timeout);
    }
    function receive(event) {
      const answer = event.data;
      if (event.origin !== parentOrigin || event.source !== window.parent
          || answer?.type !== 'muse-workbench-login-result' || answer.requestId !== requestId) return;
      stop();
      if (answer.error === 'sign-in-required') reject(new Error('请先在 Muse 中登录，再点此按钮'));
      else if (!/^[a-zA-Z0-9_-]{43}$/.test(answer.code || '')) reject(new Error('Muse 暂时无法授权，请重新登录'));
      else resolve(answer.code);
    }
    const timeout = setTimeout(() => {
      stop();
      reject(new Error('未收到 Muse 授权，请重新登录'));
    }, 30000);
    window.addEventListener('message', receive);
    window.parent.postMessage({ type: 'muse-workbench-login', requestId, challenge }, parentOrigin);
  });
}

async function finish(requestId, code) {
  const session = await post('/exchange', { requestId, code });
  if (window.parent !== window) window.museWorkbenchStorage.select(session.user?.id);
  if (!session.token) throw new Error('镜流未返回登录凭证');
  localStorage.removeItem('sf_claim_prod');
  localStorage.setItem('sf_session_prod', session.token);
  location.replace('/sfp/');
}

async function login() {
  if (location.pathname.endsWith('/callback')) {
    const query = new URLSearchParams(location.search);
    history.replaceState(null, '', prefix + '/login');
    const saved = sessionStorage.getItem(pendingKey);
    sessionStorage.removeItem(pendingKey);
    const pending = saved && JSON.parse(saved);
    if (!pending || pending.state !== query.get('state')) throw new Error('登录已过期，请重新登录');
    if (query.get('error') || !query.get('code')) throw new Error('Muse 登录已取消');
    await finish(pending.requestId, query.get('code'));
  } else if (window.parent !== window) {
    if (!window.museWorkbenchStorage) throw new Error('工作台未能隔离当前账号，请刷新');
    window.museWorkbenchStorage.detach();
    const attempt = await post('/challenge', {});
    const code = await desktopGrant(attempt);
    await finish(attempt.requestId, code);
  } else {
    const attempt = await post('/browser/start', {});
    sessionStorage.setItem(pendingKey, JSON.stringify({ requestId: attempt.requestId, state: attempt.state }));
    location.assign(attempt.authorizeUrl);
  }
}

async function run() {
  button.disabled = true;
  message.textContent = '正在连接 Muse…';
  try {
    await login();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : '登录失败，请重试';
    button.disabled = false;
  }
}

button.addEventListener('click', run);
if (location.pathname.endsWith('/callback')) void run();
if (location.pathname.endsWith('/embed') && window.parent !== window) {
  if (document.readyState === 'complete') void run();
  else window.addEventListener('load', run, { once: true });
}
