"use client";
import { authFetch } from "../../../lib/auth";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Progress = {
  stage: string;
  sub_stage: string;
  current: number;
  total: number;
  running: boolean;
  in_memory_running?: boolean;
  last_message: string;
  last_beat_at: string;
  task_id: string;
};

const STAGE_LABEL: Record<string, string> = {
  chapters: "章节生成",
  storyboards: "剧本生成",
  outline: "大纲生成",
  video: "视频反推",
  continuation: "续写中",
  idle: "",
};

/**
 * 后端持久化的进度横幅 — Phase 3 重做版,接入 UI Kit (Card / Spinner)。
 *
 * 数据源: GET /v1/stages/drafts/{id}/progress (5 秒轮询)
 * - 刷新页面也能看到进度,因为它读的是 outline.progress
 * - 可识别"卡住"(last_beat_at 超过 3 分钟)
 */
export function ProgressBanner({
  draftId,
  onTick,
}: {
  draftId: number;
  onTick?: (p: { current: number; total: number; running: boolean; sub_stage: string }) => void;
}) {
  const [p, setP] = useState<Progress | null>(null);
  const alive = useRef(true);
  const lastTickRef = useRef<string>("");

  async function fetchProgress() {
    try {
      const r = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/progress`);
      if (!r.ok) return;
      const data = await r.json();
      if (!alive.current) return;
      setP(data);
      const sig = `${data.running}|${data.current}|${data.sub_stage}`;
      if (sig !== lastTickRef.current) {
        lastTickRef.current = sig;
        onTick?.({
          current: data.current || 0,
          total: data.total || 0,
          running: !!data.running,
          sub_stage: data.sub_stage || "",
        });
      }
    } catch {}
  }

  useEffect(() => {
    alive.current = true;
    fetchProgress();
    const t = setInterval(fetchProgress, 5000);
    return () => {
      alive.current = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  if (!p) return null;
  const subStage = p.sub_stage || "";
  const stage = p.stage || "idle";
  if (stage === "idle") return null;
  if (!p.last_beat_at && !p.running) return null;

  const total = p.total || 0;
  const current = p.current || 0;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;

  const stageLabel = STAGE_LABEL[stage] || stage;
  const running = p.running;
  const isStuck = !running && subStage === "running";

  let stuckMinutes = 0;
  if (p.last_beat_at) {
    const t = new Date(p.last_beat_at).getTime();
    if (t > 0) stuckMinutes = Math.floor((Date.now() - t) / 60000);
  }

  let borderCls = "border-primary/40";
  let icon = <Spinner size="sm" className="text-primary" />;
  let text = "进行中";
  let progressCls = "bg-gradient-to-r from-primary to-cyan";

  if (subStage === "done") {
    borderCls = "border-success/40";
    icon = <CheckCircle2 className="w-5 h-5 text-success" />;
    text = "已完成";
    progressCls = "bg-success";
  } else if (subStage === "failed") {
    borderCls = "border-danger/40";
    icon = <AlertTriangle className="w-5 h-5 text-danger" />;
    text = "已失败";
    progressCls = "bg-danger";
  } else if (isStuck) {
    borderCls = "border-warning/40";
    icon = <AlertTriangle className="w-5 h-5 text-warning" />;
    text = `疑似中断(${stuckMinutes}分钟无心跳)`;
    progressCls = "bg-danger";
  } else if (running) {
    borderCls = "border-primary/40";
    text = "进行中,可关闭页面";
  }

  return (
    <Card padding="md" className={`mb-4 ${borderCls}`}>
      <div className="flex items-center gap-3 mb-2">
        {icon}
        <h3 className="text-base font-bold text-ink-primary">
          {stageLabel}: {text}
        </h3>
        <span className="ml-auto text-sm text-ink-muted">
          {current} / {total || "?"}
        </span>
      </div>

      {total > 0 && (
        <div className="w-full bg-surface-base rounded-full h-2 mb-2">
          <div
            className={`h-2 rounded-full transition-all ${progressCls}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {p.last_message && (
        <p className="text-xs text-ink-muted truncate" title={p.last_message}>
          {p.last_message}
        </p>
      )}

      {isStuck && (
        <p className="text-xs text-warning mt-2">
          后台任务可能因服务重启或异常已中断,可点击下方"全部生成"重新启动。
        </p>
      )}
    </Card>
  );
}
