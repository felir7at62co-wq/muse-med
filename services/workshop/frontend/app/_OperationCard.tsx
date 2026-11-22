"use client";
import { useState } from "react";
import { Loader2, Check, X, Undo2, AlertTriangle, FileText, Lock } from "lucide-react";
import { getToken } from "@/lib/auth";

const API_BASE = (process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "") + "/v1/agent";

export type OpStatus = "pending" | "confirmed" | "rejected" | "rolled_back" | "expired" | "failed";

export interface AgentOperation {
  id: number;
  op_type: string;
  label: string;
  target_draft_id?: number | null;
  target_chapter_order?: number | null;
  target_field?: string | null;
  payload: any;
  status: OpStatus;
  confidence?: number;
  affected_chars?: number;
  cascade_warnings?: string[];
  reversible?: boolean;
  expires_at?: string | null;
  applied_at?: string | null;
  rolled_back_at?: string | null;
  created_at?: string;
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-warning/15 text-warning border-warning/40",
  confirmed: "bg-success/15 text-success border-success/40",
  rejected: "bg-surface-base text-ink-secondary border-line",
  rolled_back: "bg-info/15 text-info border-info/40",
  expired: "bg-surface-base text-ink-secondary border-line",
  failed: "bg-danger/15 text-danger border-danger/40",
};
const STATUS_TEXT: Record<string, string> = {
  pending: "待确认", confirmed: "已应用", rejected: "已取消",
  rolled_back: "已撤销", expired: "已过期", failed: "失败",
};

function authHeaders(): Record<string, string> {
  // ⚠ 这里原先直接读 localStorage("auth_token") —— 键名写错了(真实键是
  // "drama_access_token", 见 lib/auth.ts), 于是**永远拿不到 token**, 确认/撤销
  // 操作全部匿名发出。以前后端这些端点没鉴权所以"能用", 现在补了鉴权就会 401。
  // 统一改走 getToken(), 键名只在 lib/auth.ts 里定义一次。
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function preview(s: any, n: number = 200): string {
  if (s == null) return "";
  if (typeof s === "object") {
    try { return JSON.stringify(s, null, 2).slice(0, n); } catch { return String(s).slice(0, n); }
  }
  return String(s).slice(0, n);
}

export function OperationCard({
  op,
  onUpdated,
}: {
  op: AgentOperation;
  onUpdated?: (newOp: AgentOperation) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const isPending = op.status === "pending";
  const isConfirmed = op.status === "confirmed";
  const newContent = op.payload?.new;
  const oldMatch = op.payload?.old_match;
  const highRisk = (op.affected_chars || 0) > 1000 || op.op_type === "replace_chapter";

  async function call(action: "confirm" | "reject" | "rollback") {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API_BASE}/operations/${op.id}/${action}`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(t.slice(0, 200) || `HTTP ${r.status}`);
      }
      // 刷新一次 op 状态
      const r2 = await fetch(`${API_BASE}/operations/${op.id}`, { headers: authHeaders() });
      if (r2.ok) {
        const fresh = await r2.json();
        onUpdated?.(fresh);
      }
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`my-2 rounded-lg border ${
      isPending ? "border-warning/40 bg-warning/5" :
      isConfirmed ? "border-success/30 bg-success/5" :
      "border-line-strong/40 bg-surface-base/40"
    } overflow-hidden`}>
      <div className="px-3 py-2 flex items-center gap-2 text-sm border-b border-line/40">
        <FileText className="w-4 h-4 text-primary" />
        <span className="font-semibold text-white">{op.label}</span>
        {op.target_chapter_order != null && (
          <span className="text-xs text-ink-secondary">第 {op.target_chapter_order} 章</span>
        )}
        {op.target_draft_id && (
          <span className="text-xs text-ink-muted">#{op.target_draft_id}</span>
        )}
        <span className={`ml-auto px-2 py-0.5 rounded text-xs border ${STATUS_BADGE[op.status] || STATUS_BADGE.pending}`}>
          {STATUS_TEXT[op.status] || op.status}
        </span>
      </div>

      <div className="px-3 py-2 space-y-2 text-xs">
        {op.confidence != null && (
          <div className="text-ink-secondary">
            置信度 {Math.round((op.confidence || 0) * 100)}%
            {op.affected_chars ? ` · 影响 ~${op.affected_chars} 字` : ""}
          </div>
        )}

        {oldMatch && (
          <div>
            <div className="text-ink-muted mb-1">原文片段:</div>
            <pre className="px-2 py-1.5 bg-danger/10 border border-danger/30 rounded text-danger whitespace-pre-wrap break-words">{preview(oldMatch, showDiff ? 2000 : 200)}</pre>
          </div>
        )}

        {newContent != null && (
          <div>
            <div className="text-ink-muted mb-1">{oldMatch ? "替换为:" : "新内容:"}</div>
            <pre className="px-2 py-1.5 bg-success/10 border border-success/30 rounded text-success whitespace-pre-wrap break-words">{preview(newContent, showDiff ? 4000 : 250)}</pre>
          </div>
        )}

        {!!(op.cascade_warnings && op.cascade_warnings.length > 0) && (
          <div className="flex items-start gap-1.5 text-warning/80">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <div>{op.cascade_warnings.join(" · ")}</div>
          </div>
        )}

        {highRisk && isPending && (
          <div className="flex items-center gap-1.5 text-warning">
            <Lock className="w-3.5 h-3.5" />
            <span>高风险操作: 影响 &gt; 1000 字, 请仔细查看 diff 后再确认</span>
          </div>
        )}

        {err && (
          <div className="px-2 py-1 bg-danger/15 border border-danger/40 rounded text-danger">
            {err}
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-line/40 flex items-center gap-2 flex-wrap text-xs">
        {(newContent || oldMatch) && (
          <button
            onClick={() => setShowDiff(s => !s)}
            className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-ink-primary"
          >👁 {showDiff ? "收起" : "查看完整"}</button>
        )}

        {isPending && (
          <>
            <button
              onClick={() => call("confirm")}
              disabled={busy}
              className="px-3 py-1 bg-success hover:bg-success/90 disabled:opacity-50 rounded text-white font-medium flex items-center gap-1"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              确认应用
            </button>
            <button
              onClick={() => call("reject")}
              disabled={busy}
              className="px-3 py-1 bg-surface-overlay hover:bg-surface-overlay disabled:opacity-50 rounded text-ink-primary flex items-center gap-1"
            >
              <X className="w-3.5 h-3.5" /> 取消
            </button>
          </>
        )}

        {isConfirmed && op.reversible && !op.rolled_back_at && (
          <button
            onClick={() => call("rollback")}
            disabled={busy}
            className="px-3 py-1 bg-info hover:bg-info/90 disabled:opacity-50 rounded text-white flex items-center gap-1"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />}
            撤销
          </button>
        )}

        {op.applied_at && (
          <span className="text-ink-muted ml-auto">
            ✓ 已应用 {new Date(op.applied_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
          </span>
        )}
      </div>
    </div>
  );
}
