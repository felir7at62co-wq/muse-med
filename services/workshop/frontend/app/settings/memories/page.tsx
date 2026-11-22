"use client";
import { useEffect, useState } from "react";
import { authFetch, getUser } from "../../../lib/auth";
import { UserNav } from "../../_UserNav";
import { ArrowLeft, Pin, PinOff, Trash2, Edit3, Plus, Search, Loader2, Save, X, Download } from "lucide-react";
import { useRouter } from "next/navigation";
import { confirmAsync, notifySuccess } from "@/lib/dialog";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/agent`;

const TYPE_LABEL: Record<string, string> = {
  preference: "🎯 偏好",
  fact: "📌 事实",
  plot_pattern: "🎬 情节模式",
  character_template: "👥 角色模板",
  world_setting: "🌍 世界观",
};
const ALL_TYPES = ["preference", "fact", "plot_pattern", "character_template", "world_setting"];

type Memory = {
  id: number;
  type: string;
  scope: string;
  title: string | null;
  content: string;
  importance: number;
  hit_count: number;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  last_accessed_at?: string | null;
};

type Profile = {
  user_id: number;
  preferred_genres?: string[];
  forbidden_topics?: string[];
  preferred_length?: number | null;
  preferred_pace?: string | null;
  style_summary?: string | null;
  tone_keywords?: string[];
  custom_instructions?: string | null;
  memory_enabled?: boolean;
  total_drafts?: number;
  total_chats?: number;
  last_summarized_at?: string | null;
};

export default function MemoriesPage() {
  if (typeof window !== "undefined" && !getUser()) { window.location.href = "/jubengongfang/login"; return null; }
  const router = useRouter();

  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>("");
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [tab, setTab] = useState<"memories" | "profile">("memories");

  useEffect(() => {
    void loadMemories();
    void loadProfile();
  }, []);

  async function loadMemories() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterType) params.set("type", filterType);
      if (search) params.set("search", search);
      const r = await authFetch(`${API}/memories?${params}`);
      if (r.ok) {
        const data = await r.json();
        setMemories(data.items || []);
      }
    } finally { setLoading(false); }
  }

  async function loadProfile() {
    const r = await authFetch(`${API}/profile`);
    if (r.ok) setProfile(await r.json());
  }

  useEffect(() => { void loadMemories(); }, [filterType]);

  async function handleSearch() { await loadMemories(); }

  async function togglePin(m: Memory) {
    await authFetch(`${API}/memories/${m.id}/pin`, { method: "POST" });
    await loadMemories();
  }

  async function deleteMem(m: Memory) {
    const ok = await confirmAsync({
      title: "删除记忆",
      description: `软删除后 AI 将不再使用：「${m.content.slice(0, 50)}...」`,
      confirmText: "删除",
      tone: "danger",
    });
    if (!ok) return;
    await authFetch(`${API}/memories/${m.id}`, { method: "DELETE" });
    await loadMemories();
  }

  async function clearAll() {
    const first = await confirmAsync({
      title: "清空所有记忆",
      description: "这会让 AI 完全忘记所有学到的偏好，不可恢复。",
      confirmText: "下一步",
      tone: "warning",
    });
    if (!first) return;
    const second = await confirmAsync({
      title: "二次确认",
      description: "真的要清空全部记忆吗？此操作会归档所有条目。",
      confirmText: "确认清空",
      tone: "danger",
    });
    if (!second) return;
    const r = await authFetch(`${API}/memories/clear-all`, { method: "POST" });
    if (r.ok) {
      const data = await r.json();
      alert(`已归档 ${data.archived} 条记忆`);
      await loadMemories();
    }
  }

  async function exportAll() {
    const r = await authFetch(`${API}/memories?archived=true&limit=500`);
    if (r.ok) {
      const data = await r.json();
      const blob = new Blob([JSON.stringify(data.items, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my_memories_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  async function saveProfile(patches: Partial<Profile>) {
    setSavingProfile(true);
    try {
      const r = await authFetch(`${API}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patches),
      });
      if (r.ok) setProfile(await r.json());
    } finally { setSavingProfile(false); }
  }

  return (
    <>
      <div className="fixed top-3 right-4 z-30"><UserNav /></div>
      <div className="min-h-screen bg-surface-base text-ink-primary p-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-4 mb-6">
            <button onClick={() => router.back()} className="p-2 hover:bg-surface-base rounded-lg">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold">🧠 我的 AI 记忆</h1>
            <span className="text-sm text-ink-secondary">AI 关于你的所有记忆都在这里, 你随时可见可编辑</span>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 mb-4 border-b border-line">
            <button onClick={() => setTab("memories")} className={`px-4 py-2 ${tab === "memories" ? "border-b-2 border-primary" : "text-ink-secondary"}`}>
              📒 记忆条目 ({memories.length})
            </button>
            <button onClick={() => setTab("profile")} className={`px-4 py-2 ${tab === "profile" ? "border-b-2 border-primary" : "text-ink-secondary"}`}>
              👤 用户画像 / 偏好设置
            </button>
          </div>

          {tab === "memories" && (
            <>
              {/* 工具栏 */}
              <div className="mb-4 flex flex-wrap gap-2 items-center bg-surface-base/50 rounded-lg p-3 border border-line">
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-1.5 bg-surface-overlay border border-line rounded text-sm"
                >
                  <option value="">全部类型</option>
                  {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </select>
                <div className="flex items-center gap-1 flex-1 min-w-[200px]">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    placeholder="搜索内容..."
                    className="flex-1 px-3 py-1.5 bg-surface-overlay border border-line rounded text-sm"
                  />
                  <button onClick={handleSearch} className="px-2 py-1.5 bg-surface-overlay hover:bg-surface-overlay rounded">
                    <Search className="w-4 h-4" />
                  </button>
                </div>
                <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary rounded text-sm">
                  <Plus className="w-4 h-4" /> 手动添加
                </button>
                <button onClick={exportAll} className="flex items-center gap-1 px-3 py-1.5 bg-surface-overlay hover:bg-surface-overlay rounded text-sm">
                  <Download className="w-4 h-4" /> 导出
                </button>
                <button onClick={clearAll} className="flex items-center gap-1 px-3 py-1.5 bg-danger/80 hover:bg-danger rounded text-sm">
                  <Trash2 className="w-4 h-4" /> 全部清空
                </button>
              </div>

              {/* 列表 */}
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      className="p-3 bg-surface-base/40 border border-line rounded-lg animate-pulse"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <div className="h-4 w-16 bg-surface-overlay rounded" />
                        <div className="h-4 w-32 bg-surface-overlay/70 rounded" />
                      </div>
                      <div className="h-3 w-4/5 bg-surface-overlay/60 rounded mb-1" />
                      <div className="h-3 w-3/5 bg-surface-overlay/40 rounded" />
                    </div>
                  ))}
                </div>
              ) : memories.length === 0 ? (
                <div className="text-center py-16 text-ink-secondary">
                  <img
                    src="/jubengongfang/brand/empty-no-memories.webp"
                    alt=""
                    className="w-40 h-28 object-contain mx-auto mb-4 select-none"
                  />
                  <p className="text-lg mb-2">还没有任何记忆</p>
                  <p className="text-sm">去和 AI 聊几句, 它会自动记下你的偏好。或点上面"手动添加"。</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {memories.map((m) => (
                    <MemoryItem
                      key={m.id}
                      m={m}
                      onPin={() => togglePin(m)}
                      onDelete={() => deleteMem(m)}
                      onEdit={() => setEditing(m)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {tab === "profile" && profile && (
            <ProfileEditor profile={profile} onSave={saveProfile} saving={savingProfile} />
          )}
        </div>
      </div>

      {showAdd && (
        <MemoryEditor
          initial={null}
          onClose={() => setShowAdd(false)}
          onSaved={async () => { setShowAdd(false); await loadMemories(); }}
        />
      )}
      {editing && (
        <MemoryEditor
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await loadMemories(); }}
        />
      )}
    </>
  );
}

function MemoryItem({ m, onPin, onDelete, onEdit }: {
  m: Memory; onPin: () => void; onDelete: () => void; onEdit: () => void;
}) {
  return (
    <div className={`p-3 rounded-lg border ${m.pinned ? "bg-warning/5 border-warning/30" : "bg-surface-base/40 border-line"}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 text-xs">
            <span className="font-semibold">{TYPE_LABEL[m.type] || m.type}</span>
            {m.title && <span className="text-ink-primary">· {m.title}</span>}
            {m.pinned && <span className="text-warning">📌 置顶</span>}
            <span className="text-ink-muted ml-auto">
              重要度 {m.importance}/10 · 命中 {m.hit_count} 次 · {new Date(m.created_at).toLocaleDateString("zh-CN")}
            </span>
          </div>
          <div className="text-sm text-ink-primary whitespace-pre-wrap">{m.content}</div>
        </div>
        <div className="flex flex-col gap-1">
          <button onClick={onPin} className="p-1.5 hover:bg-surface-overlay rounded" title={m.pinned ? "取消置顶" : "置顶"}>
            {m.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
          </button>
          <button onClick={onEdit} className="p-1.5 hover:bg-surface-overlay rounded" title="编辑">
            <Edit3 className="w-4 h-4" />
          </button>
          <button onClick={onDelete} className="p-1.5 hover:bg-danger/30 rounded text-danger" title="删除">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function MemoryEditor({ initial, onClose, onSaved }: {
  initial: Memory | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState(initial?.type || "preference");
  const [title, setTitle] = useState(initial?.title || "");
  const [content, setContent] = useState(initial?.content || "");
  const [importance, setImportance] = useState(initial?.importance || 5);
  const [pinned, setPinned] = useState(initial?.pinned || false);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!content.trim()) { alert("内容不能为空"); return; }
    setSaving(true);
    try {
      if (initial) {
        await authFetch(`${API}/memories/${initial.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, title: title || null, content, importance, pinned }),
        });
      } else {
        await authFetch(`${API}/memories`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, title: title || undefined, content, importance, pinned }),
        });
      }
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-surface-overlay border border-line rounded-xl w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{initial ? "编辑记忆" : "新增记忆"}</h2>
          <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary"><X className="w-5 h-5" /></button>
        </div>
        <div>
          <label className="text-xs text-ink-secondary">类型</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className="w-full px-3 py-2 mt-1 bg-surface-base border border-line rounded text-sm">
            {ALL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-ink-secondary">标题 (可选)</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full px-3 py-2 mt-1 bg-surface-base border border-line rounded text-sm" />
        </div>
        <div>
          <label className="text-xs text-ink-secondary">内容</label>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={5} className="w-full px-3 py-2 mt-1 bg-surface-base border border-line rounded text-sm" />
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-ink-secondary">重要度</label>
          <input type="range" min={1} max={10} value={importance} onChange={(e) => setImportance(parseInt(e.target.value))} className="flex-1" />
          <span className="text-sm w-8 text-center">{importance}</span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
          📌 置顶 (始终注入到 prompt)
        </label>
        <div className="flex gap-2 pt-2">
          <button onClick={onClose} className="flex-1 py-2 bg-surface-overlay hover:bg-surface-overlay rounded text-sm">取消</button>
          <button onClick={save} disabled={saving} className="flex-1 py-2 bg-primary hover:bg-primary disabled:opacity-50 rounded text-sm flex items-center justify-center gap-1">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSave, saving }: {
  profile: Profile;
  onSave: (patches: Partial<Profile>) => Promise<void>;
  saving: boolean;
}) {
  const [genres, setGenres] = useState((profile.preferred_genres || []).join(", "));
  const [forbidden, setForbidden] = useState((profile.forbidden_topics || []).join(", "));
  const [length, setLength] = useState<number | "">(profile.preferred_length || "");
  const [pace, setPace] = useState(profile.preferred_pace || "");
  const [style, setStyle] = useState(profile.style_summary || "");
  const [ci, setCi] = useState(profile.custom_instructions || "");
  const [memEnabled, setMemEnabled] = useState(profile.memory_enabled !== false);

  async function save() {
    await onSave({
      preferred_genres: genres.split(",").map(s => s.trim()).filter(Boolean),
      forbidden_topics: forbidden.split(",").map(s => s.trim()).filter(Boolean),
      preferred_length: length ? Number(length) : null,
      preferred_pace: pace || null,
      style_summary: style || null,
      custom_instructions: ci || null,
      memory_enabled: memEnabled,
    });
    alert("已保存");
  }

  return (
    <div className="bg-surface-base/40 rounded-lg border border-line p-5 space-y-4">
      <div>
        <label className="block text-sm font-semibold mb-1">📝 自定义指令 (Custom Instructions)</label>
        <p className="text-xs text-ink-secondary mb-2">每次对话都会注入到 system prompt 顶部, AI 必须遵守</p>
        <textarea value={ci} onChange={(e) => setCi(e.target.value)} rows={4} placeholder={`示例: 回答简短不要解释太多。不要用"她笑了笑"这种烂俗描写。`} className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-ink-secondary mb-1">偏好题材 (逗号分隔)</label>
          <input value={genres} onChange={(e) => setGenres(e.target.value)} placeholder="都市, 逆袭, 甜宠" className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm" />
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">忌讳话题 (逗号分隔)</label>
          <input value={forbidden} onChange={(e) => setForbidden(e.target.value)} placeholder="虐主, 悲剧, 校园" className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm" />
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">期望章节字数</label>
          <input type="number" value={length} onChange={(e) => setLength(e.target.value ? parseInt(e.target.value) : "")} placeholder="3000" className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm" />
        </div>
        <div>
          <label className="block text-xs text-ink-secondary mb-1">节奏偏好</label>
          <select value={pace} onChange={(e) => setPace(e.target.value)} className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm">
            <option value="">默认</option>
            <option value="fast">快节奏</option>
            <option value="medium">中等</option>
            <option value="slow">慢热</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs text-ink-secondary mb-1">风格摘要 (AI 自动提炼, 也可手改)</label>
        <textarea value={style} onChange={(e) => setStyle(e.target.value)} rows={2} className="w-full px-3 py-2 bg-surface-overlay border border-line rounded text-sm" />
      </div>

      <label className="flex items-center gap-2 p-3 bg-surface-overlay/40 rounded border border-line">
        <input type="checkbox" checked={memEnabled} onChange={(e) => setMemEnabled(e.target.checked)} />
        <span className="text-sm">
          <span className="font-semibold">启用记忆功能</span>
          <span className="text-xs text-ink-secondary block">关闭后, AI 不再读写任何长期记忆 / 不会基于过往对话学习偏好</span>
        </span>
      </label>

      <div className="text-xs text-ink-muted">
        累计草稿: {profile.total_drafts || 0} · 累计对话: {profile.total_chats || 0}
        {profile.last_summarized_at && <> · 上次抽取: {new Date(profile.last_summarized_at).toLocaleString("zh-CN")}</>}
      </div>

      <button onClick={save} disabled={saving} className="w-full py-2.5 bg-primary hover:bg-primary disabled:opacity-50 rounded font-medium flex items-center justify-center gap-2">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        保存所有设置
      </button>
    </div>
  );
}
