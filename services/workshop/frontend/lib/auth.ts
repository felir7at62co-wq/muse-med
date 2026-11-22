/**
 * 认证工具:token管理 + fetch包装
 */

const TOKEN_KEY = "drama_access_token";
const REFRESH_KEY = "drama_refresh_token";
const USER_KEY = "drama_user";

export type User = {
  id: number;
  username: string;
  display_name?: string;
  role: string;
  status: string;
  avatar_url?: string;
  feature_flags?: Record<string, boolean>;
  quota_daily: number;
  quota_used_today: number;
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function getUser(): User | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setAuth(user: User, accessToken: string, refreshToken?: string) {
  localStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isAdmin(): boolean {
  const u = getUser();
  return u?.role === "admin" || u?.role === "superadmin";
}

// 是否有"小说转视频"权限: 管理员默认全通; 普通用户看后端下发的 feature_flags 白名单。
export function canNovelVideo(): boolean {
  const u = getUser();
  if (!u) return false;
  if (u.role === "admin" || u.role === "superadmin") return true;
  return !!u.feature_flags?.novel_video;
}

// 是否有"视频交付"权限: 管理员默认全通; 普通用户看后端下发的 feature_flags 白名单。
export function canVideoDelivery(): boolean {
  const u = getUser();
  if (!u) return false;
  if (u.role === "admin" || u.role === "superadmin") return true;
  return !!u.feature_flags?.video_delivery;
}

/**
 * fetch包装:自动带token,401时清除token跳转登录
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    // token失效,清除并跳登录
    clearAuth();
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/jubengongfang/login")) {
      window.location.href = "/jubengongfang/login?from=" + encodeURIComponent(window.location.pathname);
    }
  }
  return res;
}

export async function login(username: string, password: string): Promise<{ user: User; ok: boolean; error?: string }> {
  const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
  try {
    const res = await fetch(`${BASE}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "登录失败" }));
      return { user: null as any, ok: false, error: err.detail || `HTTP ${res.status}` };
    }
    const data = await res.json();
    setAuth(data.user, data.access_token, data.refresh_token);
    return { user: data.user, ok: true };
  } catch (e: any) {
    return { user: null as any, ok: false, error: String(e) };
  }
}

export async function register(username: string, password: string, displayName?: string): Promise<{ user: User; ok: boolean; error?: string }> {
  const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
  try {
    const res = await fetch(`${BASE}/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, display_name: displayName }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "注册失败" }));
      return { user: null as any, ok: false, error: err.detail || `HTTP ${res.status}` };
    }
    const data = await res.json();
    setAuth(data.user, data.access_token, data.refresh_token);
    return { user: data.user, ok: true };
  } catch (e: any) {
    return { user: null as any, ok: false, error: String(e) };
  }
}

export async function logout() {
  const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
  try {
    await authFetch(`${BASE}/v1/auth/logout`, { method: "POST" });
  } catch {}
  clearAuth();
  if (typeof window !== "undefined") window.location.href = "/jubengongfang/login";
}
