import type { Metadata } from "next";
import "./globals.css";
import { AuthExpiryGuard } from "./_AuthExpiryGuard";
import { KitProviders } from "@/components/_KitProviders";

export const metadata: Metadata = {
  title: "长剧目脚本生成系统",
  description: "AI 驱动的长剧本创作工作台",
  openGraph: {
    title: "长剧目脚本生成系统",
    description: "AI 驱动的长剧本创作工作台",
    images: ["/brand/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    images: ["/brand/og-image.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <head><script src="/jubengongfang/v1/auth/muse/storage.js"></script></head>
      <body className="min-h-screen bg-surface-base text-ink-primary antialiased dark:bg-surface-base dark:text-ink-primary">
        {/* Kit v2 全局 Provider (Toast / Confirm) — 不影响旧页面渲染 */}
        <KitProviders>
          {/* 全局登录态守卫: 刷新/路由切换时检测 token 过期, 自动跳登录 */}
          <AuthExpiryGuard />
          {children}
          {/* 旧的右下角"Agent 助手"和"问题反馈"悬浮按钮已移除;
              问题反馈入口改到右上角用户头像下拉菜单(见 _UserNav)。 */}
        </KitProviders>
      </body>
    </html>
  );
}
