"use client";
/**
 * Agent 引擎对话台（共用组件）：超级 Agent 页面与对话工坊「交给 Agent」都用它。
 *
 * 数据流：POST /v1/agent-engine/runs 发起一轮 → SSE /runs/{id}/events?after_seq 读事件
 * （断线或审批后按最后的 seq 重连续读，事件不丢）→ 审批卡只回传决定，参数以服务端保存的为准。
 * 关闭页面不会中断运行：重新打开会话会回放全部事件并接上进行中的那一轮。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { authFetch, getToken } from "../../lib/auth";
import {
  Send, Loader2, CheckCircle2, XCircle, ChevronDown, ChevronRight, ShieldAlert,
  ListChecks, Square, Wrench, AlertTriangle,
} from "lucide-react";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
export const ENGINE = `${BASE}/v1/agent-engine`;

export type Profile = "studio" | "producer" | "readonly";

type Ev = { seq: number; type: string; [k: string]: any };
type Approval = { approval_id: number; tool: string; args: any; risk?: string; description?: string; status: string };
/**
 * 后端 `job_status.describe()` 的返回 —— **判活的唯一口径**。
 *
 * ⚠️ 2026-10-24：此前这一轮运行到底"在排队 / 在跑 / 卡死了"是前端拿
 * `run.status` 猜的，而 `run.status === "running"` 只表示"这一轮没结束"，
 * **它同时覆盖"还在队列里等 worker"**。生产上排队动辄 1~3 小时，用户看到的
 * 全是"进行中（关闭页面也会继续）"，于是反复问"是不是卡住了"。
 */
export type RunState = {
  phase: string; label: string; active: boolean; terminal: boolean; why: string;
  retrying?: boolean; queue_position?: number | null;
  queued_seconds?: number | null; heartbeat_age_seconds?: number | null;
  episodes_done?: number | null; episodes_total?: number | null;
  elapsed_seconds?: number | null; eta_seconds?: number | null;
};
export type RunView = {
  id: number; status: string; message: string; final_text?: string | null; error?: string | null;
  usage?: any; events: Ev[]; approvals?: Approval[]; streaming?: string;
  state?: RunState | null;
};

const TOOL_LABEL: Record<string, string> = {
  list_drafts: "列草稿", find_drafts: "按名字找草稿", get_draft: "看草稿概况", read_outline: "读大纲", read_chapter: "读正文",
  read_storyboard: "读剧本", run_check: "体检", deai_detect: "检测AI味", get_job: "查作业", wait_job: "等作业完成",
  create_draft: "新建草稿", generate_outline: "生成大纲", generate_chapters: "生成正文", generate_storyboards: "生成剧本",
  patch_outline_episode: "修改某集大纲", regenerate_outline_episode: "重写某集大纲", expand_outline_beats: "补场景节拍",
  extend_outline: "续写大纲", regenerate_chapter: "重写某集正文", regenerate_storyboard: "重写某集剧本",
  start_rewrite: "整本精修", start_fix: "定点修复", start_deai: "去AI味清洗稿", adapt_analyze: "改编分析",
  adapt_propose: "生成改编设定", adapt_commit: "执行改编", submit_batch_job: "批量处理", update_draft_title: "改标题",
  trash_draft: "删除草稿", write_todos: "更新计划",
  list_versions: "看历史版本", restore_version: "回退到历史版本", edit_storyboard_text: "精确修改剧本",
  edit_chapter_text: "精确修改正文", refresh_gate: "刷新大纲门禁", start_analysis: "发起剧本分析",
  get_analysis: "看分析结果", build_story_bible: "重建设定圣经", refresh_ledger: "重建状态账本",
  diagnose_timeline: "诊断节奏", rebalance_timeline: "重排节奏", regenerate_outline_range: "区间重写大纲",
  get_characters: "看角色", extract_characters: "抽取角色", build_character_cards: "生成角色卡",
  scan_character_warnings: "扫描人设冲突", replace_character_names: "全剧改人名", generate_novel: "生成小说版",
  generate_tweet: "生成推文版", export_docx: "导出 Word", start_spawn: "裂变", batch_create_drafts: "批量新建草稿",
};
const RISK_LABEL: Record<string, string> = {
  generate: "生成", overwrite: "覆盖已有内容", delete: "删除", meta: "修改信息", read: "只读",
};
const ACTIVE = ["queued", "running", "awaiting_approval"];
/** 刷新单轮状态的间隔：事件流开着时也要定期拉一次 state（第 N/M 集、预计剩余、心跳）。 */
const STATE_POLL_MS = 15000;
/** 这些事件不代表"正在跑"：停在审批点、或已经收尾。收到它们不能把界面改成进行中。 */
const NOT_RUNNING_EVENTS = ["approval_required", "approval_decided", "done", "canceled", "error"];

