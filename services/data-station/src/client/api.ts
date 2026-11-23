import { MUSE_LOGIN_PATH } from '../shared/types';
import { applicationUrl } from './url';

export const AUTH_REJECTED_EVENT = 'muse-data-auth-rejected';
export const AUTH_RECHECK_EVENT = 'muse-data-auth-recheck';
let identityGeneration = 0;

/** Stops responses started by a previous confirmed identity from invalidating the current account. */
export function advanceRequestIdentity(): void { identityGeneration++; }

/** Guards later body reads and file saves belonging to the identity that started an action. */
export function captureRequestIdentity(): () => void {
  const generation = identityGeneration;
  return () => { if (generation !== identityGeneration) throw new ApiError('账号已变化，请重新操作', 409); };
}

/** Checks authorization only for the identity that started this JSON, upload, or download request. */
export async function authenticatedFetch(path: string, init?: RequestInit): Promise<Response> {
  const generation = identityGeneration;
  const response = await fetch(applicationUrl(path), init);
  if (generation !== identityGeneration) throw new ApiError('账号已变化，请重新操作', 409);
  const login = response.status === 401 ? response.headers.get('X-Muse-Data-Login') : null;
  // Only the fixed same-origin Muse sign-in path is followed; the header never carries an external address.
  if (login === MUSE_LOGIN_PATH && typeof window !== 'undefined') window.location.assign(MUSE_LOGIN_PATH);
  if ((response.status === 401 || response.status === 403 && response.headers.get('X-Muse-Data-Authenticated') !== '1') && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_REJECTED_EVENT));
  else if (response.status === 403 && path !== '/api/session' && typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_RECHECK_EVENT));
  return response;
}

/** Read same-origin application data and surface a useful API error. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const error: { error?: string; message?: string } = await response.json();
      message = error.error || error.message || message;
    } catch {
      // Non-JSON HTTP errors retain their status for the user.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
/** Preserves the HTTP status for authentication-aware callers. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}
