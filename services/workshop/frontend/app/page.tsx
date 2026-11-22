'use client';
/**
 * 根路径 —— 分发到当前版本的主页。
 *
 * ## 默认值：新版
 * 用户需求（2026-09-20）：**"把新版的主页设为用户登录后的主页"**。
 * 所以没设置过、以及**所有既有用户**，访问根路径都进新版主页 `/v2`。
 *
 * ## 为什么仍然读 localStorage 而不是无条件 `/v2`
 * 新版/旧版并存是既定设计（PLAN §4.4），用户**主动切到旧版**要能生效 ——
 * 否则切换按钮形同虚设。区别在于：这里的读值只决定"根路径去哪"，
 * 不再让一个历史遗留的 `v1` 劫持**登录落点**（登录走 `homePathAfterLogin()`，
 * 那条路径固定给新版主页）。
 *
 * ## 为什么不在服务端 redirect
 * 版本存在 localStorage 里，服务端读不到。无条件 `redirect("/v2")` 会让
 * 主动切回旧版的用户每次访问根路径都被弹回新版。
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { DEFAULT_VERSION, getUiVersion } from '@/components/VersionSwitcher';

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const v = getUiVersion();
    // ⚠️ 旧版主页是 `/drafts`，不是 `/` —— 写 `/` 会无限自我重定向。
    router.replace(v === 'v1' ? '/drafts' : '/v2');
  }, [router]);

  // 首次访问时读取 localStorage 需要一帧，这里给一个极简的过渡态，
  // 避免白屏闪一下（比转圈更轻，因为通常只持续几十毫秒）。
  return (
    <div className="min-h-screen bg-surface-base" aria-busy="true" data-version={DEFAULT_VERSION} />
  );
}
