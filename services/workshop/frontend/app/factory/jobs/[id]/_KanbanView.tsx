"use client";
import { Card, Badge } from "@/components/ui";
import { FileText, Loader2, Wrench, XCircle, CheckCircle } from "lucide-react";

/**
 * V4四列看板 - 直接消费后端 /jobs/{id}/debug 返回的 kanban 结构
 * 
 * 列定义:
 * 1. 生成/质检中 (蓝) - generated/analyzed_v1/repairable_pending/analyzed_v2/repairable_pending_v2
 * 2. 优化中 (黄) - optimized_v1
 * 3. 已舍弃 (红) - rejected_fatal/rejected_fatal_v2
 * 4. 通过→剧本 (绿) - ready_for_script,展示关联剧本
 */

const STATUS_LABELS: Record<string, string> = {
  generated: "已生成",
  analyzed_v1: "第一轮质检",
  repairable_pending: "待修复",
  optimized_v1: "已优化",
  analyzed_v2: "第二轮质检",
  repairable_pending_v2: "待修复(二轮)",
  rejected_fatal: "致命缺陷",
  rejected_fatal_v2: "二轮淘汰",
  ready_for_script: "剧本生成中",
  completed: "剧本已完成",
  spare: "备用未启用",
};

export function KanbanView({ traceData, onOpenDetail }: any) {
  if (!traceData || traceData.mode !== "v4" || !traceData.kanban) return null;

  const { kanban, total_outlines, total_scripts, job_status } = traceData;

  const columns = [
    {
      key: "column1",
      title: "生成/质检中",
      color: "blue",
      icon: Loader2,
      items: kanban.column1 || [],
    },
    {
      key: "column2",
      title: "优化中",
      color: "yellow",
      icon: Wrench,
      items: kanban.column2 || [],
    },
    {
      key: "column3",
      title: "已舍弃",
      color: "red",
      icon: XCircle,
      items: kanban.column3 || [],
    },
    {
      key: "column4",
      title: "通过→剧本",
      color: "green",
      icon: CheckCircle,
      items: kanban.column4 || [],
    },
  ];

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <FileText className="w-5 h-5 text-purple-500" />
          大纲生产看板
          <span className="text-xs font-normal text-ink-secondary">(卡片为大纲维度,剧本挂在对应大纲下)</span>
        </h3>
        <div className="text-sm text-ink-secondary">
          共 {total_outlines} 个大纲 · {total_scripts} 个剧本
          {job_status === "running" && (
            <span className="ml-2 text-blue-500 inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> 任务进行中
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {columns.map((col) => (
          <KanbanColumn
            key={col.key}
            title={col.title}
            count={col.items.length}
            color={col.color}
            Icon={col.icon}
          >
            {col.items.map((item: any) => (
              <OutlineCard
                key={item.id}
                data={item}
                color={col.color}
                onClick={() => onOpenDetail(item)}
              />
            ))}
          </KanbanColumn>
        ))}
      </div>
    </Card>
  );
}

const COLUMN_STYLES: Record<string, { header: string; badge: string; border: string }> = {
  blue: {
    header: "bg-blue-50 border-blue-200 text-blue-800",
    badge: "bg-blue-500",
    border: "border-blue-200 hover:border-blue-400",
  },
  yellow: {
    header: "bg-yellow-50 border-yellow-200 text-yellow-800",
    badge: "bg-yellow-500",
    border: "border-yellow-200 hover:border-yellow-400",
  },
  red: {
    header: "bg-red-50 border-red-200 text-red-800",
    badge: "bg-red-500",
    border: "border-red-200 hover:border-red-400",
  },
  green: {
    header: "bg-green-50 border-green-200 text-green-800",
    badge: "bg-green-500",
    border: "border-green-200 hover:border-green-400",
  },
};

function KanbanColumn({ title, count, color, Icon, children }: any) {
  const styles = COLUMN_STYLES[color] || COLUMN_STYLES.blue;
  return (
    <div className="flex flex-col min-h-[200px]">
      <div className={`px-3 py-2 rounded-t-lg border ${styles.header} flex items-center justify-between`}>
        <span className="text-sm font-medium flex items-center gap-1.5">
          <Icon className="w-4 h-4" />
          {title}
        </span>
        <span className={`text-xs text-white px-2 py-0.5 rounded-full ${styles.badge}`}>
          {count}
        </span>
      </div>
      <div className="flex-1 border border-t-0 border-line rounded-b-lg p-2 space-y-2 bg-surface-base/50 overflow-y-auto max-h-[480px]">
        {count === 0 ? (
          <div className="text-center py-8 text-xs text-ink-secondary">暂无</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

function OutlineCard({ data, color, onClick }: any) {
  const styles = COLUMN_STYLES[color] || COLUMN_STYLES.blue;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 bg-white rounded-lg border ${styles.border} transition-colors shadow-sm`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium truncate">{data.title}</span>
      </div>
      <div className="flex items-center gap-1 mb-1.5">
        <Badge className={`${styles.badge} text-white text-[10px] px-1.5 py-0`}>
          {STATUS_LABELS[data.status] || data.status}
        </Badge>
        {data.scripts && data.scripts.length > 0 && (
          <Badge className="bg-purple-500 text-white text-[10px] px-1.5 py-0">
            {data.scripts.length} 剧本
          </Badge>
        )}
      </div>
      {data.content_preview && (
        <p className="text-xs text-ink-secondary line-clamp-2">
          {data.content_preview}
        </p>
      )}
    </button>
  );
}