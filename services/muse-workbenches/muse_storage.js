// Embedded instances keep original storage keys scoped to this tab, workbench and linked account.
(() => {
  if (window === window.parent || window.museWorkbenchStorage) return;
  const audience = new URL(document.currentScript.src).pathname.startsWith('/fwp/') ? 'jingliu' : 'script-workshop';
  const marker = 'muse-embedded-owner:' + audience;
  const backing = window.sessionStorage;
  const prefix = () => 'muse-embedded:' + audience + ':' + (backing.getItem(marker) || 'guest') + ':';
  const names = () => Object.keys(backing).filter(key => key.startsWith(prefix())).map(key => key.slice(prefix().length));
  const methods = {
    getItem: key => backing.getItem(prefix() + key),
    setItem: (key, value) => backing.setItem(prefix() + key, value),
    removeItem: key => backing.removeItem(prefix() + key),
    key: index => names()[index] ?? null,
    clear: () => names().forEach(key => methods.removeItem(key)),
  };
  const storage = new Proxy(Object.create(null), {
    get(_, key) {
      if (key === 'length') return names().length;
      if (typeof key !== 'string') return undefined;
      return Object.hasOwn(methods, key) ? methods[key] : methods.getItem(key) ?? undefined;
    },
    set(_, key, value) { methods.setItem(key, value); return true; },
    deleteProperty(_, key) { methods.removeItem(key); return true; },
    ownKeys: names,
    getOwnPropertyDescriptor(_, key) {
      if (typeof key === 'string' && methods.getItem(key) !== null) return { configurable: true, enumerable: true };
    },
  });
  Object.defineProperty(window, 'localStorage', { value: storage });
  Object.defineProperty(window, 'museWorkbenchStorage', {
    value: {
      detach() {
        for (const key of ['sf_session_prod', 'sf_claim_prod', 'drama_access_token', 'drama_refresh_token', 'drama_user']) {
          methods.removeItem(key);
        }
        backing.removeItem(marker);
      },
      select(owner) {
        if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('工作台账号无效');
        backing.setItem(marker, String(owner));
      },
    },
  });
})();
