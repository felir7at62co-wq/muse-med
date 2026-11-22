"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Library, Search } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { getToken } from "../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

const TYPE_META: Record<string, { label: string; badge: string }> = {
  script: { label: "剧本", badge: "bg-blue-500" },
  novel: { label: "小说", badge: "bg-purple-500" },
  tweet: { label: "推文", badge: "bg-amber-500" },
};

export function LibraryPanel() {
  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [ptype, setPtype] = useState("");
  const [q, setQ] = useState("");
  const [distributed, setDistributed] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (ptype) params.set("ptype", ptype);
      if (q) params.set("q", q);
      if (distributed) params.set("distributed", distributed);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const r = await fetch(`${API}/library?${params}`, { headers: authHeaders() });
      if (r.ok) {
        const d = await r.json();
        setItems(d.items || []);
        setTotal(d.total || 0);
      }
    } catch {} finally { setLoading(false); }
  }, [ptype, q, distributed, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-line">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Library className="w-5 h-5 text-primary" /> 剧本总库
          <span className="text-sm font-normal text-ink-secondary">({total})</span>
        </h2>
        <div className="flex items-center gap-2 flex-wrap">
          {["", "script", "novel", "tweet"].map((t) => (
            <button key={t} onClick={() => { setPtype(t); setPage(0); }}
              className={`px-3 py-1 rounded-full text-sm border ${ptype === t ? "bg-primary text-white border-primary" : "border-line text-ink-secondary hover:border-primary"}`}>
              {t === "" ? "全部" : TYPE_META[t].label}
            </button>
          ))}
          <select className="border border-line rounded-full px-3 py-1 text-sm" value={distributed} onChange={(e) => { setDistributed(e.target.value); setPage(0); }}>
            <option value="">分发状态</option>
            <option value="yes">已分发</option>
            <option value="no">未分发</option>
          </select>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-secondary" />
            <input className="border border-line rounded-full pl-8 pr-3 py-1 text-sm w-44" placeholder="搜索标题..."
              value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-secondary border-b border-line">
                <th className="py-2 pr-3">标题</th>
                <th className="py-2 pr-3">类型</th>
                <th className="py-2 pr-3">题材/来源</th>
                <th className="py-2 pr-3">进度</th>
                <th className="py-2 pr-3">字数</th>
                <th className="py-2 pr-3">分发</th>
                <th className="py-2">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((p) => (
                <tr key={p.id} className="hover:bg-surface-elevated">
                  <td className="py-2 pr-3 font-medium max-w-[240px] truncate">{p.title}</td>
                  <td className="py-2 pr-3">
                    <Badge className={`${TYPE_META[p.product_type]?.badge || "bg-gray-500"} text-white text-xs`}>
                      {TYPE_META[p.product_type]?.label || p.product_type}
                    </Badge>
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-secondary max-w-[200px] truncate">
                    {p.product_type === "script" ? (p.genre || "-") : (p.source_label ? `源: ${p.source_label}` : "-")}
                  </td>
                  <td className="py-2 pr-3 text-xs">
                    <span className={p.completed_episodes < p.episodes ? "text-orange-600" : "text-green-600"}>
                      {p.completed_episodes ?? 0}/{p.episodes ?? "?"}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-secondary">{p.words ? (p.words / 10000).toFixed(1) + "万" : "-"}</td>
                  <td className="py-2 pr-3 text-xs">
                    {(p.distributed_to || []).length > 0
                      ? <span className="text-green-600">✓ {p.distributed_to.join("、")}</span>
                      : <span className="text-gray-400">未分发</span>}
                  </td>
                  <td className="py-2">
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => router.push(`/factory/jobs/${p.job_id}`)}>任务</Button>
                      <Button size="sm" variant="ghost" onClick={() => router.push(`/factory/products/${p.id}`)}>追溯</Button>
                    </div>
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr><td colSpan={7} className="py-8 text-center text-ink-secondary">暂无产物</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3 mt-4 text-sm">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</Button>
          <span className="text-ink-secondary">{page + 1} / {Math.ceil(total / PAGE_SIZE)}</span>
          <Button size="sm" variant="outline" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>
      )}
    </div>
  );
}