/**
 * 本地先行的状态，等下一次 refreshRun 拿到后端的真值再覆盖。
 *
 * ⚠️ 2026-10-28：`run.state` 原先**只在 refreshRun 时更新**，而 refreshRun 只在提交后
 * 立刻调一次、再等事件流断开才调。于是：
 *   · 提交后 60ms 拿到"排队中"，worker 1 秒后就开跑了，界面却整轮都显示排队中；
 *   · 点了确认后只把 status 改成 queued，state 还是 awaiting_approval ——
 *     确认卡片消失了，"等待你确认"却一直挂着。
 * 收到事件 = worker 一定在跑，这是比任何轮询都快的信号。
 */
function localState(phase: "queued" | "running", label: string, why = ""): RunState {
  return { phase, label, active: true, terminal: false, why };
}

export function toolLabel(n: string) { return TOOL_LABEL[n] || n; }

async function* readSSE(url: string, signal: AbortSignal): AsyncGenerator<Ev> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() || ""}` }, signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const p of parts) {
      const line = p.split("\n").find((l) => l.startsWith("data:"));
      if (line) { try { yield JSON.parse(line.slice(5)); } catch { /* 忽略 */ } }
    }
  }
}

export function AgentConsole({
  profile, draftId, conversationId, onConversation, onToolDone, placeholder, examples, model,
}: {
  profile: Profile;
  draftId?: number | null;
  conversationId: number | null;
  /**
   * 对话栏旁模型选择器选定的具体型号 —— **只作为写作模型**：它派出去的写作作业
   * （大纲/正文/剧本/精修）用哪个模型写。
   * 2026-10-21 用户裁定：Agent 自己的思考模型不让用户换，一律用平台默认
   * （后端 AGENT_ENGINE_MODEL，当前 deepseek-v4-flash），见下方 model: null 处的注释。
   * 不传 = 写作也用平台默认（deepseek-v4-flash）。
   */
  model?: string;
  onConversation?: (id: number) => void;
  onToolDone?: (tool: string) => void;
  placeholder?: string;
  examples?: string[];
}) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const convRef = useRef<number | null>(conversationId);
  const onToolDoneRef = useRef(onToolDone);
  onToolDoneRef.current = onToolDone;

  const patchRun = useCallback((id: number, f: (r: RunView) => RunView) => {
    setRuns((rs) => rs.map((r) => (r.id === id ? f(r) : r)));
  }, []);

  const refreshRun = useCallback(async (id: number) => {
    const r = await authFetch(`${ENGINE}/runs/${id}`);
    if (!r.ok) return null;
    const d = await r.json();
    patchRun(id, (x) => ({ ...x, status: d.status, final_text: d.final_text, error: d.error, usage: d.usage, approvals: d.approvals, state: d.state ?? x.state }));
    return d;
  }, [patchRun]);

  // 跟随一轮运行：读事件 → 停在审批/结束 → 若仍在进行则按最后 seq 重连
  const follow = useCallback(async (id: number, afterSeq: number) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let last = afterSeq;
    // 事件流开着期间定期刷新 state：长作业里 Agent 可能几分钟不出事件（在 wait_job 等写稿），
    // 没有这个，"第 N/M 集"和"疑似卡住"都不会更新。
    const poll = setInterval(() => { if (!ctrl.signal.aborted) void refreshRun(id); }, STATE_POLL_MS);
    ctrl.signal.addEventListener("abort", () => clearInterval(poll));
    try {
      while (!ctrl.signal.aborted) {
        try {
          for await (const e of readSSE(`${ENGINE}/runs/${id}/events?after_seq=${last}`, ctrl.signal)) {
            if (e.type === "stream_end") break;
            last = Math.max(last, e.seq || last);
            // 收到 worker 写的事件 → 它一定在跑。界面上还说"排队中 / 等你确认"的，立刻改成进行中。
            if (!NOT_RUNNING_EVENTS.includes(e.type)) {
              patchRun(id, (r) => !r.state || r.state.phase === "queued" || r.state.phase === "awaiting_approval"
                ? { ...r, status: "running", state: localState("running", "进行中") }
                : r);
            }
            if (e.type === "delta") {
              patchRun(id, (r) => ({ ...r, streaming: (r.streaming || "") + (e.text || "") }));
              continue;
            }
            patchRun(id, (r) => ({
              ...r, events: r.events.some((x) => x.seq === e.seq) ? r.events : [...r.events, e],
              streaming: e.type === "assistant" ? "" : r.streaming,
            }));
            if (e.type === "tool_result" && e.ok) onToolDoneRef.current?.(e.name);
          }
        } catch (ex: any) {
          if (ctrl.signal.aborted) return;
          await new Promise((res) => setTimeout(res, 2000));     // 网络抖动：稍后按 seq 续读
        }
        const d = await refreshRun(id);
        if (!d || !ACTIVE.includes(d.status) || d.status === "awaiting_approval") return;
        await new Promise((res) => setTimeout(res, 800));
      }
    } finally {
      clearInterval(poll);
    }
  }, [patchRun, refreshRun]);

  // 打开会话：回放全部事件，接上进行中的那一轮
  useEffect(() => {
    convRef.current = conversationId;
    abortRef.current?.abort();
    setRuns([]);
    setErr(null);
    if (!conversationId) return;
    (async () => {
      const r = await authFetch(`${ENGINE}/conversations/${conversationId}`);
      if (!r.ok) return;
      const d = await r.json();
      const list: RunView[] = (d.runs || []).map((x: any) => ({ ...x, events: x.events || [] }));
      setRuns(list);
      const act = list.find((x) => ACTIVE.includes(x.status));
      if (act) {
        await refreshRun(act.id);
        if (act.status !== "awaiting_approval") {
          const lastSeq = Math.max(0, ...act.events.map((e) => e.seq));
          void follow(act.id, lastSeq);
        }
      }
    })();
    return () => abortRef.current?.abort();
  }, [conversationId, follow, refreshRun]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [runs]);

  const activeRun = runs.find((r) => ACTIVE.includes(r.status));
  const runsRef = useRef(runs);
  runsRef.current = runs;

  /** 重新拉一次单轮状态；若后端已把它（自愈后）重新排上队，接着跟它的事件流。 */
  const resync = useCallback(async (id: number) => {
    const d = await refreshRun(id);
    if (d && ACTIVE.includes(d.status) && d.status !== "awaiting_approval") {
      const cur = runsRef.current.find((r) => r.id === id);
      void follow(id, Math.max(0, ...(cur?.events || []).map((e) => e.seq)));
    }
  }, [refreshRun, follow]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || busy || activeRun) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await authFetch(`${ENGINE}/runs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg, profile, draft_id: draftId || null, conversation_id: convRef.current,
          /* ⚠️ 2026-10-21 用户裁定：Agent 自己用什么模型**不让用户选**，一律用平台默认
             （后端 AGENT_ENGINE_MODEL，当前 deepseek-v4-flash）。对话栏的模型选择器只决定
             **写作模型** —— 让它顺带决定 Agent 的思考模型，曾在生产上把 gpt-6.1-sol 带进
             Agent：带工具的请求被 langchain 自动改道 /v1/responses，第二轮回传 item_ id 被
             上游判 400，整个运行失败。用户想换的是"稿子由谁写"，不是"Agent 由谁想"。
             model 字段留空 = 用后端默认，不让前端有机会把它覆盖掉。 */
          model: null,
          // 写作作业单独一个字段：它是"稿子由谁写"，与 Agent 的思考模型是两件事。
          // 用户在对话栏选了什么，两处都用它 —— 同一条对话口径一致，不会出现
          // "界面上选的是 A、稿子却被 B 写了"这种查不出来的偏差。
          writing_model: model || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.detail?.message || d.detail || `HTTP ${r.status}`);
      setInput("");
      if (!convRef.current) { convRef.current = d.conversation_id; onConversation?.(d.conversation_id); }
      setRuns((rs) => [...rs, { id: d.run_id, status: "queued", message: msg, events: [] }]);
      void follow(d.run_id, 0);
    } catch (e: any) {
      setErr(e.message || "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function decide(run: RunView, a: Approval, decision: "approve" | "reject", note = "") {
    patchRun(run.id, (r) => ({ ...r, approvals: (r.approvals || []).map((x) => x.approval_id === a.approval_id ? { ...x, status: decision === "approve" ? "approved" : "rejected" } : x) }));
    const r = await authFetch(`${ENGINE}/runs/${run.id}/approvals/${a.approval_id}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision, note }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.resumed) {
      // state 必须一起换掉：只改 status 时 state 仍是 awaiting_approval，卡片没了提示却还在。
      patchRun(run.id, (x) => ({ ...x, status: "queued", state: localState("queued", "已确认，马上继续") }));
      const lastSeq = Math.max(0, ...run.events.map((e) => e.seq));
      void follow(run.id, lastSeq);
    } else {
      await refreshRun(run.id);
    }
  }

  async function cancel(run: RunView) {
    if (!confirm("确定停止这一轮？已经完成的修改会保留。")) return;
    await authFetch(`${ENGINE}/runs/${run.id}/cancel`, { method: "POST" });
    setTimeout(() => void refreshRun(run.id), 1500);
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-surface-overlay/30">
        {runs.length === 0 && (
          <div className="text-center text-ink-muted mt-16 text-sm max-w-lg mx-auto">
            <p className="mb-3">交代一件事，我会自己读稿、调用平台能力、检查结果，需要你确认的操作会先问你。</p>
            {examples && examples.length > 0 && (
              <div className="text-left text-xs space-y-1.5 bg-surface-base border border-line rounded-lg p-3">
                {examples.map((x) => (
                  <button key={x} onClick={() => setInput(x)} className="block w-full text-left hover:text-primary">· {x}</button>
                ))}
              </div>
            )}
          </div>
        )}
        {runs.map((r) => (
          <RunBlock key={r.id} run={r} onDecide={decide} onCancel={cancel} onRefresh={(id) => void resync(id)} />
        ))}
        {err && <div className="text-xs text-danger bg-danger/10 rounded px-3 py-2">{err}</div>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-line bg-surface-elevated p-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            value={input} onChange={(e) => setInput(e.target.value)} rows={2}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={activeRun ? "这一轮还在进行，结束或停止后可以继续交代" : (placeholder || "交代要做的事（Enter 发送，Shift+Enter 换行）")}
            disabled={!!activeRun}
            className="flex-1 resize-none rounded-md bg-surface-base border border-line px-3 py-2 text-sm focus:outline-none focus:border-primary disabled:opacity-60"
          />
          <button onClick={() => void send()} disabled={busy || !!activeRun || !input.trim()}
            className="h-10 px-4 rounded-md bg-primary text-white text-sm flex items-center gap-1 disabled:opacity-40">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}发送
          </button>
        </div>
      </div>
    </div>
  );
}

function RunBlock({ run, onDecide, onCancel, onRefresh }: {
  run: RunView;
  onDecide: (r: RunView, a: Approval, d: "approve" | "reject", note?: string) => void;
  onCancel: (r: RunView) => void;
  onRefresh: (id: number) => void;
}) {
  const results: Record<string, Ev> = {};
  for (const e of run.events) if (e.type === "tool_result") results[e.tool_call_id] = e;
  const plan = [...run.events].reverse().find((e) => e.type === "plan")?.todos as any[] | undefined;
  const pending = (run.approvals || []).filter((a) => a.status === "pending");
  const active = ACTIVE.includes(run.status);

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-lg text-sm bg-primary text-white whitespace-pre-wrap">{run.message}</div>
      </div>
      {plan && plan.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-base p-3 text-xs">
          <div className="flex items-center gap-1 text-ink-secondary font-semibold mb-1.5"><ListChecks className="w-3.5 h-3.5" />计划</div>
          {plan.map((t, i) => (
            <div key={i} className="flex items-start gap-1.5 py-0.5">
              {t.status === "completed" ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0 mt-0.5" />
                : t.status === "in_progress" ? <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0 mt-0.5" />
                : <span className="w-3.5 h-3.5 rounded-full border border-line shrink-0 mt-0.5" />}
              <span className={t.status === "completed" ? "text-ink-muted line-through" : ""}>{t.content}</span>
            </div>
          ))}
        </div>
      )}
      {run.events.map((e) => {
        if (e.type === "assistant") {
          return (
            <div key={e.seq} className="space-y-1.5">
              {e.text && e.text.trim() && (
                <div className="max-w-[92%] px-3 py-2 rounded-lg text-sm bg-surface-base border border-line">
                  <Md text={e.text} />
                </div>
              )}
              {(e.tool_calls || []).filter((tc: any) => tc.name !== "write_todos").map((tc: any) => (
                <ToolCard key={tc.id} call={tc} result={results[tc.id]} running={active && !results[tc.id]} />
              ))}
            </div>
          );
        }
        if (e.type === "error") {
          return <div key={e.seq} className="text-xs text-warning flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" />{e.message}</div>;
        }
        if (e.type === "resumed" && e.reason === "recovery") {
          return <div key={e.seq} className="text-[11px] text-ink-muted text-center">— 服务重启后已从中断处继续 —</div>;
        }
        return null;
      })}
      {run.streaming && (
        <div className="max-w-[92%] px-3 py-2 rounded-lg text-sm bg-surface-base border border-line opacity-80"><Md text={run.streaming} /></div>
      )}
      {pending.map((a) => <ApprovalCard key={a.approval_id} a={a} onDecide={(d, n) => onDecide(run, a, d, n)} />)}
      <RunFooter run={run} active={active} pendingCount={pending.length} onCancel={onCancel} onRefresh={onRefresh} />
    </div>
  );
}

/**
 * 一轮运行的状态行 —— **只读 `run.state`**，不再拿 `run.status` 猜。
 *
 * 2026-10-24 之前这里写的是 `{active && run.status !== "awaiting_approval" && "进行中"}`
 * + 一个转圈图标。问题在于 `active` 包含 `queued`：作业还在队列里排 2 小时，
 * 界面上也一直转圈说"进行中"。用户唯一的结论就是"卡死了"。
 *
 * 现在四种非终态各有各的说法，并且把**为什么**写出来（`state.why`）：
 *   排队中     —— 还没轮到，一个字都没写
 *   进行中     —— 在写，带第 N/M 集和预计剩余
 *   疑似卡住   —— 心跳断了，会自动重派
 *   等你确认   —— 停下来等人，不会自己恢复
 */
function RunFooter({ run, active, pendingCount, onCancel, onRefresh }: {
  run: RunView; active: boolean; pendingCount: number;
  onCancel: (r: RunView) => void; onRefresh: (id: number) => void;
}) {
  const st = run.state;
  // ⚠️「等待你确认」只认 run.status（2026-10-28）：state 可能是旧快照，status 才是最近一次
  // 后端/本地确认后的值。此前两者任一为 awaiting 就显示，确认后卡片消失、提示却一直在。
  const awaiting = run.status === "awaiting_approval";
  const phase = awaiting ? "awaiting_approval" : (st?.phase === "awaiting_approval" ? "" : (st?.phase || ""));
  // 停在审批点、却一张待确认卡片都没有：后端查询时会自愈（见 agent_engine/heal.py），
  // 这里自动刷新一次拿修好后的状态，不让用户对着一句没有出口的提示干等。
  const orphan = awaiting && pendingCount === 0;
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  // 依赖里不放 onRefresh（每次渲染都是新函数）：否则刷新 → 重渲染 → 再刷新，后端修不好时会无限轮询。
  // 每进入一次"孤儿"状态只自动刷新一次；仍是孤儿就停在提示上，由用户手动停止这一轮。
  useEffect(() => {
    if (!orphan) return;
    const t = setTimeout(() => refreshRef.current(run.id), 1500);
    return () => clearTimeout(t);
  }, [orphan, run.id]);
  const eta = st?.eta_seconds;
  const queuedMin = st?.queued_seconds != null ? Math.floor((st.queued_seconds || 0) / 60) : null;

  return (
    <div className="flex items-start gap-2 text-xs text-ink-muted">
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5">
          {phase === "queued" && <><ClockTiny /><span className="text-ink-secondary">{st?.label || "排队中"}</span></>}
          {phase === "running" && <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /><span className="text-ink-secondary">{st?.label || "进行中"}</span></>}
          {phase === "stalled" && <><AlertTriangle className="w-3.5 h-3.5 text-warning" /><span className="text-warning">{st?.label || "疑似卡住"}</span></>}
          {awaiting && pendingCount > 0 && <><ShieldAlert className="w-3.5 h-3.5 text-warning" /><span className="text-warning">等待你确认（见上方卡片）</span></>}
          {orphan && <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>正在核对确认状态…</span></>}
          {run.status === "canceled" && <span>已停止</span>}
          {run.status === "failed" && <span className="text-danger">失败：{run.error}</span>}
          {run.status === "done" && <span>{run.usage ? `完成 · 模型调用 ${run.usage.model_calls} 次` : "完成"}</span>}
          {/* 兜底：后端还没给 state（老数据）时，保持旧文案，不要显示空白 */}
          {!phase && active && <><Loader2 className="w-3.5 h-3.5 animate-spin" /><span>进行中（关闭页面也会继续）</span></>}
          {eta ? <span className="text-ink-muted">· 预计还要约 {humanDur(eta)}</span> : null}
          {phase === "queued" && queuedMin != null && queuedMin >= 1 ? (
            <span className="text-ink-muted">· 已等 {humanDur(st!.queued_seconds!)}</span>
          ) : null}
        </div>
        {/* 「为什么」只在有必要解释时显示：排队和卡住最容易误判成"卡死了"。
            进行中且心跳正常就不用解释，占地方。 */}
        {(phase === "queued" || phase === "stalled") && st?.why ? (
          <div className={phase === "stalled" ? "text-warning/80" : "text-ink-muted"}>
            {stripMd(st.why)}
          </div>
        ) : null}
      </div>
      {active && (
        <button onClick={() => onCancel(run)} className="ml-auto shrink-0 flex items-center gap-1 px-2 py-0.5 rounded border border-line hover:text-danger">
          <Square className="w-3 h-3" />{phase === "queued" ? "撤回" : "停止"}
        </button>
      )}
    </div>
  );
}

function ClockTiny() {
  // 排队用小沙漏而不是转圈：转圈会让人以为"在动"，而排队恰恰是"没动"。
  return <span className="w-3.5 h-3.5 flex items-center justify-center text-[11px] leading-none">⏸</span>;
}

/** 后端 why 里带 `**强调**` 标记，气泡里不做 markdown 渲染，直接去掉星号。 */
function stripMd(s: string): string {
  return s.replace(/\*\*/g, "");
}

function humanDur(sec: number): string {
  if (sec < 90) return `${Math.max(1, Math.round(sec))} 秒`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分钟`;
  return `${(sec / 3600).toFixed(1)} 小时`;
}

function ToolCard({ call, result, running }: { call: any; result?: Ev; running: boolean }) {
  const [open, setOpen] = useState(false);
  const ok = result?.ok;
  return (
    <div className="max-w-[92%] rounded-md border border-line bg-surface-base text-xs">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Wrench className="w-3.5 h-3.5 text-ink-muted" />
        <span className="font-medium">{toolLabel(call.name)}</span>
        <span className="text-ink-muted truncate">{argsBrief(call.args)}</span>
        <span className="ml-auto shrink-0">
          {result ? (ok ? <CheckCircle2 className="w-3.5 h-3.5 text-success" /> : <XCircle className="w-3.5 h-3.5 text-danger" />)
            : running ? <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> : null}
        </span>
      </button>
      {open && (
        <div className="border-t border-line px-2.5 py-2 space-y-1.5">
          <pre className="whitespace-pre-wrap break-all text-ink-secondary">{JSON.stringify(call.args, null, 2)}</pre>
          {result && <pre className="whitespace-pre-wrap break-all text-ink-muted max-h-60 overflow-auto">{result.content}</pre>}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ a, onDecide }: { a: Approval; onDecide: (d: "approve" | "reject", note?: string) => void }) {
  const [note, setNote] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const lines = (a.description || toolLabel(a.tool)).split("\n");
  return (
    <div className="max-w-[92%] rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm space-y-2">
      <div className="flex items-center gap-1.5 font-semibold">
        <ShieldAlert className="w-4 h-4 text-warning" />需要你确认：{lines[0]}
        {a.risk && <span className="text-[11px] font-normal px-1.5 py-0.5 rounded bg-warning/15 text-warning">{RISK_LABEL[a.risk] || a.risk}</span>}
      </div>
      {lines.length > 1 && <div className="text-xs text-ink-secondary whitespace-pre-wrap max-h-48 overflow-auto">{lines.slice(1).join("\n")}</div>}
      {rejecting && (
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="（可选）告诉它为什么不行、希望怎么改"
          className="w-full rounded border border-line bg-surface-base px-2 py-1 text-xs" />
      )}
      <div className="flex gap-2">
        <button onClick={() => onDecide("approve")} className="px-3 py-1 rounded bg-primary text-white text-xs">批准执行</button>
        {!rejecting ? (
          <button onClick={() => setRejecting(true)} className="px-3 py-1 rounded border border-line text-xs">不同意</button>
        ) : (
          <button onClick={() => onDecide("reject", note)} className="px-3 py-1 rounded border border-danger text-danger text-xs">确认拒绝</button>
        )}
      </div>
    </div>
  );
}

function argsBrief(args: any): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  if (args.draft_id) parts.push(`#${args.draft_id}`);
  if (args.order) parts.push(`第${args.order}集`);
  if (args.start || args.end) parts.push(`第${args.start || 1}~${args.end || "末"}集`);
  if (args.job_id) parts.push(`作业 ${args.job_id}`);
  if (Array.isArray(args.draft_ids)) parts.push(`${args.draft_ids.length} 部草稿`);
  return parts.join(" · ");
}

function Md({ text }: { text: string }) {
  return (
    <div className="prose prose-sm prose-invert max-w-none [&_table]:text-xs [&_code]:bg-surface-overlay [&_code]:px-1 [&_code]:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
    </div>
  );
}
