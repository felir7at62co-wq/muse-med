'use client';
/**
 * 两级模型菜单 —— 左列四个厂商, 悬停某个厂商时它的型号列表在右侧展开。
 *
 * ## 为什么不是"一次性把所有型号铺开"
 * Gemini 一家就有 14 个型号, 平铺出来是一屏滚不完的清单, 用户要先滚动才能
 * 看到 DeepSeek/GPT/Grok 在哪 —— 分组标题在长列表里根本起不到导航作用。
 * 改成常见的二级菜单(ChatGPT/豆包那种): 第一屏永远只有四个厂商, 想看谁的型号
 * 就移到谁身上, 子列表在右侧出现。用户 2026-09-09 明确要求这个交互。
 *
 * ## 为什么用 portal + fixed 定位, 而不是 absolute
 * 这个菜单要在**弹窗内部**用(续写/裂变/改编都是 Modal), Modal 往往带
 * overflow-y-auto 和自己的层级; 用 absolute 会被裁掉或压在遮罩下面。
 * portal 到 body + position:fixed 一次性绕开裁剪与层级问题, 代价是要自己
 * 跟随滚动/缩放重算位置(下面的 reposition)。
 *
 * ## 触屏
 * 没有 hover。所以厂商行的 onClick 也切换展开项(而不是直接选中), 点型号才是选中。
 *
 * ⚠ "稳"标与"几条线路"全部来自后端实测, 前端只渲染。**不显示线路名** ——
 * 走哪几家中转是内部信息。
 */
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { modelBadge, type ModelGroup, type ModelItem } from '../lib/modelCatalog';

const LEFT_W = 168;   // 厂商列宽(px)
const RIGHT_W = 296;  // 型号列宽(px)
const GAP = 6;        // 菜单与触发元素的间距(px)
const COL_GAP = 4;    // 一级列与二级列之间的缝(px)
const ROW_H = 34;     // 厂商行高(px) —— 一级列高度 = 厂商数 × 行高, 见下方说明

