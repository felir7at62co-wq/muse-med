/**
 * Design Tokens
 *
 * 来源: docs/PLAN_UI_REVAMP.md §3.2 + §37.2 (基于 25 张 UI 设计稿读图后的修订)
 *
 * 这里是 SSOT (单一事实源). tailwind.config.ts 通过 import 这个文件来同步,
 * 业务代码也可以直接 import { tokens } 来取色 (但优先用 tailwind class).
 *
 * 主色双主调:
 *   primary: #7C3AED (紫) - 主操作 / 选中态 / generating 状态
 *   cyan:    #22D3EE (青蓝) - 辅助强调 / Tag chip / 次级动作
 */

export const tokens = {
  /*
   * 颜色全部改为引用 CSS 变量 (channel 形式 "R G B"), 由 app/globals.css 的
   * light/dark 基线 + lib/theme.ts 的 applyTheme(注入主色) 在运行时决定真实取值。
   * 这样 Tailwind 的 `bg-primary/10` 等 opacity 修饰符仍可用 (<alpha-value> 占位),
   * 同时支持"明暗 × 多主色"运行时切换。详见 docs/PLAN-script-view-theme-import.md 需求2。
   */
  color: {
    /* ───── 主色 (由 applyTheme 按所选主题注入) ───── */
    primary: 'rgb(var(--c-primary) / <alpha-value>)',
    primaryHover: 'rgb(var(--c-primary-hover) / <alpha-value>)',
    primarySubtle: 'rgb(var(--c-primary) / 0.16)',
    cyan: 'rgb(var(--c-accent) / <alpha-value>)',
    cyanHover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
    cyanSubtle: 'rgb(var(--c-accent) / 0.16)',

    /* ───── 业务状态色 (明暗各自基线) ───── */
    success: 'rgb(var(--c-success) / <alpha-value>)',
    successSubtle: 'rgb(var(--c-success) / 0.16)',
    warning: 'rgb(var(--c-warning) / <alpha-value>)',
    warningSubtle: 'rgb(var(--c-warning) / 0.16)',
    danger: 'rgb(var(--c-danger) / <alpha-value>)',
    dangerSubtle: 'rgb(var(--c-danger) / 0.16)',
    info: 'rgb(var(--c-info) / <alpha-value>)',
    infoSubtle: 'rgb(var(--c-info) / 0.16)',

    /* ───── 文本 (明暗各自基线, 保证对比度) ───── */
    textPrimary: 'rgb(var(--c-text-primary) / <alpha-value>)',
    textSecondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
    textMuted: 'rgb(var(--c-text-muted) / <alpha-value>)',
    textDisabled: 'rgb(var(--c-text-disabled) / <alpha-value>)',

    /* ───── 背景 / 表面 (明暗各自基线) ───── */
    bg: 'rgb(var(--c-bg) / <alpha-value>)',
    bgRaised: 'rgb(var(--c-bg-raised) / <alpha-value>)',
    bgElevated: 'rgb(var(--c-bg-elevated) / <alpha-value>)',
    bgCard: 'rgb(var(--c-bg-card) / <alpha-value>)',
    bgCardHover: 'rgb(var(--c-bg-card-hover) / <alpha-value>)',
    bgInput: 'rgb(var(--c-bg-input) / <alpha-value>)',
    bgOverlay: 'rgb(var(--c-bg-overlay) / <alpha-value>)',

    /* ───── 边框 (带固定透明度, 走完整值变量) ───── */
    border: 'var(--c-line)',
    borderHover: 'var(--c-line-hover)',
    borderStrong: 'var(--c-line-strong)',
    borderActive: 'rgb(var(--c-primary) / 0.72)',
    borderDanger: 'rgb(var(--c-danger) / 0.5)',
  },

  radius: {
    sm: '6px',
    md: '10px',
    lg: '14px',
    xl: '18px',
    '2xl': '24px',
    full: '9999px',
  },

  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.18)',
    md: '0 4px 12px rgba(0, 0, 0, 0.22)',
    card: '0 12px 32px rgba(0, 0, 0, 0.24)',
    glow: '0 0 24px rgba(124, 58, 237, 0.28)',
    glowCyan: '0 0 24px rgba(34, 211, 238, 0.28)',
    overlay: '0 24px 64px rgba(0, 0, 0, 0.42)',
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '48px',
  },

  /** 字体层级（PLAN §3.3） */
  typography: {
    display:      { size: '30px', weight: 700, lineHeight: '36px' },
    pageTitle:    { size: '24px', weight: 700, lineHeight: '32px' },
    sectionTitle: { size: '18px', weight: 600, lineHeight: '26px' },
    cardTitle:    { size: '16px', weight: 600, lineHeight: '24px' },
    body:         { size: '14px', weight: 400, lineHeight: '22px' },
    caption:      { size: '12px', weight: 400, lineHeight: '18px' },
    micro:        { size: '11px', weight: 500, lineHeight: '16px' },
  },

  /** 关键尺寸（PLAN §4.1 + 25 张读图后修订为 240px） */
  layout: {
    sidebarWidth: 240,
    sidebarCollapsedWidth: 64,
    topbarHeight: 64,
    bottomTabHeight: 64,
    contentMaxWidth: 1440,
    minTouchTarget: 44,
  },

  /** 4 档断点（PLAN §29.1） */
  breakpoints: {
    mobile: 0,
    tablet: 768,
    desktop: 1024,
    wide: 1440,
  },

  /** 业务状态 → 色系映射（业务用） */
  statusColor: {
    /* DraftStatus */
    not_started: 'muted',
    ideating: 'warning',
    generating: 'primary',
    completed: 'success',
    failed: 'danger',
    archived: 'muted',
    /* BatchJobStatus */
    queued: 'info',
    running: 'primary',
    success: 'success',
    error: 'danger',
    canceled: 'muted',
    /* RiskLevel */
    critical: 'danger',
    high: 'danger',
    medium: 'warning',
    low: 'success',
    info_level: 'info',
  } as const,
} as const;

export type Tokens = typeof tokens;
export type TokenColor = keyof typeof tokens.color;
