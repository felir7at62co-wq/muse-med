"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import { Plus, X, Type } from "lucide-react";

// 免费可商用字体(与后端 FONT_REGISTRY 对齐)
export const FONTS = [
  { id: "sans", label: "思源黑体" },
  { id: "sans-bold", label: "思源黑体(粗)" },
  { id: "serif", label: "思源宋体" },
];

export type OverlayItem = {
  id: string;
  text: string;
  xPct: number;   // 左上角锚点(0~1)
  yPct: number;
  fontPct: number; // 字号占画面高
  vertical: boolean;
  font: string;
  color: string;
  stroke: string;
  align?: "left" | "center";  // center=左右居中(忽略 xPct 水平位置)
};

export type Subtitle = {
  fontPct: number;
  yPct: number;
  font: string;
  color: string;
  stroke: string;
};

export const DEFAULT_ITEMS: OverlayItem[] = [
  { id: "disc", text: "内容虚构 请勿带入现实", xPct: 0.04, yPct: 0.25, fontPct: 0.03, vertical: true, font: "sans", color: "#ffffff", stroke: "#000000" },
  { id: "corner", text: "全文{min}分钟一更到底", xPct: 0.5, yPct: 0.04, fontPct: 0.033, vertical: false, font: "sans", color: "#ffffff", stroke: "#000000" },
];

export const DEFAULT_SUBTITLE: Subtitle = {
  fontPct: 0.045, yPct: 0.88, font: "sans", color: "#ffffff", stroke: "#000000",
};

// 比例 → 预览框 CSS aspect-ratio
function aspect(w: number, h: number) {
  return `${w} / ${h}`;
}

type Props = {
  ratioW: number;
  ratioH: number;
  items: OverlayItem[];
  setItems: (u: OverlayItem[]) => void;
  subtitle: Subtitle;
  setSubtitle: (s: Subtitle) => void;
  dark: boolean;   // 当前主题是否深色(预览框用反色)
};

