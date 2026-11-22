/**
 * 配额查询与消费 (Phase 5)
 * 对应后端 /v1/quotas/me 与 /v1/quotas/me/consume.
 */

import { authFetch } from "./auth";

export type QuotaKind = "prompt_converter" | "image_generation";

export interface QuotaSnapshot {
  date: string;
  prompt_converter: { used: number; limit: number; remaining: number };
  image_generation: { used: number; limit: number; remaining: number };
}

export async function fetchMyQuotas(): Promise<QuotaSnapshot> {
  const r = await authFetch("/v1/quotas/me");
  if (!r.ok) throw new Error(`quota fetch failed: ${r.status}`);
  return r.json();
}

export async function consumeQuota(kind: QuotaKind, count = 1): Promise<{ used: number; limit: number; remaining: number }> {
  const r = await authFetch(`/v1/quotas/me/consume?kind=${kind}&count=${count}`, { method: "POST" });
  if (r.status === 429) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.detail || "今日配额已用完");
  }
  if (!r.ok) throw new Error(`quota consume failed: ${r.status}`);
  return r.json();
}

/**
 * Hook 风格调用: 在执行配额扣减操作前调用. 不足配额抛出可读 Error.
 */
export async function checkAndConsume(kind: QuotaKind, count = 1): Promise<{ remaining: number }> {
  const snap = await fetchMyQuotas();
  const slot = kind === "prompt_converter" ? snap.prompt_converter : snap.image_generation;
  if (slot.remaining < count) {
    throw new Error(`今日 ${kind === "prompt_converter" ? "提示词速转" : "图片生成"} 配额不足 (${slot.used}/${slot.limit})`);
  }
  const r = await consumeQuota(kind, count);
  return { remaining: r.remaining };
}
