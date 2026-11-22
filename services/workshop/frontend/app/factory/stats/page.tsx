"use client";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken } from "../../../lib/auth";
import { UserNav } from "../../_UserNav";
import {
  ArrowLeft, BarChart3, Loader2, TrendingUp, TrendingDown,
  Zap, CheckCircle, XCircle, Clock, Download
} from "lucide-react";
import { Button, Card, Tabs } from "@/components/ui";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  Legend, ResponsiveContainer, Area, AreaChart
} from "recharts";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

type GlobalStats = {
  total_jobs: number;
  total_products: number;
  total_tokens: number;
  total_cost: number;
  avg_success_rate: number;
  avg_duration: number;
};

type TrendData = {
  date: string;
  jobs: number;
  success_rate: number;
  tokens: number;
  products: number;
};

type TypeStats = {
  job_type: string;
  total: number;
  succeeded: number;
  failed: number;
  avg_duration: number;
  avg_tokens: number;
};

type TopTheme = {
  theme: string;
  count: number;
  success_rate: number;
};

type FailureReason = {
  reason: string;
  count: number;
  percentage: number;
};

const JOB_TYPE_LABELS: Record<string, string> = {
  create_spawn: "从零创作",
  import_spawn: "导入剧本",
  batch_to_video: "批量转视频",
};

const CHART_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

