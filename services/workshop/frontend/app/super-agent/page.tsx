"use client";
/**
 * 超级 Agent（全局制片）页面 —— 2026-10-18 改接 Agent 引擎（/v1/agent-engine）。
 * 运行在后台 worker 里，关闭页面不中断；会话历史含工具卡与审批卡的完整回放。
 */
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authFetch, getUser } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import { BatchJobsPanel } from "./_BatchJobsPanel";
import { AgentConsole, ENGINE, Profile } from "../../components/agent/AgentConsole";
import { ArrowLeft, Bot, BookOpen, FolderOpen, Plus, Settings2, Trash2, X, RefreshCw } from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const TABS: [string, string][] = [
  ["overview", "概览"], ["outline", "大纲"], ["storyboards", "剧本"], ["chapters", "原文"],
  ["critique", "精修"], ["adapt", "改编"], ["export", "导出"],
];

function tabForTool(name: string): string | null {
  if (/outline|episode|beats/.test(name)) return "outline";
  if (/storyboard|rewrite|fix/.test(name)) return "storyboards";
  if (/chapter/.test(name)) return "chapters";
  if (/adapt/.test(name)) return "adapt";
  return null;
}

export default function SuperAgentPage() {
  return <Suspense fallback={null}><SuperAgentInner /></Suspense>;
}

function SuperAgentInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [ready, setReady] = useState(false);
  const [convId, setConvId] = useState<number | null>(null);
  const [profile, setProfile] = useState<Profile>("producer");
  const [draftId, setDraftId] = useState<number | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [showDraft, setShowDraft] = useState(true);
  const [tab, setTab] = useState("overview");
  const [iframeKey, setIframeKey] = useState(0);
  const [panel, setPanel] = useState<"" | "history" | "perms" | "drafts">("");
  const [history, setHistory] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [perms, setPerms] = useState<Record<string, boolean>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!getUser()) { router.replace("/login?from=/super-agent"); return; }
    const c = Number(sp.get("conv") || 0) || null;
    const d = Number(sp.get("draft") || 0) || null;
    if (c) setConvId(c);
    if (d) void bindDraft(d);
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function bindDraft(id: number | null) {
    setDraftId(id);
    setDraftTitle("");
    if (!id) return;
    const r = await authFetch(`${BASE}/v1/stages/drafts/${id}`);
    if (r.ok) setDraftTitle((await r.json()).title || "");
  }

  function newSession() {
    setConvId(null);
    router.replace("/super-agent" + (draftId ? `?draft=${draftId}` : ""));
  }

  async function openPanel(p: typeof panel) {
    setPanel(panel === p ? "" : p);
    if (p === "history") {
      const r = await authFetch(`${ENGINE}/conversations`);
      if (r.ok) setHistory((await r.json()).items || []);
    } else if (p === "perms") {
      const r = await authFetch(`${ENGINE}/permissions`);
      if (r.ok) { const d = await r.json(); setPerms(d.permissions || {}); setLabels(d.labels || {}); }
    } else if (p === "drafts") {
      const r = await authFetch(`${BASE}/v1/stages/drafts?limit=200`);
      if (r.ok) { const d = await r.json(); setDrafts(d.items || d || []); }
    }
  }

  async function openConversation(c: any) {
    setConvId(c.id);
    if (c.draft_id) void bindDraft(c.draft_id);
    setPanel("");
    router.replace(`/super-agent?conv=${c.id}`);
  }

  async function deleteConversation(id: number) {
    if (!confirm("删除这个会话？")) return;
    await authFetch(`${ENGINE}/conversations/${id}`, { method: "DELETE" });
    setHistory((h) => h.filter((x) => x.id !== id));
    if (convId === id) newSession();
  }

  async function togglePerm(k: string) {
    const v = !perms[k];
    setPerms((p) => ({ ...p, [k]: v }));
    await authFetch(`${ENGINE}/permissions`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ permissions: { [k]: v } }),
    });
  }

  if (!ready) return null;

  const btn = "flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-overlay text-xs text-ink-secondary hover:text-ink-primary transition";
  return (
    <div className="h-screen bg-surface-base text-ink-primary flex flex-col">
      <BatchJobsPanel />
      <header className="h-14 flex items-center gap-3 px-4 border-b border-line bg-surface-elevated/80 backdrop-blur shrink-0">
        <button onClick={() => router.push("/drafts")} className={btn}><ArrowLeft className="w-4 h-4" />草稿列表</button>
        <div className="h-5 w-px bg-line" />
        <h1 className="text-base font-semibold flex items-center gap-2"><Bot className="w-4 h-4 text-primary" />超级 Agent</h1>
        {draftId && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-primary/10 text-primary text-xs">
            <BookOpen className="w-3.5 h-3.5" />草稿 #{draftId}{draftTitle ? ` · ${draftTitle.slice(0, 12)}` : ""}
            <button onClick={() => void bindDraft(null)} title="解除绑定"><X className="w-3 h-3" /></button>
          </span>
        )}
        <select value={profile} onChange={(e) => setProfile(e.target.value as Profile)} disabled={!!convId}
          title={convId ? "模式在会话开始时确定，新建会话可切换" : "选择工作模式"}
          className="text-xs bg-surface-base border border-line rounded px-1.5 py-1">
          <option value="producer">全局制片（可跨草稿、批量）</option>
          <option value="readonly">只读诊断（不改任何内容）</option>
        </select>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={newSession} className={btn}><Plus className="w-3.5 h-3.5" />新会话</button>
          <button onClick={() => void openPanel("history")} className={btn}><BookOpen className="w-3.5 h-3.5" />历史会话</button>
          <button onClick={() => void openPanel("drafts")} className={btn}><FolderOpen className="w-3.5 h-3.5" />选草稿</button>
          <button onClick={() => setShowDraft((v) => !v)} className={btn}>{showDraft ? "隐藏草稿" : "显示草稿"}</button>
          <button onClick={() => void openPanel("perms")} className={btn}><Settings2 className="w-3.5 h-3.5" />助手权限</button>
          <UserNav />
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 flex flex-col min-w-0">
          <AgentConsole
            key={convId ?? "new"}
            profile={profile} draftId={draftId} conversationId={convId}
            onConversation={(id) => { setConvId(id); router.replace(`/super-agent?conv=${id}`); }}
            onToolDone={(name) => { const t = tabForTool(name); if (t && draftId) { setTab(t); setIframeKey((k) => k + 1); } }}
            examples={[
              "把评分 85 以上、10 月 1 日创建的草稿列出来，确认后批量精修",
              "把这部剧改编成民国背景，跑完大纲、剧本和精修",
              "体检这部剧，挑最重要的问题定点修复",
            ]}
          />
        </main>

        {showDraft && draftId && (
          <aside className="w-[46%] border-l border-line flex flex-col min-w-0">
            <div className="flex items-center gap-1 px-2 py-1.5 border-b border-line text-xs overflow-x-auto">
              {TABS.map(([k, l]) => (
                <button key={k} onClick={() => { setTab(k); setIframeKey((x) => x + 1); }}
                  className={`px-2 py-0.5 rounded ${tab === k ? "bg-primary/15 text-primary" : "text-ink-secondary hover:text-ink-primary"}`}>{l}</button>
              ))}
              <button onClick={() => setIframeKey((x) => x + 1)} className="ml-auto p-1" title="刷新"><RefreshCw className="w-3.5 h-3.5" /></button>
            </div>
            <iframe key={iframeKey} src={`/jubengongfang/drafts/${draftId}?embed=1&bare=1&tab=${tab}`} className="flex-1 w-full bg-surface-base" title="草稿" />
          </aside>
        )}

        {panel && (
          <div className="absolute right-0 top-0 h-full w-96 bg-surface-elevated border-l border-line shadow-xl z-20 flex flex-col">
            <div className="flex items-center px-3 py-2 border-b border-line text-sm font-semibold">
              {panel === "history" ? "历史会话" : panel === "perms" ? "助手权限" : "选择草稿"}
              <button onClick={() => setPanel("")} className="ml-auto"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 text-sm">
              {panel === "history" && (history.length === 0 ? <div className="text-ink-muted text-xs p-2">还没有会话</div> :
                history.map((c) => (
                  <div key={c.id} className={`flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-overlay ${convId === c.id ? "bg-primary/10" : ""}`}>
                    <button onClick={() => void openConversation(c)} className="flex-1 text-left truncate">{c.title}</button>
                    <span className="text-[10px] text-ink-muted">{(c.updated_at || "").slice(5, 16).replace("T", " ")}</span>
                    <button onClick={() => void deleteConversation(c.id)} title="删除"><Trash2 className="w-3.5 h-3.5 text-ink-muted hover:text-danger" /></button>
                  </div>
                )))}
              {panel === "perms" && (
                <div className="space-y-1">
                  <p className="text-xs text-ink-muted px-1 pb-2">打勾的类别执行前不再询问。删除类和批量处理 5 部以上草稿始终需要确认。</p>
                  {Object.keys(labels).map((k) => (
                    <label key={k} className="flex items-center gap-2 px-1 py-1 text-xs">
                      <input type="checkbox" checked={!!perms[k]} onChange={() => void togglePerm(k)} />{labels[k]}
                    </label>
                  ))}
                </div>
              )}
              {panel === "drafts" && drafts.map((d) => (
                <button key={d.id} onClick={() => { void bindDraft(d.id); setPanel(""); }}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-surface-overlay flex gap-2">
                  <span className="text-ink-muted">#{d.id}</span><span className="truncate">{d.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
