"use client";
import { Card } from "@/components/ui";

type Slot = { slot: number; series_id?: string; title?: string; state?: string; episode?: number; total?: number; message?: string };
type Row = { series_id: string; title: string; episodes?: number; published?: boolean; reason?: string };

const STATE_LABELS: Record<string, string> = {
  idle: "等待领剧", claimed: "已领取", downloading: "下载中", transcribing: "转写中", checking: "核对中",
};

/** Live slots and per-series outcomes of a 视频转剧本 job. */
export function TranscribeStatus({ progress, result, running }: { progress?: any; result?: any; running: boolean }) {
  const slots: Slot[] = progress?.slots || [];
  const delivered: Row[] = result?.delivered || [];
  const attention: Row[] = result?.attention || [];
  const rejected: Row[] = result?.rejected || [];
  return (
    <Card className="p-4 space-y-3">
      {running && slots.length > 0 && (
        <div className="space-y-1.5">
          {slots.map((s) => (
            <div key={s.slot} className="flex items-center gap-3 text-sm">
              <span className="w-14 text-xs text-ink-secondary">执行位 {s.slot}</span>
              <span className="flex-1 truncate">{s.title || "—"}</span>
              <span className="text-xs text-blue-600">
                {STATE_LABELS[s.state || "idle"] || s.state}
                {s.total ? ` ${s.episode ?? 0}/${s.total} 集` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {delivered.length > 0 && (
        <details open>
          <summary className="text-sm font-medium cursor-pointer">已出稿 {delivered.length} 部</summary>
          <div className="mt-1 space-y-0.5 text-xs">
            {delivered.map((r) => (
              <div key={r.series_id} className="flex gap-2">
                <span className="flex-1 truncate">{r.title}</span>
                <span className="text-ink-secondary">{r.episodes} 集{r.published ? " · 已上架" : ""}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {attention.length > 0 && (
        <details open>
          <summary className="text-sm font-medium cursor-pointer text-amber-700">待处理 {attention.length} 部</summary>
          <div className="mt-1 space-y-0.5 text-xs">
            {attention.map((r) => (
              <div key={r.series_id} className="flex gap-2">
                <span className="w-40 truncate">{r.title}</span>
                <span className="flex-1 text-ink-secondary truncate" title={r.reason}>{r.reason}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {rejected.length > 0 && (
        <details>
          <summary className="text-sm font-medium cursor-pointer text-ink-secondary">选材未通过 {rejected.length} 部</summary>
          <div className="mt-1 space-y-0.5 text-xs">
            {rejected.map((r) => (
              <div key={r.series_id} className="flex gap-2">
                <span className="w-40 truncate">{r.title}</span>
                <span className="flex-1 text-ink-secondary truncate" title={r.reason}>{r.reason}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}
