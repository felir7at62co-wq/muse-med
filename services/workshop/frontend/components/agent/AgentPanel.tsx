"use client";
/**
 * Agent 面板（抽屉）：v2 工作台对话栏与 v1 对话工坊共用，提供完整的超级 Agent 能力。
 *   · 三种模式：单剧本（只改当前草稿）/ 全局制片（可跨草稿、新建、批量、裂变）/ 只读诊断
 *   · 自动绑定当前草稿；全局制片模式下它是默认对象，也可以让 Agent 处理别的草稿
 *   · 新会话、历史会话（默认只看这部草稿的，可切到全部）、助手权限
 * 模式在会话开始时确定；打开历史会话会恢复它当时的模式。运行在后台，关闭抽屉不中断。
 */
import { useEffect, useState } from "react";
import { Bot, X, Plus, History, Settings2, Trash2 } from "lucide-react";
import { authFetch } from "../../lib/auth";
import { AgentConsole, ENGINE, Profile } from "./AgentConsole";

const convKey = (draftId: number) => `agent_conv_${draftId}`;
/** 只读工具完成时不需要让工作台刷新 */
const READ_TOOLS = new Set([
  "list_drafts", "find_drafts", "get_draft", "read_outline", "read_chapter", "read_storyboard", "run_check", "deai_detect",
  "get_job", "list_versions", "refresh_gate", "start_analysis", "get_analysis", "get_characters",
  "scan_character_warnings", "diagnose_timeline", "export_docx", "adapt_analyze", "adapt_propose", "write_todos",
]);
const PROFILE_LABEL: Record<Profile, string> = {
  studio: "单剧本", producer: "全局制片", readonly: "只读诊断",
};
const PROFILE_HINT: Record<Profile, string> = {
  studio: "只处理当前这部剧",
  producer: "可跨草稿、新建、批量处理、裂变；没指明时默认处理当前这部剧",
  readonly: "只读取和体检，不修改任何内容",
};
const EXAMPLES: Record<Profile, string[]> = {
  studio: [
    "体检这部剧，挑最重要的问题定点修复，修完复查",
    "读第 1~3 集剧本，钩子弱的集按你的判断重写",
    "把第 5 集里所有「张总」改成「张董」",
  ],
  producer: [
    "以这部剧为母本裂变 3 部校园悬疑题材的新剧",
    "把这部剧改编成民国背景，跑完大纲、剧本和精修",
    "列出评分 85 以上的草稿，确认后批量精修",
  ],
  readonly: [
    "给这部剧做一次分析评分，说说最该改的三处",
    "诊断一下全剧的节奏分布",
  ],
};

