"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, ArrowLeft, RotateCcw, AlertTriangle, Loader2 } from "lucide-react";
import { authFetch, getUser } from "../../lib/auth";
import { UserNav } from "../_UserNav";
import { confirmAsync, notifySuccess, notifyError } from "@/lib/dialog";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

export default function TrashPage() {
  const router = useRouter();
  if (typeof window !== "undefined" && !getUser()) {
    window.location.href = "/login";
    return null;
  }

  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchTrash() {
    setLoading(true);
    try {
      const res = await authFetch(`${BASE}/v1/trash`);
      if (res.ok) setItems(await res.json());
    } finally { setLoading(false); }
  }

  useEffect(() => { fetchTrash(); }, []);

  async function restore(id: number) {
    const res = await authFetch(`${BASE}/v1/trash/${id}/restore`, { method: "POST" });
    if (res.ok) fetchTrash();
  }

  async function permaDelete(id: number) {
    const ok = await confirmAsync({
      title: "彻底删除",
      description: "彻底删除后无法恢复，确认继续？",
      confirmText: "彻底删除",
      cancelText: "取消",
      tone: "danger",
    });
    if (!ok) return;
    const res = await authFetch(`${BASE}/v1/trash/${id}/permanent`, { method: "DELETE" });
    if (res.ok) {
      notifySuccess("已彻底删除");
      fetchTrash();
    } else {
      notifyError(`删除失败 (${res.status})`);
    }
  }

  return (
    <>
      <div className="fixed top-3 right-4 z-30"><UserNav /></div>
      <div className="min-h-screen bg-surface-base text-ink-primary p-8">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-center gap-3 mb-6">
            <button onClick={() => router.push("/drafts")} className="p-2 hover:bg-surface-base rounded-lg">
              <ArrowLeft className="w-5 h-5" />
            </button>
            <h1 className="text-2xl font-bold"><Trash2 className="inline w-6 h-6 mr-2" />回收站</h1>
            <span className="text-ink-secondary text-sm">{items.length}个项目</span>
          </div>

          <div className="bg-warning/15 border border-warning/50 text-warning text-sm rounded-lg p-3 mb-4 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>回收站内的草稿保留30天后自动清除。可随时恢复或彻底删除。</span>
          </div>

          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="p-4 bg-surface-base/50 border border-line rounded-xl animate-pulse"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 space-y-2">
                      <div className="h-4 bg-surface-overlay rounded w-2/5" />
                      <div className="h-3 bg-surface-overlay/70 rounded w-3/4" />
                      <div className="h-3 bg-surface-overlay/50 rounded w-1/3" />
                    </div>
                    <div className="w-16 h-7 bg-surface-overlay/60 rounded" />
                    <div className="w-20 h-7 bg-surface-overlay/60 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center text-ink-secondary py-20">
              <img
                src="/brand/empty-trash.webp"
                alt=""
                className="w-40 h-28 object-contain mx-auto mb-4 select-none"
              />
              <p>回收站是空的</p>
              <p className="text-xs text-ink-muted mt-1">删除的草稿会在 30 天后自动清理</p>
            </div>
          ) : (
            <div className="space-y-2">
              {items.map((d) => (
                <div key={d.id} className="p-4 bg-surface-base/50 border border-line rounded-xl flex items-center gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{d.title || "(未命名)"}</h3>
                      {(() => {
                        if (!d.deleted_at) return null;
                        const elapsedMs = Date.now() - new Date(d.deleted_at).getTime();
                        const remainingDays = Math.max(0, Math.ceil(30 - elapsedMs / 86400000));
                        const tone =
                          remainingDays >= 14
                            ? "bg-surface-overlay/50 text-ink-secondary border-line"
                            : remainingDays >= 7
                              ? "bg-warning/15 text-warning border-warning/50"
                              : remainingDays >= 1
                                ? "bg-danger/15 text-danger border-danger/50"
                                : "bg-danger/30 text-danger border-danger animate-pulse";
                        const label = remainingDays === 0 ? "今天清理" : `还剩 ${remainingDays} 天`;
                        return (
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border ${tone}`}>
                            ⏳ {label}
                          </span>
                        );
                      })()}
                    </div>
                    <p className="text-ink-secondary text-xs line-clamp-1 mt-1">{d.user_input}</p>
                    <p className="text-ink-muted text-xs mt-1">删除于: {d.deleted_at ? new Date(d.deleted_at).toLocaleString("zh-CN") : "-"}</p>
                  </div>
                  <button onClick={() => restore(d.id)} className="flex items-center gap-1 px-3 py-1.5 bg-success hover:bg-success/90 rounded text-sm">
                    <RotateCcw className="w-4 h-4" />恢复
                  </button>
                  <button onClick={() => permaDelete(d.id)} className="flex items-center gap-1 px-3 py-1.5 bg-danger hover:bg-danger/90 rounded text-sm text-white">
                    <Trash2 className="w-4 h-4" />彻底删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
