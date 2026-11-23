import { afterEach, describe, expect, it, vi } from 'vitest';
import { advanceRequestIdentity, AUTH_RECHECK_EVENT, AUTH_REJECTED_EVENT, authenticatedFetch, captureRequestIdentity } from '../src/client/api.ts';

afterEach(() => { advanceRequestIdentity(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('prefixed client requests and confirmed identity failures', () => {
  it('requests the data-station prefix instead of the existing website root API', async () => {
    vi.stubEnv('BASE_URL', '/data/');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));
    await authenticatedFetch('/api/session', { credentials: 'same-origin' });
    expect(fetch).toHaveBeenCalledWith('/data/api/session', { credentials: 'same-origin' });
  });

  it('preserves a confirmed account on permission denial while still rejecting expired or unknown identities', async () => {
    vi.stubEnv('BASE_URL', '/');
    const target = new EventTarget(), rejected = vi.fn(), recheck = vi.fn();
    vi.stubGlobal('window', target); target.addEventListener(AUTH_REJECTED_EVENT, rejected);
    target.addEventListener(AUTH_RECHECK_EVENT, recheck);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403, headers: { 'X-Muse-Data-Authenticated': '1' } }));
    expect((await authenticatedFetch('/api/admin/settings')).status).toBe(403);
    expect(rejected).not.toHaveBeenCalled();
    expect(recheck).toHaveBeenCalledTimes(1);
    await authenticatedFetch('/api/session'); expect(recheck).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response('{}', { status: 401, headers: { 'X-Muse-Data-Authenticated': '1' } }));
    await authenticatedFetch('/api/session'); expect(rejected).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(new Response('{}', { status: 403 }));
    await authenticatedFetch('/api/works'); expect(rejected).toHaveBeenCalledTimes(2);
  });

  it('cannot let a previous account response or later file save affect a new identity', async () => {
    vi.stubEnv('BASE_URL', '/');
    const target = new EventTarget(), rejected = vi.fn();
    vi.stubGlobal('window', target); target.addEventListener(AUTH_REJECTED_EVENT, rejected);
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
    const checkIdentity = captureRequestIdentity();
    const pending = authenticatedFetch('/api/works');
    advanceRequestIdentity(); finish(new Response('{}', { status: 401 }));
    await expect(pending).rejects.toMatchObject({ status: 409 });
    expect(checkIdentity).toThrow('账号已变化');
    expect(rejected).not.toHaveBeenCalled();
  });

  it('refuses external or protocol-relative paths before issuing a request', async () => {
    vi.stubEnv('BASE_URL', '/data/');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(authenticatedFetch('https://example.invalid/api/session')).rejects.toThrow('same-origin');
    await expect(authenticatedFetch('//example.invalid/api/session')).rejects.toThrow('same-origin');
    expect(fetch).not.toHaveBeenCalled();
  });
});