export default function AgentPanel({
  draftId, open, onClose, onChanged, model,
}: {
  draftId: number;
  open: boolean;
  onClose: () => void;
  /**
   * 对话栏旁边选中的具体型号（"deepseek:deepseek-v4-flash"）—— **只作为写作模型**。
   * 2026-10-21 用户裁定：Agent 自己的思考模型不让用户换，固定用平台默认
   * （后端 AGENT_ENGINE_MODEL，当前 deepseek-v4-flash）。原因见 AgentConsole 里 model: null 处。
   */
  model?: string;
  /** Agent 改动了内容后回调（工作台据此刷新当前视图） */
  onChanged?: (tool: string) => void;
}) {
  const [conv, setConv] = useState<number | null>(null);
  const [profile, setProfile] = useState<Profile>("studio");
  const [side, setSide] = useState<"" | "history" | "perms">("");
  const [history, setHistory] = useState<any[]>([]);
  const [onlyThis, setOnlyThis] = useState(true);
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  // 每部草稿记住上次的会话；打开时恢复它的模式
  useEffect(() => {
    let c: number | null = null;
    try { c = Number(localStorage.getItem(convKey(draftId))) || null; } catch { /* 忽略 */ }
    void openConversation(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  async function openConversation(id: number | null) {
    setSide("");
    if (!id) { setConv(null); return; }
    const r = await authFetch(`${ENGINE}/conversations/${id}`);
    if (!r.ok) { remember(null); return; }
    const d = await r.json();
    if (d.conversation?.profile) setProfile(d.conversation.profile);
    remember(id);
  }

  function remember(id: number | null) {
    setConv(id);
    try { id ? localStorage.setItem(convKey(draftId), String(id)) : localStorage.removeItem(convKey(draftId)); } catch { /* 忽略 */ }
  }

  async function toggleSide(p: "history" | "perms") {
    if (side === p) { setSide(""); return; }
    setSide(p);
    if (p === "history") await loadHistory(onlyThis);
    else {
      const r = await authFetch(`${ENGINE}/permissions`);
      if (r.ok) { const d = await r.json(); setPerms(d.permissions || {}); setLabels(d.labels || {}); }
    }
  }

  async function loadHistory(only: boolean) {
    const r = await authFetch(`${ENGINE}/conversations${only ? `?draft_id=${draftId}` : ""}`);
    if (r.ok) setHistory((await r.json()).items || []);
  }

  async function deleteConversation(id: number) {
    if (!confirm("删除这个会话？")) return;
    await authFetch(`${ENGINE}/conversations/${id}`, { method: "DELETE" });
    setHistory((h) => h.filter((x) => x.id !== id));
    if (conv === id) remember(null);
  }

  async function togglePerm(k: string) {
    const v = !perms[k];
    setPerms((p) => ({ ...p, [k]: v }));
    const r = await authFetch(`${ENGINE}/permissions`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissions: { [k]: v } }),
    }).catch(() => null);
    // 没存上就把勾退回去：否则界面显示已免确认，运行中的 Agent 读到的却还是旧值。
    if (!r || !r.ok) {
      setPerms((p) => ({ ...p, [k]: !v }));
      alert("权限没有保存成功，请重试");
    }
  }

  if (!open) return null;
  const btn = "flex items-center gap-1 px-2 py-1 rounded text-xs text-ink-secondary hover:text-ink-primary hover:bg-surface-overlay";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="relative w-full max-w-2xl h-full bg-surface-elevated border-l border-line flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-sm">
          <Bot className="w-4 h-4 text-primary" />
          <span className="font-semibold">超级 Agent</span>
          <span className="text-xs text-ink-muted">绑定草稿 #{draftId}</span>
          <select value={profile} disabled={!!conv} onChange={(e) => setProfile(e.target.value as Profile)}
            title={conv ? "模式在会话开始时确定；点「新会话」可切换" : PROFILE_HINT[profile]}
            className="ml-1 text-xs bg-surface-base border border-line rounded px-1.5 py-0.5 disabled:opacity-70">
            {(Object.keys(PROFILE_LABEL) as Profile[]).map((p) => <option key={p} value={p}>{PROFILE_LABEL[p]}</option>)}
          </select>
          <div className="ml-auto flex items-center gap-0.5">
            <button onClick={() => remember(null)} className={btn}><Plus className="w-3.5 h-3.5" />新会话</button>
            <button onClick={() => void toggleSide("history")} className={btn}><History className="w-3.5 h-3.5" />历史</button>
            <button onClick={() => void toggleSide("perms")} className={btn}><Settings2 className="w-3.5 h-3.5" />权限</button>
            <button onClick={onClose} className="p-1" title="关闭（后台继续）"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="px-3 py-1 text-[11px] text-ink-muted border-b border-line">
          {PROFILE_LABEL[profile]}：{PROFILE_HINT[profile]}。关闭面板后任务会在后台继续。
        </div>

        <AgentConsole
          key={`${conv ?? "new"}-${profile}`}
          profile={profile} draftId={draftId} conversationId={conv} model={model}
          onConversation={(id) => remember(id)}
          onToolDone={(name) => { if (!READ_TOOLS.has(name)) onChanged?.(name); }}
          examples={EXAMPLES[profile]}
        />

        {side && (
          <div className="absolute right-0 top-10 bottom-0 w-80 bg-surface-elevated border-l border-line shadow-xl flex flex-col z-10">
            <div className="flex items-center px-3 py-2 border-b border-line text-sm font-semibold">
              {side === "history" ? "历史会话" : "助手权限"}
              <button onClick={() => setSide("")} className="ml-auto"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 text-sm">
              {side === "history" && (
                <>
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted px-1 pb-2">
                    <input type="checkbox" checked={onlyThis}
                      onChange={(e) => { setOnlyThis(e.target.checked); void loadHistory(e.target.checked); }} />
                    只看这部剧的会话
                  </label>
                  {history.length === 0 && <div className="text-xs text-ink-muted px-1">还没有会话</div>}
                  {history.map((c) => (
                    <div key={c.id} className={`flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-surface-overlay ${conv === c.id ? "bg-primary/10" : ""}`}>
                      <button onClick={() => void openConversation(c.id)} className="flex-1 text-left truncate text-xs">
                        {c.title}
                        <span className="block text-[10px] text-ink-muted">
                          {c.profile ? PROFILE_LABEL[c.profile as Profile] : ""}{c.draft_id ? ` · #${c.draft_id}` : ""} · {(c.updated_at || "").slice(5, 16).replace("T", " ")}
                        </span>
                      </button>
                      <button onClick={() => void deleteConversation(c.id)} title="删除"><Trash2 className="w-3.5 h-3.5 text-ink-muted hover:text-danger" /></button>
                    </div>
                  ))}
                </>
              )}
              {side === "perms" && (
                <div className="space-y-1">
                  <p className="text-xs text-ink-muted px-1 pb-2">打勾的类别执行前不再询问。删除类和批量处理 5 部以上草稿始终需要确认。</p>
                  <p className="text-xs text-ink-muted px-1 pb-2">
                    改动立即保存，正在进行的那一轮也会在几秒内按新设置判断后续操作；
                    但已经弹出来的确认卡片不会自动通过，仍需你点一次。
                  </p>
                  {Object.keys(labels).map((k) => (
                    <label key={k} className="flex items-center gap-2 px-1 py-1 text-xs">
                      <input type="checkbox" checked={!!perms[k]} onChange={() => void togglePerm(k)} />{labels[k]}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
