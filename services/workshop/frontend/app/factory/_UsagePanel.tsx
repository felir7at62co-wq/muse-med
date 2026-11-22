"use client";
import { useState, useEffect, useCallback } from "react";
import { Loader2, Coins, TrendingUp } from "lucide-react";
import { getToken } from "../../lib/auth";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer, LineChart, Line, Legend } from "recharts";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

// 阶段中文名；other = 阶段标记未生效时的兜底(旧任务)
const STAGE_LABELS: Record<string, string> = {
  brainstorm: "创意",
  outline: "大纲",
  check: "质检",
  script: "剧本",
  novel: "小说",
  tweet: "推文",
  other: "未标记",
};
const stageLabel = (s: string) => STAGE_LABELS[s] || s || "未标记";

function fmtDate(d: Date) { return d.toISOString().slice(0, 10); }

export function UsagePanel() {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });
  const today = new Date();
  const weekAgo = new Date(Date.now() - 6 * 864e5);
  const [start, setStart] = useState(fmtDate(weekAgo));
  const [end, setEnd] = useState(fmtDate(today));
  const [data, setData] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, sr] = await Promise.all([
        fetch(`${API}/usage-stats?start=${start}&end=${end}`, { headers: authHeaders() }),
        fetch(`${API}/stats/dashboard`, { headers: authHeaders() }),
      ]);
      if (r.ok) setData(await r.json());
      if (sr.ok) setTrend((await sr.json()).trend_7d || []);
    } catch {} finally { setLoading(false); }
  }, [start, end]);

  useEffect(() => { load(); }, [load]);

  const quickRange = (days: number) => {
    setStart(fmtDate(new Date(Date.now() - (days - 1) * 864e5)));
    setEnd(fmtDate(new Date()));
  };

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-line">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Coins className="w-5 h-5 text-amber-500" /> Token 用量统计
        </h2>
        <div className="flex items-center gap-2 text-sm">
          <button onClick={() => quickRange(1)} className="px-2 py-1 rounded border border-line hover:border-primary">今日</button>
          <button onClick={() => quickRange(7)} className="px-2 py-1 rounded border border-line hover:border-primary">7日</button>
          <button onClick={() => quickRange(30)} className="px-2 py-1 rounded border border-line hover:border-primary">30日</button>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="border border-line rounded px-2 py-1" />
          <span>~</span>
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="border border-line rounded px-2 py-1" />
        </div>
      </div>

      {loading || !data ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mb-4">
            <div className="p-3 bg-surface-elevated rounded-lg text-center">
              <div className="text-xl font-semibold">{((data.total?.total || 0) / 10000).toFixed(1)}万</div>
              <div className="text-xs text-ink-secondary">总Token</div>
            </div>
            <div className="p-3 bg-surface-elevated rounded-lg text-center">
              <div className="text-xl font-semibold">{((data.total?.prompt || 0) / 10000).toFixed(1)}万</div>
              <div className="text-xs text-ink-secondary">输入</div>
            </div>
            <div className="p-3 bg-surface-elevated rounded-lg text-center">
              <div className="text-xl font-semibold">{((data.total?.completion || 0) / 10000).toFixed(1)}万</div>
              <div className="text-xs text-ink-secondary">输出</div>
            </div>
            <div className="p-3 bg-surface-elevated rounded-lg text-center">
              <div className="text-xl font-semibold">{data.total?.calls || 0}</div>
              <div className="text-xs text-ink-secondary">调用次数</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <div className="text-sm font-medium mb-2">按日用量</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.by_day || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" style={{ fontSize: 11 }} />
                  <YAxis style={{ fontSize: 11 }} tickFormatter={(v: number) => (v / 10000).toFixed(0) + "万"} />
                  <ChartTooltip formatter={(v: any) => [(Number(v) / 10000).toFixed(2) + " 万", "tokens"]} />
                  <Bar dataKey="tokens" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="text-sm font-medium mb-2 flex items-center gap-1">
                <TrendingUp className="w-3.5 h-3.5 text-blue-500" />7日任务趋势
              </div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="date" style={{ fontSize: 11 }} />
                  <YAxis style={{ fontSize: 11 }} />
                  <ChartTooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="jobs" stroke="#3b82f6" strokeWidth={2} name="任务数" dot={false} />
                  <Line type="monotone" dataKey="success_rate" stroke="#10b981" strokeWidth={2} name="成功率%" dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-4">
              <div>
                <div className="text-sm font-medium mb-2">按阶段</div>
                <table className="w-full text-xs">
                  <thead><tr className="text-ink-secondary text-left border-b border-line">
                    <th className="font-normal py-1">阶段</th>
                    <th className="font-normal py-1 text-right">tokens</th>
                    <th className="font-normal py-1 text-right">占比</th>
                  </tr></thead>
                  <tbody>
                    {(data.by_stage || []).map((s: any) => (
                      <tr key={s.stage} className="border-b border-slate-50">
                        <td className="py-1">{stageLabel(s.stage)}</td>
                        <td className="py-1 text-right font-mono">{((s.tokens || 0) / 10000).toFixed(1)}万</td>
                        <td className="py-1 text-right text-ink-secondary">
                          {data.total?.total ? ((s.tokens / data.total.total) * 100).toFixed(0) : 0}%
                        </td>
                      </tr>
                    ))}
                    {(data.by_stage || []).length === 0 && (
                      <tr><td colSpan={3} className="py-3 text-center text-ink-secondary">暂无数据</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">按模型</div>
                <table className="w-full text-xs">
                  <thead><tr className="text-ink-secondary text-left border-b border-line">
                    <th className="font-normal py-1">模型</th>
                    <th className="font-normal py-1 text-right">tokens</th>
                    <th className="font-normal py-1 text-right">占比</th>
                  </tr></thead>
                  <tbody>
                    {(data.by_provider || []).map((p: any) => (
                      <tr key={p.provider} className="border-b border-slate-50">
                        <td className="py-1">{p.provider}</td>
                        <td className="py-1 text-right font-mono">{((p.tokens || 0) / 10000).toFixed(1)}万</td>
                        <td className="py-1 text-right text-ink-secondary">
                          {data.total?.total ? ((p.tokens / data.total.total) * 100).toFixed(0) : 0}%
                        </td>
                      </tr>
                    ))}
                    {(data.by_provider || []).length === 0 && (
                      <tr><td colSpan={3} className="py-3 text-center text-ink-secondary">暂无数据</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
        </>
      )}
    </div>
  );
}
