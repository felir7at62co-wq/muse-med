import { authFetch } from "./auth";

/**
 * 带鉴权的文件下载。
 *
 * ## 为什么需要它
 *
 * token 存在 **localStorage**(`lib/auth.ts`)，不是 cookie。所以
 * `<a href="...">` / `window.open(...)` / `new EventSource(...)` 这三种"浏览器自己发起"
 * 的请求**带不上 `Authorization` 头** —— 端点一旦加鉴权就会 401，
 * 而且失败形态很糟：浏览器直接打开一个新标签页显示一行 `{"detail":"..."}`。
 *
 * 正确做法是自己 fetch 拿 blob，再造一个临时 `<a download>` 点一下。
 * `apps/web` 里已有 5 处这么写(`_ExportMixedModal` / `_AdaptRoom` / `lib/critique` …)，
 * 这里把它收敛成一个函数，导出链接统一走这条路。
 *
 * @param url          完整 URL
 * @param fallbackName 后端没给 Content-Disposition 时用的文件名
 * @param init         额外的 fetch 参数(POST body 等)，默认 GET
 */
export async function downloadWithAuth(
  url: string,
  fallbackName: string,
  init?: RequestInit,
): Promise<void> {
  const r = await authFetch(url, init);
  if (!r.ok) {
    // 后端错误体一般是 JSON({detail})，非 JSON 时退回状态码
    const err = await r.json().catch(() => ({} as any));
    throw new Error(err?.detail || `导出失败 (HTTP ${r.status})`);
  }
  const blob = await r.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objUrl;
  a.download = filenameFromResponse(r) || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分浏览器会打断尚未开始的下载，推迟一拍更稳
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

/** 从 Content-Disposition 解析文件名，兼容 `filename*=UTF-8''xxx` 和裸 `filename="xxx"`。 */
export function filenameFromResponse(r: Response): string | null {
  const cd = r.headers.get("Content-Disposition") || "";
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = cd.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : null;
}