export function ModelMenu({
  open,
  anchorEl,
  groups,
  value,
  onPick,
  onClose,
  direction = 'auto',
}: {
  open: boolean;
  /** 触发按钮, 用来算位置; 点它自身不算"点外面" */
  anchorEl: HTMLElement | null;
  groups: ModelGroup[];
  value: string;
  onPick: (v: string) => void;
  onClose: () => void;
  /** 菜单向下还是向上展开; auto = 下方放不下就往上 */
  direction?: 'auto' | 'down' | 'up';
}) {
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const [active, setActive] = React.useState<string>('');
  const [box, setBox] = React.useState<
    { left: number; top?: number; bottom?: number; up: boolean; maxH: number } | null
  >(null);

  // 打开时默认展开当前模型所属的厂商, 用户一眼看到自己在用哪个
  React.useEffect(() => {
    if (!open) return;
    const cur = (value || '').split(':')[0];
    setActive(groups.some((g) => g.provider === cur) ? cur : groups[0]?.provider || '');
  }, [open, value, groups]);

  const reposition = React.useCallback(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    // 宽度按"两列都在"算: 一级列的位置不能因为二级列开没开而左右挪
    const width = LEFT_W + COL_GAP + RIGHT_W;
    // 右侧放不下就贴着右边界, 保证子列表不会跑到屏幕外
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - r.bottom;
    const up = direction === 'up' || (direction === 'auto' && spaceBelow < 260 && r.top > spaceBelow);
    // 二级列能有多高, 取决于往哪个方向展开时还剩多少屏幕; 超了它自己滚
    const maxH = Math.max(140, (up ? r.top - GAP : spaceBelow - GAP) - 8);
    setBox(up
      ? { left, bottom: window.innerHeight - r.top + GAP, up, maxH }
      : { left, top: r.bottom + GAP, up, maxH });
  }, [anchorEl, direction]);

  React.useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // 捕获阶段监听: 弹窗内部容器滚动也要跟上, 否则菜单会"飘"在原地
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || anchorEl?.contains(t)) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      // 捕获阶段拦下并停止传播: 这个菜单常开在 Modal 里, 而 Modal 也监听 Esc。
      // 不拦的话按一下 Esc 会**连菜单带弹窗一起关**, 用户填了一半的表单就没了。
      e.stopPropagation();
      onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchorEl, onClose]);

  if (!open || !box || typeof document === 'undefined') return null;

  const activeGroup = groups.find((g) => g.provider === active);

  return createPortal(
    /* 外层只负责定位, 不带背景/边框: 一级列与二级列各自是一块独立浮层。
       ⚠ 二级列必须 absolute —— 之前两列是并排的 flex item, 外层高度就等于
       两者中较高的那个, 于是切到型号多的厂商(GPT 17 个)容器猛然变高、切到
       型号少的(Grok 6 个)又缩回去; 向上展开时底边固定, 一级列就跟着上下乱跳。
       现在外层高度只由一级列决定, 二级列再高也不参与布局。 */
    <div
      ref={menuRef}
      className="fixed z-[1000]"
      style={{ left: box.left, top: box.top, bottom: box.bottom, width: LEFT_W }}
    >
      {/* 一级: 厂商。高度 = 厂商数 × 行高, 不写死 4 行 —— 以后加了第五家
          自然长一行, 而不是多出来的那行被裁掉。 */}
      <div
        role="menu"
        className="bg-surface-overlay border border-line rounded-lg shadow-2xl overflow-hidden"
        style={{ width: LEFT_W, height: groups.length * ROW_H }}
      >
        {groups.map((g) => {
          const on = g.provider === active;
          const mine = (value || '').split(':')[0] === g.provider;
          const stableCount = g.models.filter((m) => m.stable).length;
          return (
            <button
              key={g.provider}
              type="button"
              role="menuitem"
              onMouseEnter={() => setActive(g.provider)}
              onClick={() => setActive(g.provider)}
              style={{ height: ROW_H }}
              className={`w-full text-left px-3 flex items-center gap-2 text-xs transition ${
                on ? 'bg-surface-raised' : 'hover:bg-surface-base'
              }`}
            >
              <span className={`flex-1 truncate ${mine ? 'text-primary font-medium' : 'text-ink-primary'}`}>
                {g.label}
              </span>
              {stableCount > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title={`${stableCount} 个型号实测稳定`} />
              )}
              <span className="text-ink-muted shrink-0">{g.models.length}</span>
              <ChevronRight className="w-3 h-3 text-ink-muted shrink-0" />
            </button>
          );
        })}
      </div>

      {/* 二级: 该厂商的型号。绝对定位挂在一级列右侧, 高度自便, 超了自己滚。
          向上展开时贴底对齐, 向下展开时贴顶对齐, 都从触发按钮那一侧长出去。 */}
      {activeGroup && (
        <div
          role="menu"
          className="absolute bg-surface-overlay border border-line rounded-lg shadow-2xl overflow-y-auto py-1"
          style={{
            left: LEFT_W + COL_GAP,
            width: RIGHT_W,
            maxHeight: box.maxH,
            ...(box.up ? { bottom: 0 } : { top: 0 }),
          }}
        >
          {activeGroup.models.length === 0 && (
            <div className="px-3 py-3 text-xs text-ink-muted">该厂商暂无可选型号</div>
          )}
          {activeGroup.models.map((m: ModelItem) => {
            const on = m.value === value;
            const badge = modelBadge(m);
            return (
              <button
                key={m.value}
                type="button"
                role="menuitem"
                onClick={() => { onPick(m.value); onClose(); }}
                title={m.reason + (m.note ? ` · ${m.note}` : '')}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 text-xs transition ${
                  on ? 'bg-primary/15' : 'hover:bg-surface-base'
                }`}
              >
                <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 text-primary ${on ? '' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-ink-primary truncate">{m.label}</span>
                  {m.note && <span className="block text-[10px] text-ink-muted truncate">{m.note}</span>}
                </span>
                {badge && (
                  <span
                    className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${
                      m.stable ? 'bg-emerald-500/15 text-emerald-400' : 'bg-surface-base text-ink-muted'
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