export default function OverlayEditor({ ratioW, ratioH, items, setItems, subtitle, setSubtitle, dark }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; ox: number; oy: number; of: number } | null>(null);

  // 预览框真实渲染高度(px)。字号必须按"预览框实测高度 × fontPct"计算, 才能与后端
  // "视频高度 h × fontPct" 严格同构 —— 之前用固定系数(260/460)估算高度, 与真实高度不符,
  // 导致"预览看着合适、成片却过大"。用 ResizeObserver 实时跟踪容器真实高度。
  const [boxH, setBoxH] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBoxH(el.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratioW, ratioH]);

  // 预览框反色: 深色主题→白底黑字辅助; 白色主题→深底
  const boxBg = dark ? "#f5f5f5" : "#1a1a1a";
  const boxHint = dark ? "#999" : "#bbb";

  const onDown = useCallback((e: React.PointerEvent, id: string, mode: "move" | "resize") => {
    e.stopPropagation();
    const it = items.find((x) => x.id === id);
    if (!it) return;
    setSelId(id);
    dragRef.current = { id, mode, sx: e.clientX, sy: e.clientY, ox: it.xPct, oy: it.yPct, of: it.fontPct };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [items]);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const rect = box.getBoundingClientRect();
    const dx = (e.clientX - d.sx) / rect.width;
    const dy = (e.clientY - d.sy) / rect.height;
    setItems(items.map((it) => {
      if (it.id !== d.id) return it;
      if (d.mode === "move") {
        return { ...it, xPct: Math.max(0, Math.min(0.98, d.ox + dx)), yPct: Math.max(0, Math.min(0.98, d.oy + dy)) };
      }
      // resize: 用纵向拖动改字号(占画面高)
      return { ...it, fontPct: Math.max(0.015, Math.min(0.15, d.of + dy)) };
    }));
  }, [items, setItems]);

  const onUp = useCallback(() => { dragRef.current = null; }, []);

  const addItem = () => {
    const id = `t${Date.now()}`;
    setItems([...items, { id, text: "新文字", xPct: 0.3, yPct: 0.45, fontPct: 0.035, vertical: false, font: "sans", color: "#ffffff", stroke: "#000000" }]);
    setSelId(id);
  };
  const removeItem = (id: string) => { setItems(items.filter((x) => x.id !== id)); if (selId === id) setSelId(null); };
  const patch = (id: string, p: Partial<OverlayItem>) => setItems(items.map((x) => (x.id === id ? { ...x, ...p } : x)));

  const sel = items.find((x) => x.id === selId) || null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-ink-muted">画面文字(拖动移动，拖右下角改大小)</span>
        <button onClick={addItem} className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-pink-300 hover:text-pink-200">
          <Plus size={11} /> 添加文字
        </button>
      </div>

      {/* 预览框(放大) */}
      <div className="flex justify-center">
        <div ref={boxRef} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
          onClick={() => setSelId(null)}
          className="relative overflow-hidden rounded-lg"
          style={{ aspectRatio: aspect(ratioW, ratioH), width: ratioW >= ratioH ? "100%" : "auto", height: ratioW >= ratioH ? "auto" : 460, maxHeight: 460, background: boxBg }}>
          {/* 各文字条目 */}
          {items.map((it) => (
            <div key={it.id}
              onPointerDown={(e) => onDown(e, it.id, "move")}
              className="absolute cursor-move select-none"
              style={{
                ...(it.align === "center"
                  ? { left: "50%", transform: "translateX(-50%)" }
                  : { left: `${it.xPct * 100}%` }),
                top: `${it.yPct * 100}%`,
                fontSize: `${it.fontPct * boxH}px`,
                color: it.color, WebkitTextStroke: `1px ${it.stroke}`,
                writingMode: it.vertical ? "vertical-rl" : "horizontal-tb",
                lineHeight: 1.1, whiteSpace: "nowrap",
                outline: selId === it.id ? "1px dashed #ec4899" : "none",
              }}>
              {it.text.replace("{min}", "5")}
              {selId === it.id && (
                <span onPointerDown={(e) => onDown(e, it.id, "resize")}
                  className="absolute -bottom-1 -right-1 h-2.5 w-2.5 cursor-nwse-resize rounded-full bg-pink-500" />
              )}
            </div>
          ))}
          {/* 字幕示例 */}
          <div className="pointer-events-none absolute left-1/2 -translate-x-1/2 select-none text-center"
            style={{
              top: `${subtitle.yPct * 100}%`, transform: "translate(-50%,-50%)",
              fontSize: `${subtitle.fontPct * boxH}px`,
              color: subtitle.color, WebkitTextStroke: `1px ${subtitle.stroke}`, whiteSpace: "nowrap",
            }}>
            这是一句示例字幕
          </div>
          <div className="pointer-events-none absolute bottom-1 right-1 text-[8px]" style={{ color: boxHint }}>预览</div>
        </div>
      </div>

      {/* 条目列表 + 选中项属性 */}
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.id} className={`rounded border p-1.5 text-xs ${selId === it.id ? "border-pink-500/60 bg-pink-500/5" : "border-line"}`}
            onClick={() => setSelId(it.id)}>
            <div className="flex items-center gap-1">
              <Type size={11} className="shrink-0 text-ink-muted" />
              <input value={it.text} onChange={(e) => patch(it.id, { text: e.target.value })}
                className="flex-1 rounded bg-surface-elevated px-1.5 py-0.5 text-xs outline-none" />
              <button onClick={(e) => { e.stopPropagation(); removeItem(it.id); }} className="text-ink-muted hover:text-red-400"><X size={12} /></button>
            </div>
            {selId === it.id && (
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                <select value={it.font} onChange={(e) => patch(it.id, { font: e.target.value })}
                  className="rounded border border-line bg-surface-elevated px-1 py-0.5">
                  {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={it.vertical} onChange={(e) => patch(it.id, { vertical: e.target.checked })} /> 竖排
                </label>
                <label className="flex items-center gap-1">
                  <input type="checkbox" checked={it.align === "center"} onChange={(e) => patch(it.id, { align: e.target.checked ? "center" : "left" })} /> 居中
                </label>
                <label className="flex items-center gap-1">字色<input type="color" value={it.color} onChange={(e) => patch(it.id, { color: e.target.value })} className="h-4 w-6" /></label>
                <label className="flex items-center gap-1">描边<input type="color" value={it.stroke} onChange={(e) => patch(it.id, { stroke: e.target.value })} className="h-4 w-6" /></label>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 字幕样式 */}
      <div className="rounded border border-line p-1.5">
        <div className="mb-1 text-[10px] text-ink-muted">字幕样式</div>
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <select value={subtitle.font} onChange={(e) => setSubtitle({ ...subtitle, font: e.target.value })}
            className="rounded border border-line bg-surface-elevated px-1 py-0.5">
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <label className="flex items-center gap-1">大小
            <input type="range" min={0.025} max={0.09} step={0.005} value={subtitle.fontPct}
              onChange={(e) => setSubtitle({ ...subtitle, fontPct: +e.target.value })} />
          </label>
          <label className="flex items-center gap-1">高度
            <input type="range" min={0.5} max={0.95} step={0.01} value={subtitle.yPct}
              onChange={(e) => setSubtitle({ ...subtitle, yPct: +e.target.value })} />
          </label>
          <label className="flex items-center gap-1">字色<input type="color" value={subtitle.color} onChange={(e) => setSubtitle({ ...subtitle, color: e.target.value })} className="h-4 w-6" /></label>
          <label className="flex items-center gap-1">描边<input type="color" value={subtitle.stroke} onChange={(e) => setSubtitle({ ...subtitle, stroke: e.target.value })} className="h-4 w-6" /></label>
        </div>
      </div>
    </div>
  );
}