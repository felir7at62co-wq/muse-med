'use client';

import React, { useEffect, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { useToast } from '@/components/ui/Toast';
import {
  getMySummary, getMyRecords, getPricing,
  modelLabel, yuan,
  type BillingSummary, type BillingRecord, type PricingRule,
} from '@/lib/billing';

export default function BillingPage() {
  const toast = useToast();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [records, setRecords] = useState<BillingRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const pageSize = 50;

  const load = async (p: number) => {
    setLoading(true);
    try {
      const [s, r, pr] = await Promise.all([
        getMySummary(),
        getMyRecords(pageSize, p * pageSize),
        getPricing().catch(() => ({ currency: 'CNY', rules: [] })),
      ]);
      setSummary(s);
      setRecords(r.items);
      setTotal(r.total);
      setRules(pr.rules);
    } catch (e) {
      toast.error(`加载失败: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(page); /* eslint-disable-next-line */ }, [page]);

  const fmtTime = (s?: string | null) => (s ? new Date(s).toLocaleString('zh-CN') : '-');
  const fmtQty = (r: BillingRecord) =>
    r.unit === '小时' ? `${(r.quantity || 0).toFixed(3)} 小时` : `${r.quantity} 张`;

  return (
    <AppShell fluid>
      <div className="w-full max-w-5xl mx-auto">
        <div className="mb-4">
          <h1 className="text-title font-semibold">我的费用</h1>
          <p className="text-caption text-muted-foreground mt-1">
            生图与高清放大的估算消费记录（人民币，估算价，仅供参考）。
          </p>
        </div>

        {/* 汇总卡片 */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="rounded-lg border border-line bg-white/[0.02] p-4">
            <div className="text-caption text-muted-foreground">累计费用</div>
            <div className="text-title font-semibold mt-1">{yuan(summary?.total_amount || 0)}</div>
          </div>
          <div className="rounded-lg border border-line bg-white/[0.02] p-4">
            <div className="text-caption text-muted-foreground">计费任务数</div>
            <div className="text-title font-semibold mt-1">{summary?.total_count || 0}</div>
          </div>
          <div className="rounded-lg border border-line bg-white/[0.02] p-4">
            <div className="text-caption text-muted-foreground">按模型</div>
            <div className="mt-1 space-y-0.5">
              {(summary?.by_model || []).length === 0 && (
                <div className="text-body text-muted-foreground">暂无</div>
              )}
              {(summary?.by_model || []).map((m) => (
                <div key={m.model} className="flex justify-between text-body">
                  <span className="text-ink-secondary">{modelLabel(m.model)}</span>
                  <span>{yuan(m.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 计费规则 */}
        {rules.length > 0 && (
          <div className="rounded-lg border border-line bg-white/[0.02] p-4 mb-6">
            <div className="text-card-title font-medium mb-2">计费规则（估算）</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
              {rules.map((r, i) => (
                <div key={i} className="flex justify-between text-body">
                  <span className="text-ink-secondary">{modelLabel(r.model)} · {r.desc}</span>
                  <span>{yuan(r.price)} / {r.unit}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 明细表 */}
        <div className="rounded-lg border border-line overflow-hidden">
          <table className="w-full text-body">
            <thead className="bg-white/[0.03] text-caption text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2">时间</th>
                <th className="text-left px-3 py-2">类型</th>
                <th className="text-left px-3 py-2">模型</th>
                <th className="text-right px-3 py-2">用量</th>
                <th className="text-right px-3 py-2">单价</th>
                <th className="text-right px-3 py-2">金额</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">加载中…</td></tr>
              )}
              {!loading && records.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">暂无消费记录</td></tr>
              )}
              {!loading && records.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="px-3 py-2 text-ink-secondary">{fmtTime(r.created_at)}</td>
                  <td className="px-3 py-2">{r.kind === 'upscale' ? '高清放大' : '生成'}</td>
                  <td className="px-3 py-2">{modelLabel(r.model)}</td>
                  <td className="px-3 py-2 text-right">{fmtQty(r)}</td>
                  <td className="px-3 py-2 text-right">{yuan(r.unit_price)}/{r.unit}</td>
                  <td className="px-3 py-2 text-right font-medium">{yuan(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 分页 */}
        {total > pageSize && (
          <div className="flex items-center justify-between mt-3 text-body">
            <span className="text-muted-foreground">共 {total} 条</span>
            <div className="flex gap-2">
              <button
                className="px-3 py-1 rounded border border-line disabled:opacity-40"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >上一页</button>
              <button
                className="px-3 py-1 rounded border border-line disabled:opacity-40"
                disabled={(page + 1) * pageSize >= total}
                onClick={() => setPage((p) => p + 1)}
              >下一页</button>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}