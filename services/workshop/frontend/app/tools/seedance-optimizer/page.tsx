"use client";
/**
 * Seedance 2.0 提示词优化 (byted-ark-seedance-pe skill)
 * 用户贴原始/口语化视频提示词 → AI 按官方方法论输出: 问题分析 + 优化后提示词 + 优化说明 + 依据文档。
 * 独立轻量页, 不依赖草稿。所有 seedance2.0 提示词优化以此 skill 为准。
 *
 * 支持多任务卡片: 每张卡片是一个独立的优化任务(独立输入/模型/结果/loading),
 * 可同时发起多个任务并行跑, 互不阻塞。
 */
import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import { ChevronLeft, Loader2, Sparkles, Copy, Wand2, Plus, X } from "lucide-react";
import { authFetch } from "../../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

const PROVIDERS = [
  { key: "gemini", label: "🌐 跨世界观模型" },
  { key: "deepseek", label: "🧠 通用模型" },
  { key: "gpt5", label: "⚡ 逻辑专项模型" },
];

type Task = {
  id: number;
  raw: string;
  provider: string;
  loading: boolean;
  result: string | null;
  err: string | null;
  copied: boolean;
};

let _seq = 1;
function newTask(): Task {
  return { id: _seq++, raw: "", provider: "gemini", loading: false, result: null, err: null, copied: false };
}

export default function SeedanceOptimizerPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>(() => [newTask()]);

  const patch = useCallback((id: number, p: Partial<Task>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t)));
  }, []);

  const addTask = useCallback(() => setTasks((prev) => [...prev, newTask()]), []);
  const removeTask = useCallback(
    (id: number) => setTasks((prev) => (prev.length <= 1 ? prev : prev.filter((t) => t.id !== id))),
    [],
  );

  const optimize = useCallback(
    async (task: Task) => {
      const text = task.raw.trim();
      if (!text || task.loading) return;
      patch(task.id, { loading: true, err: null, result: null });
      try {
        const r = await authFetch(`${BASE}/v1/seedance-pe/optimize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw_prompt: text, provider: task.provider }),
        });
        const d = await r.json();
        if (!r.ok) {
          patch(task.id, { err: d?.detail || "优化失败, 请重试", loading: false });
        } else {
          patch(task.id, { result: d.optimized_markdown || "", loading: false });
        }
      } catch (e: any) {
        patch(task.id, { err: e?.message || String(e), loading: false });
      }
    },
    [patch],
  );

  const copyAll = useCallback(
    (task: Task) => {
      if (!task.result) return;
      navigator.clipboard?.writeText(task.result).then(() => {
        patch(task.id, { copied: true });
        setTimeout(() => patch(task.id, { copied: false }), 1500);
      });
    },
    [patch],
  );

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary">
      {/* 顶栏 */}
      <header className="h-14 flex items-center gap-3 px-4 border-b border-line bg-surface-elevated/80 backdrop-blur sticky top-0 z-10">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-1 px-2 py-1 rounded-md hover:bg-surface-overlay text-sm text-ink-secondary hover:text-ink-primary transition"
        >
          <ChevronLeft className="w-4 h-4" />返回
        </button>
        <div className="h-5 w-px bg-line" />
        <h1 className="text-base font-semibold flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary" /> Seedance 2.0 提示词优化
        </h1>
        <span className="text-xs text-ink-muted hidden md:inline">
          贴原始提示词 → AI 按官方方法论输出标准结构化提示词
        </span>
        <button
          onClick={addTask}
          className="ml-auto flex items-center gap-1 px-3 h-9 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-sm font-medium transition"
        >
          <Plus className="w-4 h-4" />新增任务
        </button>
      </header>

      {/* 宽布局: 撑满可用宽度, 大屏多列并排, 每张卡是一个独立任务 */}
      <div className="mx-auto w-full max-w-[1600px] p-4">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          {tasks.map((task, idx) => (
            <div key={task.id} className="bg-surface-elevated border border-line rounded-xl p-4 space-y-3">
              {/* 卡头: 序号 + 删除 */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-warning" />任务 {idx + 1}
                </span>
                {tasks.length > 1 && (
                  <button
                    onClick={() => removeTask(task.id)}
                    className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-xs text-ink-muted hover:bg-surface-overlay hover:text-danger transition"
                    title="移除此任务"
                  >
                    <X className="w-3.5 h-3.5" />移除
                  </button>
                )}
              </div>

              {/* 输入 */}
              <textarea
                value={task.raw}
                onChange={(e) => patch(task.id, { raw: e.target.value })}
                placeholder="例如: 公园里一只猫玩球，天气晴朗，要电影感&#10;(也可粘贴可公开分享的完整请求体文本)"
                rows={6}
                className="w-full px-3 py-2 bg-surface-overlay border border-line rounded-md text-sm resize-y outline-none focus:border-primary break-words"
              />
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-ink-muted">优化模型:</span>
                {PROVIDERS.map((p) => (
                  <button
                    key={p.key}
                    onClick={() => patch(task.id, { provider: p.key })}
                    className={`px-2.5 py-1 rounded text-xs transition-colors ${
                      task.provider === p.key
                        ? "bg-primary text-white font-semibold"
                        : "text-ink-muted hover:bg-surface-overlay border border-line"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  onClick={() => optimize(task)}
                  disabled={task.loading || !task.raw.trim()}
                  className="ml-auto px-4 h-9 bg-primary hover:bg-primary/90 text-white disabled:opacity-50 rounded-md text-sm font-medium flex items-center gap-1.5 transition"
                >
                  {task.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  {task.loading ? "优化中…" : "开始优化"}
                </button>
              </div>

              {task.err && (
                <div className="border border-danger/50 bg-danger/5 text-danger rounded-lg px-3 py-2 text-sm break-words">
                  ⚠️ {task.err}
                </div>
              )}

              {/* 结果 */}
              {task.result && (
                <div className="border-t border-line pt-3">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-sm font-semibold flex items-center gap-1.5">
                      <Sparkles className="w-4 h-4 text-success" />优化结果
                    </span>
                    <button
                      onClick={() => copyAll(task)}
                      className="ml-auto flex items-center gap-1 px-2 py-1 rounded text-xs text-ink-secondary hover:bg-surface-overlay transition"
                    >
                      <Copy className="w-3.5 h-3.5" />{task.copied ? "已复制" : "复制全部"}
                    </button>
                  </div>
                  {/* 关键: 代码块/长文强制换行, 不再溢出文本框 */}
                  <div className="prose prose-sm prose-invert max-w-none break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_pre]:bg-surface-base [&_pre]:border [&_pre]:border-line [&_code]:whitespace-pre-wrap [&_code]:break-words [&_code]:text-ink-primary [&_p]:break-words [&_table]:text-xs">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkCjkFriendly]}>{task.result}</ReactMarkdown>
                  </div>
                </div>
              )}

              {!task.result && !task.loading && !task.err && (
                <p className="text-center text-xs text-ink-muted py-6">
                  输出包含: 问题分析 · 优化后的标准提示词 · 优化说明 · 依据参考文档
                </p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}