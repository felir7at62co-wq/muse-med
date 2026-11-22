"use client";
/**
 * 对话工坊（v1）里的「交给 Agent」入口。面板本体是共用的 components/agent/AgentPanel，
 * 与 v2 工作台对话栏完全一致。手打消息仍是纯对话（已上线的产品决策不变）。
 */
import { useState } from "react";
import { Bot } from "lucide-react";
import AgentPanel from "../../components/agent/AgentPanel";

export default function AgentDrawer({ draftId }: { draftId: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="border-t border-line bg-surface-base/60 px-3 py-1.5 flex items-center gap-2 text-xs">
        <button onClick={() => setOpen(true)} disabled={!draftId}
          title={draftId ? "让 AI 自己读稿、调用平台能力、检查结果，多步完成一件事" : "先给会话关联一部草稿"}
          className="flex items-center gap-1 px-2 py-1 rounded border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-40">
          <Bot className="w-3.5 h-3.5" />交给 Agent
        </button>
        <span className="text-ink-muted hidden md:inline">适合"读完整部剧再改""体检后修复并复查"这类需要多步的事</span>
      </div>
      {draftId && <AgentPanel draftId={draftId} open={open} onClose={() => setOpen(false)} />}
    </>
  );
}
