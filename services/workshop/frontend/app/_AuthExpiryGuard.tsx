"use client";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getToken, clearAuth } from "../lib/auth";

/**
 * AuthExpiryGuard — 全局登录态守卫
 *
 * 作用: 每次页面加载/路由切换时检查本地 JWT 是否缺失或已过期.
 *   - 解析 token 的 exp 声明 (无需请求后端)
 *   - 若 token 缺失/解析失败/已过期, 且当前不在公开页, 则清理登录态并跳转 /login
 *   - 避免用户在登录过期后看到"空壳页面"(头像/草稿都加载不出来), 需手动输入 /login
 *
 * 注: 这是兜底的客户端检查; authFetch 在收到 401 时仍会做同样的跳转.
 *     两者互补 —— 本守卫覆盖"刷新后还没发请求就已知过期"的场景.
 */

const PUBLIC_PREFIXES = ["/login", "/register", "/forgot-password"];

function isPublicPath(path: string): boolean {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

/** 解析 JWT payload, 取 exp (秒). 解析失败返回 null. */
function getTokenExp(token: string): number | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export function AuthExpiryGuard() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (isPublicPath(pathname)) return;

    const token = getToken();
    const nowSec = Date.now() / 1000;

    // 缺 token, 或能解析出 exp 且已过期 → 视为登录失效
    const exp = token ? getTokenExp(token) : null;
    const expired = !token || (exp !== null && exp <= nowSec);

    if (expired) {
      clearAuth();
      const from = encodeURIComponent(pathname);
      router.replace(`/login?from=${from}`);
    }
  }, [pathname, router]);

  return null;
}