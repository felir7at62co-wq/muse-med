import type { Config } from 'tailwindcss';
import { tokens } from './lib/tokens';

/**
 * Tailwind 配置 — 接入 design tokens (lib/tokens.ts)
 *
 * 设计原则:
 * - 自定义色全部用语义命名 (surface/primary/danger 等), 不覆盖原生颜色
 * - 4 档断点对齐 PLAN §29.1 (mobile/tablet/desktop/wide)
 * - 字体层级、圆角、阴影、间距全部从 tokens 派生, 保持单一事实源
 */
const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
  ],
  darkMode: 'class', // 深色为默认主题, 但保留切换能力
  theme: {
    /** 4 档断点 (覆盖默认) — PLAN §29.1 */
    screens: {
      tablet: `${tokens.breakpoints.tablet}px`,
      desktop: `${tokens.breakpoints.desktop}px`,
      wide: `${tokens.breakpoints.wide}px`,
    },
    extend: {
      colors: {
        /* ── 主色 ── */
        primary: {
          DEFAULT: tokens.color.primary,
          hover: tokens.color.primaryHover,
          subtle: tokens.color.primarySubtle,
        },
        cyan: {
          DEFAULT: tokens.color.cyan,
          hover: tokens.color.cyanHover,
          subtle: tokens.color.cyanSubtle,
        },

        /* ── 业务状态 ── */
        success: {
          DEFAULT: tokens.color.success,
          subtle: tokens.color.successSubtle,
        },
        warning: {
          DEFAULT: tokens.color.warning,
          subtle: tokens.color.warningSubtle,
        },
        danger: {
          DEFAULT: tokens.color.danger,
          subtle: tokens.color.dangerSubtle,
        },
        info: {
          DEFAULT: tokens.color.info,
          subtle: tokens.color.infoSubtle,
        },

        /* ── 表面（背景层级） ── */
        surface: {
          base: tokens.color.bg,
          raised: tokens.color.bgRaised,
          elevated: tokens.color.bgElevated,
          card: tokens.color.bgCard,
          'card-hover': tokens.color.bgCardHover,
          input: tokens.color.bgInput,
          overlay: tokens.color.bgOverlay,
        },

        /* ── 文本（自定义 ink-* 命名空间, 避免覆盖 tailwind 默认 text-*） ── */
        ink: {
          primary: tokens.color.textPrimary,
          secondary: tokens.color.textSecondary,
          muted: tokens.color.textMuted,
          disabled: tokens.color.textDisabled,
        },

        /* ── 边框（自定义 line-* 避免冲突 border-DEFAULT） ── */
        line: {
          DEFAULT: tokens.color.border,
          hover: tokens.color.borderHover,
          strong: tokens.color.borderStrong,
          active: tokens.color.borderActive,
          danger: tokens.color.borderDanger,
        },
      },

      borderRadius: {
        sm: tokens.radius.sm,
        md: tokens.radius.md,
        lg: tokens.radius.lg,
        xl: tokens.radius.xl,
        '2xl': tokens.radius['2xl'],
      },

      boxShadow: {
        card: tokens.shadow.card,
        glow: tokens.shadow.glow,
        'glow-cyan': tokens.shadow.glowCyan,
        overlay: tokens.shadow.overlay,
      },

      spacing: {
        // 在原生间距基础上保留语义 token, 用于布局相关固定值
        sidebar: `${tokens.layout.sidebarWidth}px`,
        'sidebar-collapsed': `${tokens.layout.sidebarCollapsedWidth}px`,
        topbar: `${tokens.layout.topbarHeight}px`,
        'bottom-tab': `${tokens.layout.bottomTabHeight}px`,
        touch: `${tokens.layout.minTouchTarget}px`,
      },

      maxWidth: {
        content: `${tokens.layout.contentMaxWidth}px`,
      },

      fontSize: {
        display: [
          tokens.typography.display.size,
          {
            lineHeight: tokens.typography.display.lineHeight,
            fontWeight: tokens.typography.display.weight,
          },
        ],
        'page-title': [
          tokens.typography.pageTitle.size,
          {
            lineHeight: tokens.typography.pageTitle.lineHeight,
            fontWeight: tokens.typography.pageTitle.weight,
          },
        ],
        'section-title': [
          tokens.typography.sectionTitle.size,
          {
            lineHeight: tokens.typography.sectionTitle.lineHeight,
            fontWeight: tokens.typography.sectionTitle.weight,
          },
        ],
        'card-title': [
          tokens.typography.cardTitle.size,
          {
            lineHeight: tokens.typography.cardTitle.lineHeight,
            fontWeight: tokens.typography.cardTitle.weight,
          },
        ],
        body: [
          tokens.typography.body.size,
          { lineHeight: tokens.typography.body.lineHeight },
        ],
        caption: [
          tokens.typography.caption.size,
          { lineHeight: tokens.typography.caption.lineHeight },
        ],
        micro: [
          tokens.typography.micro.size,
          {
            lineHeight: tokens.typography.micro.lineHeight,
            fontWeight: tokens.typography.micro.weight,
          },
        ],
      },

      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        breathe: {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
        'slide-down': 'slide-down 200ms ease-out',
        'slide-in-right': 'slide-in-right 200ms ease-out',
        breathe: 'breathe 1.6s ease-in-out infinite',
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
