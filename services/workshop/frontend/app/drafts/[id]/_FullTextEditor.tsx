"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Save, Search, Undo2, Redo2, Type, Maximize2, Minimize2,
  ChevronDown, X, AlertTriangle,
} from "lucide-react";
import { authFetch } from "../../../lib/auth";
import { notifyError, notifySuccess } from "@/lib/dialog";
import {
  storyboardsToFullText, fullTextToStoryboards, textToShots, type Shot,
} from "../../../lib/scriptText";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

const FONT_SIZES = [
  { label: "小", px: 13 },
  { label: "正常", px: 15 },
  { label: "中", px: 17 },
  { label: "大", px: 20 },
  { label: "特大", px: 24 },
];
const FONT_KEY = "drama_script_fulltext_fontpx";
const AUTOSAVE_PREFIX = "drama_script_fulltext_autosave_";

type SB = { chapter_order: number; shots_json?: Shot[] | null };

/**
 * 剧本「全文视图」编辑器 (需求1)
 * - 整部剧本拼成一个连贯文档, 单一「保存」按钮批量写回
 * - 类 Word 工具栏: 保存/查找替换/字号5档/撤销重做/字数/快速跳转/全屏
 * - 本地自动暂存防丢; 格式校验提示无法解析回结构的集
 */
