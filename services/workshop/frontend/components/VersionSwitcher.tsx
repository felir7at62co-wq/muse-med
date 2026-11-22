"use client";
/**
 * 版本切换器 —— 新版 / 旧版。
 *
 * ## 为什么放在头像左边而不是下拉菜单里
 * 用户明确要求（2026-09-19）："在主页的右上角角色头像旁边加一个新旧版的切换按钮"。
 * 放在下拉里就变成"要先点开菜单才知道有这个功能"，而它需要**一眼可见**——
 * 用户要能随时在新旧版之间来回对照。
 *
 * ## 两套页面怎么并存（不改旧页面代码）
 * 新版页面全部写在 `/v2/` 下，旧页面保持原路径**一行不动**。
 * 切换 = 跳转时决定去 `/v2/xxx` 还是 `/xxx`，由 `useV2Href()` 统一给出目标。
 *
 * ## 新用户默认进新版
 * 没设置过的用户视为新版（`DEFAULT_VERSION = "v2"`）。
 * 只有用户**主动切到旧版**才会存下 "v1" 并保持。这样新功能是默认体验，
 * 又不影响任何已经习惯了旧版的人。
 */
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/cn";

const STORAGE_KEY = "drama_ui_version";

/** 默认版本：新用户与未设置过的用户都进新版 */
export const DEFAULT_VERSION = "v2";

export type UiVersion = "v1" | "v2";

export function getUiVersion(): UiVersion {
  if (typeof window === "undefined") return DEFAULT_VERSION;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "v1" ? "v1" : DEFAULT_VERSION;
  } catch {
    /* 隐私模式读不到就按默认（新版），不影响功能 */
    return DEFAULT_VERSION;
  }
}

export function setUiVersion(v: UiVersion): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* 存不进去只是不持久化，本次切换仍然生效 */
  }
}

/**
 * 把一个逻辑路径转成当前版本下的真实路径。
 *
 *   toVersionedHref("/drafts", "v2")     → "/v2/drafts"
 *   toVersionedHref("/drafts", "v1")     → "/drafts"
 *   toVersionedHref("/v2/drafts", "v1")  → "/drafts"   ← 幂等：已经是 v2 前缀会先剥掉
 *
 * ## ⚠️ 两个「主页」的对应关系（2026-09-20 修）
 * 两个版本各有自己的**主页**，且它们不是同一逻辑路径：
 *     新版主页 `/v2`      ↔  旧版主页 `/drafts`
 *     （新版把"列表"独立成 `/v2/drafts`，旧版首页本身就兼作列表）
 *
 * 此前这里只是机械地剥/加 `/v2` 前缀，于是：
 *   · 在 `/v2` 切到旧版 → 剥成 `/` → 根路径再按版本分发 → **又回到新版**
 *     （用户看到的是"点了切换没反应"）
 *   · 在 `/drafts` 切到新版 → 拼成 `/v2/drafts` → **落到列表页而不是主页**
 *
 * 所以主页这一对必须**显式映射**，不能靠前缀推导。
 */
export function toVersionedHref(logicalPath: string, v: UiVersion): string {
  const bare =
    logicalPath.startsWith("/v2/") ? logicalPath.slice(3)
      : logicalPath === "/v2" ? "/"      // 新版主页 → 逻辑根
        : logicalPath;

  if (v === "v2") {
    // 旧版主页（逻辑根）→ 新版主页；其余页面加 /v2 前缀
    return bare === "/" ? "/v2" : `/v2${bare}`;
  }
  // 切回旧版：新版主页 → 旧版主页（`/drafts`），其余剥掉 /v2 前缀
  if (bare === "/") return "/drafts";
  return bare;
}

/**
 * 版本切换按钮。
 *
 * 视觉上是一个紧凑的分段控件（两格：新版 / 旧版）。
 * 刻意做得很小、很克制 —— 它是工具不是内容，不该抢视觉（与纸感基调一致）。
 */
