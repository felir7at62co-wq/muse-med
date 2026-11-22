'use client';
/**
 * 模型选择器 —— 草稿页/精修/改编/裂变/批量上传/新建草稿共用。
 *
 * 交互是两级菜单(见 ModelMenu): 先看到 Gemini / DeepSeek / GPT / Grok 四个厂商,
 * 移到某个厂商上, 它的型号才在右侧列出。用户 2026-09-09 要求按这个逻辑做 ——
 * 一次性铺开 14 个 Gemini 型号会把另外三家挤到屏幕外。
 *
 * ## "稳"标不是前端算的
 * stable 由后端逐 (模型 × 线路) 实测后现算(见 orchestrator models/health.py)。
 * 前端**不得**根据型号名猜测稳定性: 资源随时在变, 猜出来的标就是在骗用户。
 *
 * ## 线路不可见
 * 只显示"几条线路可用", 不显示是哪几家 —— 产品要求。
 *
 * ## onChange 的第二个参数: 这次变更是谁发起的
 * `'user'` = 用户在菜单里真的点了某个型号; `'align'` = 清单到手后的自动对齐
 * (见下面 alignOnLoad)。要"记住用户选了什么"的调用方**必须**只在 `'user'` 时回写 ——
 * 否则一挂载就会把当时的平台默认写成这个人的个人偏好, 从此他再也跟不上平台默认的
 * 升级(管理员把默认换成新模型, 这个人还被钉在旧的上, 且自己完全不知道)。
 * 只关心值的旧调用方可以继续写 `onChange={setModel}`, 多出来的参数会被忽略。
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { ModelMenu } from './ModelMenu';
import {
  loadModelCatalog,
  modelBadge,
  resolveModelValue,
  type ModelCatalog,
  type ModelItem,
} from '../lib/modelCatalog';

export function ModelSelect({
  value,
  onChange,
  disabled,
  className,
  label = '模型',
  showHint = true,
  compact = false,
  alignOnLoad = true,
  direction = 'auto',
  variant = 'boxed',
}: {
  value: string;
  onChange: (v: string, source: 'user' | 'align') => void;
  disabled?: boolean;
  className?: string;
  /** 传 null 隐藏左侧文字标签(调用方自己画了标签时用) */
  label?: string | null;
  /** 是否显示选中项下方的说明行 */
  showHint?: boolean;
  /** 紧凑模式: 字号更小, 用于 Modal 内的一行多控件布局 */
  compact?: boolean;
  /**
   * 清单到手后是否自动把老值升级成带型号的默认值。
   *
   * ⚠ onChange 有副作用时必须传 false。草稿页顶部那个选择器的 onChange 是
   * "弹确认框 + PATCH 草稿", 自动对齐会变成**一进页面就弹框问你要不要切模型**。
   * 传 false 时值原样显示(纯厂商老值会显示成"Gemini · 默认型号"), 只有用户
   * 真的选了才提交。
   */
  alignOnLoad?: boolean;
  /** 菜单展开方向, 见 ModelMenu */
  direction?: 'auto' | 'down' | 'up';
  /**
   * 外观。`boxed`(默认) = 带底色与边框的按钮, 老调用方全是这个。
   * `bare` = 只有文字 + 箭头, 无边框无底色 —— 给"无界"场景用
   * (新工作台把它放进对话输入框内, 那里再多一个框就是框里套框)。
   *
   * ⚠ 不要靠调用方传 `className="border-0 bg-transparent"` 来实现:
   * 那是和基础类打 CSS 顺序仗, Tailwind 里 `border` 与 `border-0` 谁赢取决于
   * 生成顺序而不是书写顺序, 换个版本就可能反过来。做成显式 variant 才稳。
   */
  variant?: 'boxed' | 'bare';
}) {
  const [cat, setCat] = React.useState<ModelCatalog | null>(null);
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement | null>(null);

  /**
   * 对齐时要用**清单到手那一刻**的值，不是挂载那一刻的。
   *
   * ⚠️ 2026-09-21 实测的 bug：调用方如果在 effect 里异步恢复上次选的模型
   * （读 localStorage / 拉接口），挂载时 value 还是初始值。下面那个 effect 的
   * 依赖是 `[]`，闭包里捕获的就是那个初始值，于是清单回来后
   * `resolveModelValue(初始值)` 把用户刚恢复的选择**又覆盖回平台默认** ——
   * 表现是"选了模型、刷新后又变回去了"。用 ref 读最新值即可。
   */
  const valueRef = React.useRef(value);
  React.useEffect(() => { valueRef.current = value; }, [value]);

  React.useEffect(() => {
    let alive = true;
    loadModelCatalog().then((c) => {
      if (!alive) return;
      setCat(c);
      if (!alignOnLoad) return;
      // 清单到手后把当前值对齐到清单: 老值("gpt5")升级成带型号的默认值,
      // 已下架的型号退回默认, 避免显示空白或提交一个死型号
      const cur = valueRef.current;
      const fixed = resolveModelValue(cur, c);
      if (fixed !== cur) onChange(fixed, 'align');
    });
    return () => {
      alive = false;
    };
    // 只在挂载时拉一次: value 变化不需要重新对齐(用户主动选的一定在清单里)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current: ModelItem | undefined = React.useMemo(() => {
    if (!cat) return undefined;
    return cat.groups.flatMap((g) => g.models).find((m) => m.value === value);
  }, [cat, value]);

  /** 按钮上显示什么。值不在清单里也要说人话, 不能显示成空白 */
  const triggerText = React.useMemo(() => {
    if (!cat) return '加载中…';
    if (current) return current.label;
    if (!value) return '选择模型';
    // "gemini" 这类纯厂商老值是合法的(= 用该厂商默认型号), 不是错误
    if (!value.includes(':')) {
      const g = cat.groups.find((x) => x.provider === value);
      return g ? `${g.label} · 默认型号` : value;
    }
    return `${value.split(':')[1]}（已下架）`;
  }, [cat, current, value]);

  const badge = current ? modelBadge(current) : '';

  const btnCls = [
    'inline-flex items-center gap-1.5 rounded',
    variant === 'bare'
      ? 'px-1 py-0.5 text-ink-muted hover:text-ink-primary'
      : 'bg-surface-overlay border border-line px-2 py-1 text-ink-primary hover:bg-surface-raised',
    'transition disabled:opacity-50 disabled:cursor-not-allowed',
    compact ? 'text-xs' : 'text-sm',
    // 默认限宽, 免得型号名把一行控件撑变形; 调用方给了 className 就完全听它的
    className || 'max-w-[16rem]',
  ].join(' ');

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        {label !== null && <label className="text-caption text-ink-muted">{label}</label>}
        <button
          ref={btnRef}
          type="button"
          disabled={disabled || !cat}
          onClick={() => setOpen((v) => !v)}
          title={current?.reason || ''}
          aria-haspopup="menu"
          aria-expanded={open}
          className={btnCls}
        >
          <span className="truncate flex-1 text-left">{triggerText}</span>
          {badge && (
            <span
              className={`shrink-0 px-1 rounded text-[10px] ${
                current?.stable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-surface-base text-ink-muted'
              }`}
            >
              {badge}
            </span>
          )}
          <ChevronDown className="w-3 h-3 text-ink-muted shrink-0" />
        </button>
      </div>
      {cat && (
        <ModelMenu
          open={open}
          anchorEl={btnRef.current}
          groups={cat.groups}
          value={value}
          onPick={(v) => onChange(v, 'user')}
          onClose={() => setOpen(false)}
          direction={direction}
        />
      )}
      {showHint && current && (
        <span className={`text-caption text-ink-muted ${label !== null ? 'pl-[2.4rem]' : ''}`}>
          {current.stable ? '✅ 稳定：' : ''}
          {current.reason}
          {current.note ? ` · ${current.note}` : ''}
        </span>
      )}
    </div>
  );
}
