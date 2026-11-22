"use client";
/**
 * 飞书批量反推弹窗 (A线)。
 *
 * 打开即自动加载默认飞书表(短剧链接库)里「有链接、未反推」的行,
 * 用户勾选/全选后一键执行: TikHub取直链 → 豆包反推 → 回写飞书「文本」列。
 * 后台跑, 弹窗内轮询进度。无需用户输入任何地址。
 */
import { useEffect, useRef, useState } from "react";
import { authFetch } from "../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Candidate = { record_id: string; url: string };
type Job = {
  id: number; status: string; progress: number; error?: string;
  total: number; done: number; ok: number; skip: number; fail: number;
};

const TERMINAL = ["succeeded", "partial_failed", "failed"];

async function api(path: string, opts: RequestInit = {}) {
  const r = await authFetch(`${BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

export default function FeishuReverseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [loading, setLoading] = useState(false);
  const [cands, setCands] = useState<Candidate[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [meta, setMeta] = useState<{ total: number; done: number; pending: number } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<any>(null);

  const load = async () => {
    setErr(""); setLoading(true); setJob(null);
    try {
      const r = await api(`/v1/frontcut/feishu-reverse/candidates`);
      setCands(r.candidates || []);
      setMeta({ total: r.total, done: r.done, pending: r.pending });
      // 默认全选
      const init: Record<string, boolean> = {};
      (r.candidates || []).forEach((c: Candidate) => { init[c.record_id] = true; });
      setChecked(init);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (open) load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const checkedIds = () => cands.map((c) => c.record_id).filter((id) => checked[id]);
  const allChecked = cands.length > 0 && cands.every((c) => checked[c.record_id]);
  const toggleAll = () => {
    const next: Record<string, boolean> = {};
    cands.forEach((c) => { next[c.record_id] = !allChecked; });
    setChecked(next);
  };

  const startPoll = (jid: number) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const j = await api(`/v1/frontcut/feishu-reverse/jobs/${jid}`);
        setJob(j);
        if (TERMINAL.includes(j.status)) clearInterval(pollRef.current);
      } catch { /* ignore */ }
    }, 4000);
  };

  const run = async () => {
    const ids = checkedIds();
    if (ids.length === 0) { setErr("请至少勾选一条"); return; }
    setErr(""); setBusy(true);
    try {
      const r = await api(`/v1/frontcut/feishu-reverse`, {
        method: "POST",
        body: JSON.stringify({ record_ids: ids }),
      });
      const j = await api(`/v1/frontcut/feishu-reverse/jobs/${r.job_id}`);
      setJob(j); startPoll(r.job_id);
    } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 620, maxWidth: "92vw", maxHeight: "86vh", background: "#fff", borderRadius: 12,
        padding: 20, display: "flex", flexDirection: "column", boxShadow: "0 10px 40px rgba(0,0,0,.2)",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>飞书批量反推 (A线)</h2>
          <button onClick={onClose} style={{ border: 0, background: "transparent", fontSize: 20, cursor: "pointer", color: "#888" }}>×</button>
        </div>
        <p style={{ color: "#666", fontSize: 12.5, marginTop: 4 }}>
          默认短剧链接库中「有链接、未反推」的条目。勾选后执行: 抖音直链 → 豆包反推 → 回写「文本」列。
        </p>

        {meta && (
          <div style={{ fontSize: 12.5, color: "#555", margin: "8px 0", display: "flex", gap: 16 }}>
            <span>表内总计 {meta.total}</span>
            <span style={{ color: "#16a34a" }}>已反推 {meta.done}</span>
            <span style={{ color: "#2563eb" }}>待反推 {meta.pending}</span>
          </div>
        )}

        {err && <div style={{ color: "#dc2626", fontSize: 13, margin: "6px 0" }}>错误: {err}</div>}

        {/* 进度(执行后显示) */}
        {job && (
          <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 13, color: "#555" }}>
              任务 #{job.id} · <b>{job.status}</b> · {job.progress}%{job.error ? ` · ${job.error}` : ""}
            </div>
            <div style={{ height: 8, background: "#f0f0f0", borderRadius: 4, marginTop: 8, overflow: "hidden" }}>
              <div style={{
                width: `${job.progress}%`, height: "100%",
                background: job.status === "failed" ? "#dc2626" : job.status === "partial_failed" ? "#f59e0b" : "#16a34a",
                transition: "width .4s",
              }} />
            </div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 6, display: "flex", gap: 14 }}>
              <span>处理 {job.done}/{job.total}</span>
              <span style={{ color: "#16a34a" }}>成功 {job.ok}</span>
              <span style={{ color: "#888" }}>跳过 {job.skip}</span>
              <span style={{ color: "#dc2626" }}>失败 {job.fail}</span>
            </div>
            {TERMINAL.includes(job.status) && (
              <div style={{ marginTop: 8, fontSize: 12.5, color: "#16a34a" }}>
                ✅ 已结束, 反推结果已回写飞书。可关闭或重新加载列表。
              </div>
            )}
          </div>
        )}

        {/* 列表 */}
        {!job && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
              <label style={{ fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" checked={allChecked} onChange={toggleAll} disabled={loading || cands.length === 0} />
                全选 ({checkedIds().length}/{cands.length})
              </label>
              <button onClick={load} disabled={loading}
                style={{ marginLeft: "auto", fontSize: 12, color: "#2563eb", background: "transparent", border: 0, cursor: "pointer" }}>
                {loading ? "加载中…" : "刷新列表"}
              </button>
            </div>
            <div style={{ flex: 1, overflow: "auto", border: "1px solid #eee", borderRadius: 8 }}>
              {loading ? (
                <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 13 }}>加载中…</div>
              ) : cands.length === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#999", fontSize: 13 }}>没有待反推的条目 🎉</div>
              ) : (
                cands.map((c, i) => (
                  <label key={c.record_id} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                    borderBottom: "1px solid #f5f5f5", cursor: "pointer", fontSize: 12.5,
                  }}>
                    <input type="checkbox" checked={!!checked[c.record_id]}
                      onChange={() => setChecked((p) => ({ ...p, [c.record_id]: !p[c.record_id] }))} />
                    <span style={{ color: "#aaa", width: 28 }}>{i + 1}</span>
                    <span style={{ color: "#333", wordBreak: "break-all" }}>{c.url}</span>
                  </label>
                ))
              )}
            </div>
          </>
        )}

        {/* 操作 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
          <button onClick={onClose}
            style={{ padding: "8px 18px", background: "#f0f0f0", color: "#333", border: 0, borderRadius: 6, cursor: "pointer" }}>
            {job && TERMINAL.includes(job.status) ? "关闭" : "取消"}
          </button>
          {!job && (
            <button onClick={run} disabled={busy || loading || checkedIds().length === 0}
              style={{
                padding: "8px 22px", background: checkedIds().length ? "#16a34a" : "#9ca3af",
                color: "#fff", border: 0, borderRadius: 6, cursor: checkedIds().length ? "pointer" : "not-allowed",
              }}>
              {busy ? "启动中…" : `反推选中 (${checkedIds().length})`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}