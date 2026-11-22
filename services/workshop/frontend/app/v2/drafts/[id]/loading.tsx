/**
 * 工作台路由段加载中的骨架（PLAN §3.2-a）。
 *
 * 填的是实测那段 **约 600 ms 的静默窗口** —— 改这版之前，点下卡片之后
 * App Router 会一直显示**旧页面**，直到新路由就绪再整屏硬替换。
 *
 * 与页面内的 `if (loading)` 共用同一个 `WorkbenchSkeleton`，
 * 否则会变成"骨架 → 转圈 → 内容"的三段跳。
 */
import { WorkbenchSkeleton } from '@/components/workbench/WorkbenchSkeleton';

export default function Loading() {
  return <WorkbenchSkeleton />;
}
