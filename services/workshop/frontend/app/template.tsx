'use client';
/**
 * 路由切换的入场动画（PLAN-页面切换动画 §2）。
 *
 * ## 为什么是 template 而不是 layout
 * App Router 里 `layout.tsx` 在子路由之间**保持挂载**，`template.tsx` 则是
 * **每次导航都重新挂载** —— 所以把入场动画放这儿，全站 36 个路由一次性生效，
 * 不用去碰任何一个页面。
 *
 * ## 为什么只淡入、不做位移
 * 这个平台的主界面是**宽屏三栏**，整屏横向滑动会让人误以为内容要翻页；
 * 而且它要和骨架屏叠加（见各段的 loading.tsx），位移会显得晃。
 * 160 ms 取自"看得见但不用等"的区间：低于 100 ms 几乎无感，高于 300 ms 开始拖沓。
 *
 * ## 减弱动效
 * `prefers-reduced-motion` 的关闭规则写在 globals.css（那里才管得到所有动画类）。
 *
 * ⚠️ 必须是客户端组件：服务端渲染出来的纯 HTML 不会重新触发 CSS 动画。
 */
import { type ReactNode } from 'react';

export default function Template({ children }: { children: ReactNode }) {
  return <div className="animate-fade-in">{children}</div>;
}