export function FullTextEditor({
  draftId,
  storyboards,
  onSaved,
  locked = false,
  lockedHint,
}: {
  draftId: number;
  storyboards: SB[];
  onSaved?: () => void;
  /** 外部正在重写(如"根据意见重新生成")时锁定编辑框, 防止用户改动被覆盖丢失; 解锁瞬间强制覆盖为最新内容 */
  locked?: boolean;
  lockedHint?: string;
}) {
  const initial = useMemo(() => storyboardsToFullText(storyboards), [storyboards]);
  const [text, setText] = useState(initial);
  const lastInitialRef = useRef(initial);
  const prevLockedRef = useRef(locked);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fontPx, setFontPx] = useState(15);
  const [fullscreen, setFullscreen] = useState(false);
  const [showFind, setShowFind] = useState(false);
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [showJump, setShowJump] = useState(false);

  // 撤销/重做历史栈
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const autosaveKey = AUTOSAVE_PREFIX + draftId;

  // 初次挂载: 读字号 + 尝试恢复本地暂存
  useEffect(() => {
    try {
      const f = parseInt(localStorage.getItem(FONT_KEY) || "");
      if (FONT_SIZES.some((s) => s.px === f)) setFontPx(f);
      const saved = localStorage.getItem(autosaveKey);
      if (saved && saved !== initial) {
        if (confirm("检测到上次未保存的全文编辑内容, 是否恢复?")) {
          setText(saved);
          setDirty(true);
        } else {
          localStorage.removeItem(autosaveKey);
        }
      }
    } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // storyboards 变化(外部刷新)时同步文本(非锁定态): 内容真的变了才覆盖, 不打扰用户手动编辑。
  useEffect(() => {
    if (locked) return; // 锁定中由下面的解锁逻辑统一覆盖
    if (initial === lastInitialRef.current) return;
    lastInitialRef.current = initial;
    setText(initial);
    setDirty(false);
    try { localStorage.removeItem(autosaveKey); } catch { /* noop */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, locked]);

  // 锁定 → 解锁 的瞬间: 无条件用最新 initial 覆盖文本框(这就是"重写完成自动覆盖")。
  // 这样无论用户之前是否 dirty、无论 storyboards 引用/内容如何, 重写结果一定进框。
  useEffect(() => {
    const was = prevLockedRef.current;
    prevLockedRef.current = locked;
    if (was && !locked) {
      lastInitialRef.current = initial;
      setText(initial);
      setDirty(false);
      try { localStorage.removeItem(autosaveKey); } catch { /* noop */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, initial]);

  // 自动暂存 (debounce 2s)
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(autosaveKey, text); } catch { /* noop */ }
    }, 2000);
    return () => clearTimeout(t);
  }, [text, dirty, autosaveKey]);

  // 离开未保存拦截
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  function pushHistory(prev: string) {
    undoStack.current.push(prev);
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current = [];
  }

  function onChange(next: string) {
    pushHistory(text);
    setText(next);
    setDirty(true);
  }

  function undo() {
    if (!undoStack.current.length) return;
    const prev = undoStack.current.pop()!;
    redoStack.current.push(text);
    setText(prev);
    setDirty(true);
  }
  function redo() {
    if (!redoStack.current.length) return;
    const next = redoStack.current.pop()!;
    undoStack.current.push(text);
    setText(next);
    setDirty(true);
  }

  function changeFont(px: number) {
    setFontPx(px);
    try { localStorage.setItem(FONT_KEY, String(px)); } catch { /* noop */ }
  }

  // 把 textarea 滚动到字符 offset 所在位置 (用镜像 div 精确测量 y, 避免行高估算误差)。
  function scrollToOffset(ta: HTMLTextAreaElement, offset: number) {
    const cs = window.getComputedStyle(ta);
    const mirror = document.createElement("div");
    const props = [
      "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
      "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
      "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing",
      "whiteSpace", "wordWrap", "wordBreak",
    ] as const;
    props.forEach((p) => { (mirror.style as any)[p] = (cs as any)[p]; });
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.height = "auto";
    mirror.style.width = ta.clientWidth + "px";
    // 把 offset 之前的文本放进镜像, 末尾加一个标记 span 测其 offsetTop
    mirror.textContent = ta.value.slice(0, offset);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const y = marker.offsetTop;
    document.body.removeChild(mirror);
    // 让目标行居中可见
    ta.scrollTop = Math.max(0, y - ta.clientHeight / 2);
  }

  function doFindNext() {
    const ta = taRef.current;
    if (!ta || !findText) return;
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? findText : findText.toLowerCase();
    const from = (ta.selectionEnd ?? 0);
    let idx = hay.indexOf(needle, from);
    if (idx === -1) idx = hay.indexOf(needle, 0); // 回绕
    if (idx === -1) { notifyError("未找到"); return; }
    ta.focus();
    ta.setSelectionRange(idx, idx + findText.length); // 选中=高亮
    scrollToOffset(ta, idx);
  }
  function doReplaceAll() {
    if (!findText) return;
    pushHistory(text);
    let result: string;
    if (caseSensitive) {
      result = text.split(findText).join(replaceText);
    } else {
      const re = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      result = text.replace(re, replaceText);
    }
    setText(result);
    setDirty(true);
    notifySuccess("已全部替换");
  }

  // 集列表(用于快速跳转 + 格式校验)
  const episodes = useMemo(() => {
    const re = /═+\s*第\s*(\d+)\s*集\s*═+/g;
    const out: { order: number; idx: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ order: parseInt(m[1], 10), idx: m.index });
    return out;
  }, [text]);

  function jumpTo(idx: number) {
    const ta = taRef.current;
    if (!ta) return;
    setShowJump(false);
    ta.focus();
    // 选中该集集头那一行(到行尾), 既高亮也便于定位
    const lineEnd = text.indexOf("\n", idx);
    ta.setSelectionRange(idx, lineEnd === -1 ? text.length : lineEnd);
    // 用镜像精确测量并把该集滚到顶部偏上一点
    const cs = window.getComputedStyle(ta);
    const mirror = document.createElement("div");
    ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingLeft", "paddingRight"].forEach(
      (p) => { (mirror.style as any)[p] = (cs as any)[p]; },
    );
    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.width = ta.clientWidth + "px";
    mirror.textContent = ta.value.slice(0, idx);
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const y = marker.offsetTop;
    document.body.removeChild(mirror);
    ta.scrollTop = Math.max(0, y - 16);
  }

  // 格式校验: 哪些集解析后场数为0(可能格式被破坏)
  const formatWarnings = useMemo(() => {
    const parsed = fullTextToStoryboards(text);
    return parsed.filter((p) => !p.shots_json.length).map((p) => p.chapter_order);
  }, [text]);

  const charCount = text.replace(/\s/g, "").length;

  async function save() {
    setSaving(true);
    try {
      const parsed = fullTextToStoryboards(text);
      if (!parsed.length) { notifyError("未识别到任何集, 请检查集头「═══ 第X集 ═══」格式"); setSaving(false); return; }
      const items = parsed.map((p) => ({ chapter_order: p.chapter_order, shots_json: p.shots_json }));
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/storyboards/batch`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setDirty(false);
      try { localStorage.removeItem(autosaveKey); } catch { /* noop */ }
      notifySuccess(`已保存 ${data.updated?.length || 0} 集` + (data.skipped?.length ? `, ${data.skipped.length} 集未生成跳过` : ""));
      onSaved?.();
    } catch (e) {
      notifyError("保存失败: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // 键盘快捷键
  function onKeyDown(e: React.KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); setShowFind(true); }
  }

  const wrapCls = fullscreen
    ? "fixed inset-0 z-[60] bg-surface-base flex flex-col"
    : "flex flex-col";

  return (
    <div className={wrapCls}>
      {/* 常驻工具栏 (sticky) */}
      <div className="sticky top-0 z-10 bg-surface-elevated border border-line rounded-t-lg px-3 py-2 flex items-center gap-2 flex-wrap">
        <button
          onClick={save}
          disabled={saving || !dirty}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-semibold transition ${
            dirty ? "bg-primary text-white hover:bg-primary-hover" : "bg-surface-overlay text-ink-muted"
          }`}
          title="保存全部 (Ctrl+S)"
        >
          <Save className="w-4 h-4" />
          {saving ? "保存中…" : dirty ? "保存" : "已保存"}
        </button>

        <div className="w-px h-5 bg-line" />

        <button onClick={undo} disabled={!undoStack.current.length} className="p-1.5 rounded hover:bg-surface-overlay text-ink-secondary disabled:opacity-40" title="撤销 (Ctrl+Z)">
          <Undo2 className="w-4 h-4" />
        </button>
        <button onClick={redo} disabled={!redoStack.current.length} className="p-1.5 rounded hover:bg-surface-overlay text-ink-secondary disabled:opacity-40" title="重做 (Ctrl+Shift+Z)">
          <Redo2 className="w-4 h-4" />
        </button>

        <div className="w-px h-5 bg-line" />

        <button onClick={() => setShowFind((v) => !v)} className="p-1.5 rounded hover:bg-surface-overlay text-ink-secondary" title="查找/替换 (Ctrl+F)">
          <Search className="w-4 h-4" />
        </button>

        {/* 字号 */}
        <div className="flex items-center gap-1">
          <Type className="w-4 h-4 text-ink-muted" />
          <select
            value={fontPx}
            onChange={(e) => changeFont(parseInt(e.target.value))}
            className="text-xs bg-surface-base border border-line rounded px-1.5 py-1 text-ink-primary"
            title="字号"
          >
            {FONT_SIZES.map((s) => (
              <option key={s.px} value={s.px}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* 快速跳转 */}
        {episodes.length > 0 && (
          <div className="relative">
            <button onClick={() => setShowJump((v) => !v)} className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-surface-overlay text-ink-secondary text-xs" title="跳转到某集">
              跳转 <ChevronDown className="w-3 h-3" />
            </button>
            {showJump && (
              <div className="absolute left-0 top-full mt-1 z-20 bg-surface-elevated border border-line rounded-lg shadow-xl max-h-72 overflow-y-auto w-32">
                {episodes.map((ep) => (
                  <button key={ep.order} onClick={() => jumpTo(ep.idx)} className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface-overlay text-ink-primary">
                    第{ep.order}集
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button onClick={() => setFullscreen((v) => !v)} className="p-1.5 rounded hover:bg-surface-overlay text-ink-secondary" title={fullscreen ? "退出全屏" : "全屏专注"}>
          {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
        </button>

        <div className="ml-auto flex items-center gap-3 text-xs text-ink-muted">
          {formatWarnings.length > 0 && (
            <span className="flex items-center gap-1 text-warning" title={`第 ${formatWarnings.join("、")} 集无法解析出场, 检查格式`}>
              <AlertTriangle className="w-3.5 h-3.5" />
              {formatWarnings.length} 集格式需检查
            </span>
          )}
          <span>{charCount} 字 · {episodes.length} 集</span>
        </div>
      </div>

      {/* 查找替换条 */}
      {showFind && (
        <div className="bg-surface-elevated border-x border-line px-3 py-2 flex items-center gap-2 flex-wrap text-sm">
          <input
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doFindNext(); }}
            placeholder="查找"
            className="px-2 py-1 bg-surface-base border border-line rounded text-ink-primary w-40"
          />
          <input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="替换为"
            className="px-2 py-1 bg-surface-base border border-line rounded text-ink-primary w-40"
          />
          <button onClick={doFindNext} className="px-2 py-1 rounded bg-surface-overlay text-ink-primary hover:bg-surface-card-hover text-xs">查找下一个</button>
          <button onClick={doReplaceAll} className="px-2 py-1 rounded bg-surface-overlay text-ink-primary hover:bg-surface-card-hover text-xs">全部替换</button>
          <label className="flex items-center gap-1 text-xs text-ink-secondary">
            <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
            区分大小写
          </label>
          <button onClick={() => setShowFind(false)} className="ml-auto p-1 rounded hover:bg-surface-overlay text-ink-muted">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* 编辑区 (重写锁定时禁用并显示遮罩) */}
      <div className={`relative ${fullscreen ? "flex-1 flex flex-col" : ""}`}>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          disabled={locked}
          className={`w-full border border-line rounded-b-lg bg-surface-base text-ink-primary p-4 leading-relaxed font-mono resize-none focus:outline-none focus:border-primary ${
            fullscreen ? "flex-1" : "min-h-[60vh]"
          } ${locked ? "opacity-60 cursor-not-allowed" : ""}`}
          style={{ fontSize: `${fontPx}px` }}
          placeholder="（暂无剧本内容）"
        />
        {locked && (
          <div className="absolute inset-0 flex items-center justify-center rounded-b-lg bg-surface-base/70 backdrop-blur-[1px] z-20">
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-elevated border border-line shadow-lg text-sm text-ink-primary">
              <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              {lockedHint || "正在重新生成，完成后将自动更新内容…"}
            </div>
          </div>
        )}
      </div>

      {/* 底部格式说明 */}
      <div className="mt-1 text-[11px] text-ink-muted px-1">
        格式: 每集以「═══ 第X集 ═══」分隔; 每场以「【场 …】」开头; △开头=动作; 「角色：台词」=对白; 「注：…」=备注。保存时按此解析回结构。
      </div>
    </div>
  );
}