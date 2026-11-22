"use client";

import { useEffect, useState } from "react";
import { fetchMyQuotas, type QuotaSnapshot, type QuotaKind } from "@/lib/quotas";
import { Badge } from "./ui";

export interface QuotaBadgeProps {
  /** 显示哪个配额 (默认 prompt_converter) */
  kind?: QuotaKind;
  /** 是否同时显示 image_generation */
  showImage?: boolean;
  /** 自定义标题 */
  label?: string;
  className?: string;
  /** 外部触发刷新（递增此值会重新拉取） */
  refreshKey?: number;
}

/**
 * 顶部工具条配额展示徽章。
 *
 * 显示当前用户今日配额: used/limit, 余额低 (<20%) 时变 warning, 用完变 danger.
 * 接收 `refreshKey` 让父组件在消费配额后强制刷新。
 */
export function QuotaBadge({
  kind = "prompt_converter",
  showImage = false,
  label,
  className = "",
  refreshKey = 0,
}: QuotaBadgeProps) {
  const [snap, setSnap] = useState<QuotaSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchMyQuotas()
      .then((s) => alive && setSnap(s))
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (err) {
    return (
      <Badge tone="danger" className={className}>
        配额读取失败
      </Badge>
    );
  }
  if (!snap) {
    return (
      <Badge tone="muted" className={className}>
        加载配额…
      </Badge>
    );
  }

  const main = kind === "prompt_converter" ? snap.prompt_converter : snap.image_generation;
  const ratio = main.limit > 0 ? main.used / main.limit : 0;
  const tone: "danger" | "warning" | "info" = main.remaining <= 0 ? "danger" : ratio >= 0.8 ? "warning" : "info";
  const text = `${label || (kind === "prompt_converter" ? "速转" : "图片")} ${main.used}/${main.limit}`;

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Badge tone={tone}>{text}</Badge>
      {showImage && (
        <Badge tone={snap.image_generation.remaining <= 0 ? "danger" : "info"}>
          图片 {snap.image_generation.used}/{snap.image_generation.limit}
        </Badge>
      )}
    </span>
  );
}