export function VersionSwitcher({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname() || "";
  const [version, setVersion] = React.useState<UiVersion>(DEFAULT_VERSION);

  // 首帧用默认值渲染（服务端没有 localStorage），挂载后再对齐真实值，
  // 否则 SSR/CSR 不一致会导致 hydration mismatch。
  React.useEffect(() => {
    setVersion(getUiVersion());
  }, []);

  // 当前路径前缀就是事实来源：用户可能是直接贴 URL 进来的，
  // 这时版本应以路径为准，而不是以本地存值为准（并顺手纠正存值）。
  const onV2 = pathname === "/v2" || pathname.startsWith("/v2/");
  const effective: UiVersion = onV2 ? "v2" : "v1";

  React.useEffect(() => {
    if (effective !== version) {
      setVersion(effective);
      setUiVersion(effective);
    }
  }, [effective, version]);

  function switchTo(v: UiVersion) {
    if (v === effective) return;
    setUiVersion(v);
    setVersion(v);
    // 跳到同一逻辑页面在目标版本下的路径 —— 用户在新旧版之间对照时停在原地，
    // 而不是被丢回首页。toVersionedHref 会先剥掉 /v2 前缀，所以可来回切。
    router.push(toVersionedHref(pathname || "/drafts", v));
  }

  return (
    <div
      className={cn(
        "flex items-center rounded-full border border-line-strong bg-surface-raised p-0.5",
        className,
      )}
      role="group"
      aria-label="界面版本切换"
    >
      {(
        [
          ["v2", "新版"],
          ["v1", "旧版"],
        ] as [UiVersion, string][]
      ).map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => switchTo(v)}
          aria-pressed={effective === v}
          title={v === "v2" ? "新版界面（默认）" : "旧版界面"}
          className={cn(
            "px-2.5 py-0.5 text-[11px] rounded-full transition-colors whitespace-nowrap",
            effective === v
              ? "bg-primary text-white font-medium"
              : "text-ink-muted hover:text-ink-primary",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** 在组件里取"当前版本下某个逻辑路径"的便捷 hook。 */
export function useV2Href(logicalPath: string): string {
  const [v, setV] = React.useState<UiVersion>(DEFAULT_VERSION);
  React.useEffect(() => setV(getUiVersion()), []);
  return toVersionedHref(logicalPath, v);
}

/**
 * 跳转到某部草稿，并**留在用户当前所在的版本里**。
 *
 * ## 为什么需要这个而不是直接写 `/drafts/${id}`
 * 新版（`/v2/`）与旧版共用同一批弹窗组件（`_ImportScriptModal` / `_VideoUploadModal`）
 * 和卡片组件（`DraftCard`）。它们内部一律写死了 `/drafts/${id}`，于是在新版页面里
 * 创建/导入/点卡片之后，用户会被**悄悄丢回旧版工作台** —— 切换按钮白点了，
 * 而新版恰恰是默认视图，所以这是大多数用户会遇到的路径。
 *
 * ## 判据用 pathname 而不是 localStorage
 * 两个在特殊情况下会分叉，取舍如下：
 *   - pathname 能处理"用户直接贴 URL 进来"，与 VersionSwitcher 里的
 *     `effective = onV2 ? 'v2' : 'v1'` 保持一致口径（**同一份判据，不要各判各的**）；
 *   - 在 `/drafts`（旧版列表）里点导入 → 仍进 `/drafts/{id}`，与改动前完全一致，
 *     老用户零感知；
 *   - 新版列表点导入 → 进 `/v2/drafts/{id}`。
 *
 * ⚠️ 只能在**事件回调**里调用（它读 localStorage）。放在 render 里会 hydration mismatch。
 */
export function draftPath(id: number | string): string {
  const onV2 =
    typeof window !== "undefined" &&
    (window.location.pathname === "/v2" || window.location.pathname.startsWith("/v2/"));
  return onV2 ? `/v2/drafts/${id}` : `/drafts/${id}`;
}

/**
 * 登录成功后的落点 —— **当前版本的主页**。
 *
 * ## 为什么需要它，而不是各处写 `/drafts`
 * 飞书扫码是主登录路径，而它此前在 5 处都写死了 `router.replace("/drafts")`。
 * `/drafts` 是**旧版主页**，所以无论用户选的是哪一版，
 * 扫码登录后一律落到旧主页 —— 用户报的"新版主页没生效"就是这么来的。
 * 密码登录与注册这两处是对的（走了版本判断），只有飞书这条链路漏了。
 *
 * ## 为什么要"强制新版为默认"
 * 需求是"**新版的主页设为用户登录后的主页**"。所以这里不读用户的旧偏好，
 * 直接给新版主页 —— 只把「版本选择」当**当前会话内的对照工具**，
 * 不让一个历史遗留的 `drama_ui_version=v1` 永久劫持登录落点
 * （那正是"我明明切过新版、登出再登入又回旧版"的成因）。
 *
 * 用户仍可随时用右上角切换器去旧版；本函数只管**登录那一刻**去哪。
 */
export function homePathAfterLogin(): string {
  return "/v2";
}
