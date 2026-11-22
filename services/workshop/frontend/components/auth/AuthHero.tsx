'use client';
import * as React from 'react';
import { Sparkles, Wand2, Layers, Rocket } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * AuthHero — 登录/注册双栏品牌区 (PLAN §17/§18 / 17 号设计图)
 *
 * 视觉:
 *  - 紫→青蓝双色渐变 + 径向光斑 + 噪点纹理 (CSS-only, 无需位图)
 *  - 大标题"剧本工坊" + slogan
 *  - 4 个卖点 icon 卡 (横向 / 桌面端 2x2)
 *
 * 用法:
 *   <div class="grid lg:grid-cols-2">
 *     <AuthHero/>
 *     <form>...</form>
 *   </div>
 */

type FeatureItem = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  desc: string;
};

const FEATURES: FeatureItem[] = [
  {
    icon: Sparkles,
    title: 'AI 大纲生成',
    desc: '一句话生成完整长剧大纲,可锁定可编辑',
  },
  {
    icon: Wand2,
    title: '章节滚动续写',
    desc: 'AI 按集滚动生成,支持反馈重写、版本回滚',
  },
  {
    icon: Layers,
    title: '剧本/分镜/视频提示词',
    desc: '从大纲到视频提示词的一站式创作链路',
  },
  {
    icon: Rocket,
    title: '一键混合导出',
    desc: '已锁定章节用原文,其他用 AI 剧本,Word 一键导出',
  },
];

export function AuthHero({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'relative hidden lg:flex flex-col justify-center px-12 py-16 overflow-hidden',
        'bg-gradient-to-br from-primary/30 via-primary/10 to-cyan/20',
        className,
      )}
    >
      {/* 径向光斑 1 */}
      <div
        aria-hidden
        className="absolute top-[-10%] left-[-10%] w-[60%] h-[60%] rounded-full pointer-events-none opacity-40"
        style={{
          background: 'radial-gradient(circle, rgba(124,58,237,0.55) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }}
      />
      {/* 径向光斑 2 */}
      <div
        aria-hidden
        className="absolute bottom-[-15%] right-[-10%] w-[55%] h-[55%] rounded-full pointer-events-none opacity-35"
        style={{
          background: 'radial-gradient(circle, rgba(34,211,238,0.50) 0%, transparent 70%)',
          filter: 'blur(60px)',
        }}
      />

      {/* 噪点纹理 (SVG inline data uri) */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay pointer-events-none"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.6'/></svg>\")",
          backgroundSize: '200px 200px',
        }}
      />

      {/* 内容层 */}
      <div className="relative z-10 max-w-md">
        {/* Logo 行 */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary to-cyan flex items-center justify-center shadow-xl shadow-primary/30">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <span className="text-2xl font-bold text-white">剧本工坊</span>
        </div>

        {/* 大标题 */}
        <h1 className="text-4xl xl:text-5xl font-bold leading-tight bg-gradient-to-br from-white via-white to-cyan bg-clip-text text-transparent mb-4">
          一句话,
          <br />
          生成一部长剧本
        </h1>

        {/* slogan */}
        <p className="text-lg text-ink-secondary leading-relaxed mb-10">
          从灵感到完整剧本只需几分钟。AI 帮你写大纲、章节、分镜与视频提示词,
          支持反馈重写、版本回滚、一键导出。
        </p>

        {/* 4 卖点卡 */}
        <div className="grid grid-cols-2 gap-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <div
                key={f.title}
                className="p-3 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm"
              >
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/40 to-cyan/40 flex items-center justify-center mb-2">
                  <Icon className="w-4 h-4 text-white" />
                </div>
                <div className="text-sm font-semibold text-white mb-0.5">
                  {f.title}
                </div>
                <div className="text-xs text-ink-secondary leading-snug">
                  {f.desc}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