export default function StatsPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/jubengongfang/login?from=/factory/stats";
      return null;
    }
  }

  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("30d");

  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [trendData, setTrendData] = useState<TrendData[]>([]);
  const [typeStats, setTypeStats] = useState<TypeStats[]>([]);
  const [topThemes, setTopThemes] = useState<TopTheme[]>([]);
  const [failureReasons, setFailureReasons] = useState<FailureReason[]>([]);

  // 加载统计数据
  const loadStats = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const r = await fetch(`${API}/stats?range=${timeRange}`, {
        headers: authHeaders(),
      });

      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const data = await r.json();
      setGlobalStats(data.global);
      setTrendData(data.trend || []);
      setTypeStats(data.by_type || []);
      setTopThemes(data.top_themes || []);
      setFailureReasons(data.failure_reasons || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // 导出报告
  const handleExport = () => {
    const report = {
      generated_at: new Date().toISOString(),
      time_range: timeRange,
      global_stats: globalStats,
      trend_data: trendData,
      type_stats: typeStats,
      top_themes: topThemes,
      failure_reasons: failureReasons,
    };

    const dataStr = JSON.stringify(report, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `factory-stats-${timeRange}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !globalStats) {
    return (
      <div className="flex h-screen items-center justify-center bg-surface-base">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-surface-base">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部导航 */}
        <header className="h-topbar border-b border-line flex items-center justify-between px-6 bg-surface-elevated">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/factory")}
              className="gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </Button>
            <div className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">数据统计</h1>
            </div>
          </div>
          <UserNav />
        </header>

        {/* 主体内容 */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-7xl mx-auto space-y-6">
            {/* 时间范围选择和导出 */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setTimeRange("7d")}
                  className={`px-4 py-2 rounded-md transition-colors ${
                    timeRange === "7d"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated hover:bg-surface-elevated/80"
                  }`}
                >
                  近7天
                </button>
                <button
                  onClick={() => setTimeRange("30d")}
                  className={`px-4 py-2 rounded-md transition-colors ${
                    timeRange === "30d"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated hover:bg-surface-elevated/80"
                  }`}
                >
                  近30天
                </button>
                <button
                  onClick={() => setTimeRange("90d")}
                  className={`px-4 py-2 rounded-md transition-colors ${
                    timeRange === "90d"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated hover:bg-surface-elevated/80"
                  }`}
                >
                  近90天
                </button>
              </div>

              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="w-4 h-4 mr-1" />
                导出报告
              </Button>
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {error}
              </div>
            )}

            {/* 全局统计卡片 */}
            {globalStats && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink-secondary">总任务数</p>
                      <p className="text-3xl font-bold mt-2">
                        {globalStats.total_jobs.toLocaleString()}
                      </p>
                    </div>
                    <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center">
                      <BarChart3 className="w-6 h-6 text-blue-600" />
                    </div>
                  </div>
                </Card>

                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink-secondary">总产物数</p>
                      <p className="text-3xl font-bold mt-2">
                        {globalStats.total_products.toLocaleString()}
                      </p>
                    </div>
                    <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center">
                      <CheckCircle className="w-6 h-6 text-green-600" />
                    </div>
                  </div>
                </Card>

                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink-secondary">平均成功率</p>
                      <p className="text-3xl font-bold mt-2 flex items-center gap-2">
                        {globalStats.avg_success_rate.toFixed(1)}%
                        {globalStats.avg_success_rate >= 80 ? (
                          <TrendingUp className="w-5 h-5 text-green-600" />
                        ) : (
                          <TrendingDown className="w-5 h-5 text-red-600" />
                        )}
                      </p>
                    </div>
                    <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center">
                      <TrendingUp className="w-6 h-6 text-purple-600" />
                    </div>
                  </div>
                </Card>

                <Card className="p-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-ink-secondary">Token消耗</p>
                      <p className="text-3xl font-bold mt-2">
                        {(globalStats.total_tokens / 1000000).toFixed(1)}M
                      </p>
                      <p className="text-xs text-ink-secondary mt-1">
                        成本: ¥{globalStats.total_cost.toFixed(2)}
                      </p>
                    </div>
                    <div className="w-12 h-12 rounded-full bg-yellow-100 flex items-center justify-center">
                      <Zap className="w-6 h-6 text-yellow-600" />
                    </div>
                  </div>
                </Card>
              </div>
            )}

            {/* 任务量趋势 */}
            {trendData.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">任务量趋势</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" style={{ fontSize: 12 }} />
                    <YAxis style={{ fontSize: 12 }} />
                    <ChartTooltip />
                    <Legend />
                    <Area
                      type="monotone"
                      dataKey="jobs"
                      stroke="#3b82f6"
                      fill="#3b82f6"
                      fillOpacity={0.3}
                      name="任务数"
                    />
                    <Area
                      type="monotone"
                      dataKey="products"
                      stroke="#10b981"
                      fill="#10b981"
                      fillOpacity={0.3}
                      name="产物数"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* 成功率趋势 */}
            {trendData.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">成功率趋势</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" style={{ fontSize: 12 }} />
                    <YAxis domain={[0, 100]} style={{ fontSize: 12 }} />
                    <ChartTooltip />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="success_rate"
                      stroke="#10b981"
                      strokeWidth={2}
                      name="成功率%"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* Token消耗趋势 */}
            {trendData.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">Token消耗趋势</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" style={{ fontSize: 12 }} />
                    <YAxis style={{ fontSize: 12 }} />
                    <ChartTooltip />
                    <Legend />
                    <Bar dataKey="tokens" fill="#f59e0b" name="Token消耗" />
                  </BarChart>
                </ResponsiveContainer>
              </Card>
            )}

            {/* 各类型任务统计 */}
            {typeStats.length > 0 && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Card className="p-6">
                  <h3 className="text-lg font-semibold mb-4">任务类型分布</h3>
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie
                        data={typeStats}
                        dataKey="total"
                        nameKey="job_type"
                        cx="50%"
                        cy="50%"
                        outerRadius={80}
                        label={(entry: any) =>
                          `${JOB_TYPE_LABELS[entry.job_type]} (${entry.total})`
                        }
                      >
                        {typeStats.map((entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={CHART_COLORS[index % CHART_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <ChartTooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </Card>

                <Card className="p-6">
                  <h3 className="text-lg font-semibold mb-4">各类型效率对比</h3>
                  <ResponsiveContainer width="100%" height={250}>
                    <BarChart data={typeStats}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis
                        dataKey="job_type"
                        tickFormatter={(value: any) => JOB_TYPE_LABELS[value] || value}
                        style={{ fontSize: 12 }}
                      />
                      <YAxis style={{ fontSize: 12 }} />
                      <ChartTooltip
                        labelFormatter={(value: any) => JOB_TYPE_LABELS[value] || value}
                      />
                      <Legend />
                      <Bar dataKey="avg_duration" fill="#8b5cf6" name="平均耗时(分钟)" />
                    </BarChart>
                  </ResponsiveContainer>
                </Card>
              </div>
            )}

            {/* 详细类型统计表格 */}
            {typeStats.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">类型详细统计</h3>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="border-b border-line">
                      <tr className="text-left">
                        <th className="pb-3 font-medium">类型</th>
                        <th className="pb-3 font-medium text-right">总数</th>
                        <th className="pb-3 font-medium text-right">成功</th>
                        <th className="pb-3 font-medium text-right">失败</th>
                        <th className="pb-3 font-medium text-right">成功率</th>
                        <th className="pb-3 font-medium text-right">平均耗时</th>
                        <th className="pb-3 font-medium text-right">平均Token</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typeStats.map((stat) => {
                        const successRate =
                          stat.total > 0 ? (stat.succeeded / stat.total) * 100 : 0;
                        return (
                          <tr key={stat.job_type} className="border-b border-line">
                            <td className="py-3">
                              {JOB_TYPE_LABELS[stat.job_type] || stat.job_type}
                            </td>
                            <td className="py-3 text-right">{stat.total}</td>
                            <td className="py-3 text-right text-green-600">
                              {stat.succeeded}
                            </td>
                            <td className="py-3 text-right text-red-600">
                              {stat.failed}
                            </td>
                            <td className="py-3 text-right">{successRate.toFixed(1)}%</td>
                            <td className="py-3 text-right">{stat.avg_duration}分钟</td>
                            <td className="py-3 text-right">
                              {stat.avg_tokens.toLocaleString()}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* 热门主题 */}
            {topThemes.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">热门创作主题 Top 10</h3>
                <div className="space-y-3">
                  {topThemes.map((theme, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 border border-line rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center font-semibold text-primary">
                          {index + 1}
                        </div>
                        <span className="font-medium">{theme.theme}</span>
                      </div>
                      <div className="flex items-center gap-4 text-sm">
                        <span className="text-ink-secondary">
                          使用 {theme.count} 次
                        </span>
                        <span
                          className={
                            theme.success_rate >= 80
                              ? "text-green-600"
                              : "text-yellow-600"
                          }
                        >
                          成功率 {theme.success_rate.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* 失败原因分析 */}
            {failureReasons.length > 0 && (
              <Card className="p-6">
                <h3 className="text-lg font-semibold mb-4">失败原因分析</h3>
                <div className="space-y-3">
                  {failureReasons.map((reason, index) => (
                    <div key={index} className="space-y-2">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">{reason.reason}</span>
                        <span className="text-ink-secondary">
                          {reason.count} 次 ({reason.percentage.toFixed(1)}%)
                        </span>
                      </div>
                      <div className="w-full bg-surface-elevated rounded-full h-2">
                        <div
                          className="bg-red-500 h-2 rounded-full"
                          style={{ width: `${reason.percentage}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
