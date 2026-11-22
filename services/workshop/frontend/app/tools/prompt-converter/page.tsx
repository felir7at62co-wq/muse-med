"use client";
/**
 * 提示词速转工具 (独立页面, 不依赖 draft).
 *
 * 工作流:
 *   1. 用户选输入模式 (自由文本 / 分镜JSON / 从已有草稿)
 *   2. 提交 → 后端结构化为 shots[]
 *   3. 用户审阅/调整 shots, 选模板, 点"渲染"
 *   4. 后台跑 plan + render, 前端轮询 /v1/quick-prompts/{task_id}
 *   5. 看到结果, 可单项编辑/重渲/复制/导出
 *   6. 可选: 保存为正式草稿
 */
import { useEffect, useState, useRef } from "react";
import { confirmAsync } from "@/lib/dialog";
import { useRouter } from "next/navigation";
import { ChevronLeft, Loader2, Sparkles, Edit3, Copy, RefreshCw, Save, Trash2, FileText, Database } from "lucide-react";
import { authFetch } from "../../../lib/auth";
import { QuotaBadge } from "@/components/QuotaBadge";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type Shot = {
  shot_no: number;
  location: string;
  shot_type: string;
  characters: string[];
  action: string;
  dialogue: string;
  duration_s: number;
};

type Template = {
  id: number;
  key: string;
  label: string;
  kind: "video" | "image";
  provider?: string;
};

type ResultItem = {
  task_index: number;
  duration_s: number;
  source_shot_nos: number[];
  summary: string;
  video_prompt: string;
  image_prompt: string;
  user_edited?: boolean;
};

type TaskState = {
  task_id: string;
  title: string;
  status: "running" | "done" | "error";
  stage?: string;
  progress: number;
  shot_count?: number;
  task_count?: number;
  video_template_label?: string;
  image_template_label?: string;
  items: ResultItem[];
  logs: string[];
  error?: string;
};

type Draft = {
  id: number;
  title: string;
};

type DraftChapter = {
  chapter_order: number;
};


const SAMPLE_TEXT = `白天, 山林深处. 一个年轻女子怀抱婴儿在崎岖山道上慌乱奔跑, 长辫剧烈甩动. 身后几个黑衣人持械追击, 神色冷酷.

她跌跌撞撞地翻过一个土坡, 脚踩在松动的石块上险些摔倒. 婴儿在她怀里小声啼哭, 她紧紧捂住婴儿的嘴.

突然前方出现分岔路, 一条通向悬崖, 一条通向密林. 她咬牙选择密林, 头也不回地冲了进去...`;

const SAMPLE_JSON = `[
  {"shot_no":1,"location":"日 外 山林深处","shot_type":"中景","characters":["女1","童1"],"action":"女1 怀抱襁褓在崎岖山道上慌乱奔跑","dialogue":"","duration_s":5},
  {"shot_no":2,"location":"日 外 山林深处","shot_type":"全景","characters":["男1"],"action":"几个黑衣人持械追击, 神色冷酷","dialogue":"","duration_s":4}
]`;

export default function PromptConverterPage() {
  const router = useRouter();

  // 输入模式
  const [mode, setMode] = useState<"text" | "json" | "draft">("text");
  const [freeText, setFreeText] = useState("");
  const [shotsJsonText, setShotsJsonText] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<number | null>(null);
  const [draftChapters, setDraftChapters] = useState<DraftChapter[]>([]);
  const [selectedChapters, setSelectedChapters] = useState<number[]>([]);

  // 中间状态: 结构化后的 shots
  const [shots, setShots] = useState<Shot[]>([]);
  const [structuring, setStructuring] = useState(false);
  const [structErr, setStructErr] = useState<string | null>(null);

  // 模板选择
  const [videoTpls, setVideoTpls] = useState<Template[]>([]);
  const [imageTpls, setImageTpls] = useState<Template[]>([]);
  const [videoKey, setVideoKey] = useState<string>("seedance_2.0");
  const [imageKey, setImageKey] = useState<string>("");
  const [taskTitle, setTaskTitle] = useState("提示词速转");

  // 渲染任务
  const [task, setTask] = useState<TaskState | null>(null);
  const [running, setRunning] = useState(false);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // 编辑状态
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editVideo, setEditVideo] = useState("");
  const [editImage, setEditImage] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);

  // 加载模板
  useEffect(() => {
    (async () => {
      try {
        const [rv, ri] = await Promise.all([
          authFetch(`${BASE}/v1/prompt-templates?kind=video`),
          authFetch(`${BASE}/v1/prompt-templates?kind=image`),
        ]);
        if (rv.ok) {
          const d = await rv.json();
          setVideoTpls(d.items || []);
        }
        if (ri.ok) {
          const d = await ri.json();
          setImageTpls(d.items || []);
        }
      } catch {}
    })();
  }, []);

  // 切到 "从已有草稿" 时拉草稿列表
  useEffect(() => {
    if (mode !== "draft") return;
    (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/stages/drafts`);
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d) ? d : (d.items || []);
          setDrafts(list.map((x: any) => ({ id: x.id, title: x.title })));
        }
      } catch {}
    })();
  }, [mode]);

  // 选了草稿后拉章节列表
  useEffect(() => {
    if (!selectedDraftId) {
      setDraftChapters([]);
      return;
    }
    (async () => {
      try {
        const r = await authFetch(`${BASE}/v1/stages/drafts/${selectedDraftId}/storyboards`);
        if (r.ok) {
          const d = await r.json();
          const list = Array.isArray(d) ? d : (d.items || []);
          setDraftChapters(list.map((x: any) => ({ chapter_order: x.chapter_order })));
        }
      } catch {}
    })();
  }, [selectedDraftId]);

  // 轮询任务状态
  useEffect(() => {
    if (!task || task.status !== "running") {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const r = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}`);
        if (r.ok) {
          const d = await r.json();
          setTask(d);
        }
      } catch {}
    }, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [task?.task_id, task?.status]);

  async function doStructure() {
    setStructErr(null);
    setStructuring(true);
    try {
      if (mode === "text") {
        if (freeText.trim().length < 10) {
          setStructErr("请输入至少 10 字");
          return;
        }
        const r = await authFetch(`${BASE}/v1/quick-prompts/structure`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: freeText }),
        });
        const d = await r.json();
        if (!r.ok) {
          setStructErr(d.detail || `HTTP ${r.status}`);
          return;
        }
        setShots(d.shots);
      } else if (mode === "json") {
        try {
          const parsed = JSON.parse(shotsJsonText);
          if (!Array.isArray(parsed) || parsed.length === 0) {
            setStructErr("JSON 必须是非空数组");
            return;
          }
          // 不调后端, 前端先标准化, 后端 /run 会再次校验
          setShots(parsed);
        } catch (e: any) {
          setStructErr("JSON 解析失败: " + e.message);
          return;
        }
      } else if (mode === "draft") {
        if (!selectedDraftId) {
          setStructErr("请选择一个草稿");
          return;
        }
        const r = await authFetch(`${BASE}/v1/quick-prompts/from-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draft_id: selectedDraftId,
            chapter_orders: selectedChapters.length > 0 ? selectedChapters : null,
          }),
        });
        const d = await r.json();
        if (!r.ok) {
          setStructErr(d.detail || `HTTP ${r.status}`);
          return;
        }
        setShots(d.shots);
      }
    } catch (e: any) {
      setStructErr(e.message || "未知错误");
    } finally {
      setStructuring(false);
    }
  }

  async function doRun() {
    if (shots.length === 0) {
      alert("请先结构化分镜");
      return;
    }
    if (!videoKey) {
      alert("请选视频模板");
      return;
    }
    setRunning(true);
    try {
      const r = await authFetch(`${BASE}/v1/quick-prompts/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shots,
          video_template_key: videoKey,
          image_template_key: imageKey || null,
          title: taskTitle,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        alert("启动失败: " + (d.detail || `HTTP ${r.status}`));
        return;
      }
      // 立刻拉一次状态
      const r2 = await authFetch(`${BASE}/v1/quick-prompts/${d.task_id}`);
      if (r2.ok) setTask(await r2.json());
    } catch (e: any) {
      alert("启动出错: " + e.message);
    } finally {
      setRunning(false);
    }
  }

  function startEdit(idx: number) {
    if (!task) return;
    const it = task.items[idx];
    setEditingIdx(idx);
    setEditVideo(it.video_prompt);
    setEditImage(it.image_prompt);
  }

  async function saveEdit() {
    if (editingIdx === null || !task) return;
    try {
      const r = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}/items/${editingIdx}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_prompt: editVideo, image_prompt: editImage }),
      });
      if (!r.ok) {
        alert("保存失败");
        return;
      }
      setEditingIdx(null);
      // 刷新
      const r2 = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}`);
      if (r2.ok) setTask(await r2.json());
    } catch (e: any) {
      alert("保存出错: " + e.message);
    }
  }

  async function regenerateItem(idx: number) {
    if (!task) return;
    try {
      const r = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}/items/${idx}/regenerate`, {
        method: "POST",
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert("重生失败: " + (d.detail || `HTTP ${r.status}`));
        return;
      }
      // 刷新
      const r2 = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}`);
      if (r2.ok) setTask(await r2.json());
    } catch (e: any) {
      alert("重生出错: " + e.message);
    }
  }

  function copyText(text: string) {
    const showOk = () => {
      const orig = document.title;
      document.title = "✓ 已复制";
      setTimeout(() => { document.title = orig; }, 1500);
    };
    // 现代 API (需要 HTTPS / localhost)
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(showOk).catch(() => fallbackCopy(text, showOk));
      return;
    }
    // 老式 fallback (HTTP 环境)
    fallbackCopy(text, showOk);
  }

  function fallbackCopy(text: string, onOk: () => void) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) onOk();
      else alert("复制失败, 请手动选中并 Ctrl+C");
    } catch (e) {
      alert("复制失败: " + (e as Error).message);
    }
  }

  function exportTxt() {
    if (!task) return;
    const lines: string[] = [];
    lines.push(`# ${task.title}`);
    lines.push(`# 视频模型: ${task.video_template_label || ""}`);
    if (task.image_template_label) lines.push(`# 图片模型: ${task.image_template_label}`);
    lines.push("");
    task.items.forEach((it) => {
      lines.push(`=== 任务 ${it.task_index} · ${it.duration_s}s · 镜${it.source_shot_nos.join(",")} ===`);
      if (it.summary) lines.push(`摘要: ${it.summary}`);
      lines.push(`[视频 prompt]\n${it.video_prompt}`);
      if (it.image_prompt) lines.push(`[首帧图 prompt]\n${it.image_prompt}`);
      lines.push("");
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${task.title || "prompts"}-${task.task_id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveAsDraft() {
    if (!task) return;
    setSavingDraft(true);
    try {
      const r = await authFetch(`${BASE}/v1/quick-prompts/${task.task_id}/save-as-draft`, {
        method: "POST",
      });
      const d = await r.json();
      if (!r.ok) {
        alert("保存失败: " + (d.detail || `HTTP ${r.status}`));
        return;
      }
      if (await confirmAsync({ title: `已保存为草稿 #${d.draft_id}`, description: "是否跳转查看？", confirmText: "去查看" })) {
        router.push(`/drafts/${d.draft_id}?tab=prompts`);
      }
    } catch (e: any) {
      alert("保存出错: " + e.message);
    } finally {
      setSavingDraft(false);
    }
  }

  async function reset() {
    if (!(await confirmAsync({ title: "重置当前结果", description: "24h 内仍可通过 task_id 找回", tone: "warning", confirmText: "重置" }))) return;
    setShots([]);
    setTask(null);
    setStructErr(null);
    setEditingIdx(null);
  }

  // ============================================================
  // 渲染
  // ============================================================
  const hasShots = shots.length > 0;
  const hasResult = !!task && task.status === "done";

  return (
    <div className="min-h-screen bg-surface-overlay text-ink-primary">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 px-4 py-3 border-b border-line bg-surface-overlay/90 backdrop-blur flex items-center gap-3">
        <button
          onClick={() => router.push("/drafts")}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-base hover:bg-surface-overlay text-sm"
        >
          <ChevronLeft className="w-4 h-4" /> 返回
        </button>
        <h1 className="text-lg font-bold flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-warning" />
          🎯 提示词速转
        </h1>
        <span className="text-xs text-ink-secondary">脱离剧本流, 直接把已有内容转为视频/图片提示词</span>
        <QuotaBadge kind="prompt_converter" className="ml-2" />
        {task && (
          <button
            onClick={reset}
            className="ml-auto flex items-center gap-1 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-surface-overlay text-xs"
          >
            <Trash2 className="w-3.5 h-3.5" /> 重置
          </button>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Step 1: 输入 */}
        {!task && (
          <section className="bg-surface-base/50 border border-line rounded-xl p-5">
            <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-warning/15 text-warning text-xs flex items-center justify-center">1</span>
              输入剧情/分镜
            </h2>

            {/* 模式 tab */}
            <div className="flex gap-1 mb-4 bg-surface-overlay/50 rounded-lg p-1">
              {[
                { v: "text", label: "📝 自由文本", desc: "粘贴章节/剧本/分镜表" },
                { v: "json", label: "🧩 分镜 JSON", desc: "高级用户" },
                { v: "draft", label: "📂 从已有草稿", desc: "复用现有分镜" },
              ].map((t) => (
                <button
                  key={t.v}
                  onClick={() => { setMode(t.v as any); setShots([]); setStructErr(null); }}
                  className={`flex-1 px-3 py-2 rounded-md text-sm transition ${
                    mode === t.v ? "bg-warning/15 border border-warning/40 text-warning" : "text-ink-secondary hover:text-ink-primary"
                  }`}
                >
                  {t.label}
                  <div className="text-[10px] opacity-70 mt-0.5">{t.desc}</div>
                </button>
              ))}
            </div>

            {/* 输入区 */}
            {mode === "text" && (
              <div>
                <textarea
                  value={freeText}
                  onChange={(e) => setFreeText(e.target.value)}
                  rows={10}
                  placeholder={`粘贴章节文字、剧本片段或分镜描述...\n\n示例:\n${SAMPLE_TEXT}`}
                  className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-sm font-mono"
                />
                <div className="text-xs text-ink-muted mt-1">
                  {freeText.length}/10000 字 · AI 会智能拆为 3-15 秒/镜的分镜
                </div>
                <button
                  onClick={() => setFreeText(SAMPLE_TEXT)}
                  className="text-xs text-ink-secondary hover:text-warning mt-1"
                >
                  📋 填入示例
                </button>
              </div>
            )}

            {mode === "json" && (
              <div>
                <textarea
                  value={shotsJsonText}
                  onChange={(e) => setShotsJsonText(e.target.value)}
                  rows={12}
                  placeholder={`提供 shots[] 数组 JSON, 字段对齐分镜系统:\n\n${SAMPLE_JSON}`}
                  className="w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-xs font-mono"
                />
                <button
                  onClick={() => setShotsJsonText(SAMPLE_JSON)}
                  className="text-xs text-ink-secondary hover:text-warning mt-1"
                >
                  📋 填入示例
                </button>
              </div>
            )}

            {mode === "draft" && (
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-ink-secondary">选择草稿</label>
                  <select
                    value={selectedDraftId || ""}
                    onChange={(e) => { setSelectedDraftId(Number(e.target.value) || null); setSelectedChapters([]); }}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-sm"
                  >
                    <option value="">— 请选择草稿 —</option>
                    {drafts.map((d) => (
                      <option key={d.id} value={d.id}>#{d.id} {d.title}</option>
                    ))}
                  </select>
                </div>
                {selectedDraftId && draftChapters.length > 0 && (
                  <div>
                    <label className="text-xs text-ink-secondary">选择章节 (可多选, 不选=全部)</label>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {draftChapters.map((c) => (
                        <button
                          key={c.chapter_order}
                          onClick={() => {
                            const ch = c.chapter_order;
                            setSelectedChapters((prev) =>
                              prev.includes(ch) ? prev.filter((x) => x !== ch) : [...prev, ch]
                            );
                          }}
                          className={`px-3 py-1 rounded-md text-xs ${
                            selectedChapters.includes(c.chapter_order)
                              ? "bg-warning/20 border border-warning/60 text-warning"
                              : "bg-surface-overlay hover:bg-surface-overlay text-ink-primary"
                          }`}
                        >
                          Ch{c.chapter_order}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {selectedDraftId && draftChapters.length === 0 && (
                  <div className="text-xs text-warning">⚠️ 该草稿尚无分镜数据, 请先在草稿页跑分镜阶段</div>
                )}
              </div>
            )}

            {structErr && (
              <div className="mt-3 px-3 py-2 bg-danger/10 border border-danger/40 rounded text-danger text-sm">
                ⚠ {structErr}
              </div>
            )}

            <button
              onClick={doStructure}
              disabled={structuring}
              className="mt-4 px-5 py-2 bg-warning hover:bg-warning/90 disabled:opacity-50 rounded-lg font-semibold flex items-center gap-2"
            >
              {structuring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {structuring ? "结构化中..." : (mode === "text" ? "AI 智能拆镜" : mode === "json" ? "解析 JSON" : "从草稿加载")}
            </button>
          </section>
        )}

        {/* Step 2: 审阅 shots + 选模板 + 启动渲染 */}
        {hasShots && !task && (
          <section className="bg-surface-base/50 border border-line rounded-xl p-5">
            <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-warning/15 text-warning text-xs flex items-center justify-center">2</span>
              审阅分镜 + 选模板
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs text-ink-secondary">视频模型 (必选)</label>
                <select
                  value={videoKey}
                  onChange={(e) => setVideoKey(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-sm"
                >
                  <option value="">— 选择视频模型 —</option>
                  {videoTpls.map((t) => (
                    <option key={t.key} value={t.key}>{t.label} {t.provider ? `(${t.provider})` : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-ink-secondary">首帧图模型 (可选)</label>
                <select
                  value={imageKey}
                  onChange={(e) => setImageKey(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-sm"
                >
                  <option value="">— 不生成首帧图 —</option>
                  {imageTpls.map((t) => (
                    <option key={t.key} value={t.key}>{t.label} {t.provider ? `(${t.provider})` : ""}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-ink-secondary">任务标题 (用于导出/保存)</label>
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-surface-overlay border border-line text-sm"
                  maxLength={80}
                />
              </div>
            </div>

            <div className="mb-3 text-sm text-ink-primary">
              共 <b className="text-warning">{shots.length}</b> 个分镜:
            </div>
            <div className="max-h-96 overflow-y-auto space-y-2 mb-4">
              {shots.map((s, i) => (
                <div key={i} className="px-3 py-2 bg-surface-overlay/50 border border-line rounded text-xs">
                  <div className="flex items-center gap-2 mb-1 text-ink-secondary">
                    <span className="font-bold text-warning">#{s.shot_no}</span>
                    <span>{s.location}</span>
                    <span>{s.shot_type}</span>
                    <span>{s.duration_s}s</span>
                    {s.characters?.length > 0 && <span>· {s.characters.join(",")}</span>}
                  </div>
                  <div className="text-ink-primary whitespace-pre-wrap">{s.action}</div>
                  {s.dialogue && <div className="text-ink-muted mt-1">「{s.dialogue}」</div>}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => { setShots([]); setStructErr(null); }}
                className="px-4 py-2 bg-surface-overlay hover:bg-surface-overlay rounded-lg text-sm"
              >
                ← 重新输入
              </button>
              <button
                onClick={doRun}
                disabled={running || !videoKey}
                className="ml-auto px-5 py-2 bg-warning hover:bg-warning/90 disabled:opacity-50 rounded-lg font-semibold flex items-center gap-2"
              >
                {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {running ? "启动中..." : "🎬 开始渲染"}
              </button>
            </div>
          </section>
        )}

        {/* Step 3: 任务进行中 / 结果 */}
        {task && (
          <section className="bg-surface-base/50 border border-line rounded-xl p-5">
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-base font-semibold flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-warning/15 text-warning text-xs flex items-center justify-center">3</span>
                {task.status === "running" ? "渲染中..." : task.status === "done" ? "✓ 完成" : "✗ 失败"}
              </h2>
              <span className="text-xs text-ink-secondary">
                {task.video_template_label}{task.image_template_label ? ` + ${task.image_template_label}` : ""} · {task.shot_count} 镜 → {task.task_count || 0} 段
              </span>
              <span className="ml-auto text-xs text-ink-muted">task_id: {task.task_id}</span>
            </div>

            {/* 进度条 */}
            {task.status === "running" && (
              <div className="mb-3">
                <div className="h-2 bg-surface-overlay rounded-full overflow-hidden">
                  <div className="h-full bg-warning transition-all" style={{ width: `${task.progress}%` }} />
                </div>
                <div className="text-xs text-ink-secondary mt-1">{task.progress}% · {task.stage}</div>
              </div>
            )}

            {/* 错误 */}
            {task.error && (
              <div className="mb-3 px-3 py-2 bg-danger/10 border border-danger/40 rounded text-danger text-sm">
                ⚠ {task.error}
              </div>
            )}

            {/* 日志 (折叠) */}
            <details className="mb-3">
              <summary className="text-xs text-ink-secondary cursor-pointer">查看日志</summary>
              <pre className="mt-1 px-2 py-1 text-xs bg-surface-overlay/50 rounded overflow-x-auto whitespace-pre-wrap">
                {task.logs.join("\n")}
              </pre>
            </details>

            {/* 顶部操作 */}
            {hasResult && (
              <div className="flex gap-2 mb-4">
                <button
                  onClick={exportTxt}
                  className="px-3 py-1.5 bg-surface-overlay hover:bg-surface-overlay rounded-lg text-sm flex items-center gap-1"
                >
                  <FileText className="w-3.5 h-3.5" /> 导出 .txt
                </button>
                <button
                  onClick={saveAsDraft}
                  disabled={savingDraft}
                  className="px-3 py-1.5 bg-primary/80 hover:bg-primary disabled:opacity-50 rounded-lg text-sm flex items-center gap-1"
                >
                  {savingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Database className="w-3.5 h-3.5" />}
                  保存为草稿
                </button>
                <span className="ml-auto text-xs text-ink-muted self-center">⏱ 24h 后自动过期, 请及时导出或保存</span>
              </div>
            )}

            {/* 渲染结果列表 */}
            <div className="space-y-3">
              {task.items.map((it, idx) => (
                <div key={idx} className="border border-line rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-surface-overlay/50 flex items-center gap-2 text-sm">
                    <span className="font-bold text-warning">任务 {it.task_index}</span>
                    <span className="text-ink-secondary">{it.duration_s}s · 镜 {it.source_shot_nos.join(",")}</span>
                    {it.user_edited && <span className="px-2 py-0.5 bg-info/15 text-info text-xs rounded">已编辑</span>}
                    <div className="ml-auto flex gap-1">
                      {editingIdx !== idx && it.video_prompt && (
                        <>
                          <button
                            onClick={() => copyText(it.video_prompt)}
                            className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs flex items-center gap-1"
                            title="复制视频 prompt"
                          >
                            <Copy className="w-3 h-3" /> 视频
                          </button>
                          {it.image_prompt && (
                            <button
                              onClick={() => copyText(it.image_prompt)}
                              className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs flex items-center gap-1"
                              title="复制图片 prompt"
                            >
                              <Copy className="w-3 h-3" /> 首帧
                            </button>
                          )}
                          <button
                            onClick={() => startEdit(idx)}
                            className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" /> 编辑
                          </button>
                          <button
                            onClick={() => regenerateItem(idx)}
                            className="px-2 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs flex items-center gap-1"
                          >
                            <RefreshCw className="w-3 h-3" /> 重生
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="p-3 space-y-2">
                    {it.summary && <div className="text-xs text-ink-muted">📌 {it.summary}</div>}
                    {editingIdx === idx ? (
                      <>
                        <div>
                          <label className="text-xs text-ink-secondary">视频 Prompt</label>
                          <textarea
                            value={editVideo}
                            onChange={(e) => setEditVideo(e.target.value)}
                            rows={6}
                            className="mt-1 w-full px-2 py-1 bg-surface-overlay border border-line rounded text-xs font-mono"
                          />
                        </div>
                        {it.image_prompt !== "" && (
                          <div>
                            <label className="text-xs text-ink-secondary">首帧图 Prompt</label>
                            <textarea
                              value={editImage}
                              onChange={(e) => setEditImage(e.target.value)}
                              rows={6}
                              className="mt-1 w-full px-2 py-1 bg-surface-overlay border border-line rounded text-xs font-mono"
                            />
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button onClick={saveEdit} className="px-3 py-1 bg-success hover:bg-success/90 rounded text-xs flex items-center gap-1">
                            <Save className="w-3 h-3" /> 保存
                          </button>
                          <button onClick={() => setEditingIdx(null)} className="px-3 py-1 bg-surface-overlay hover:bg-surface-overlay rounded text-xs">
                            取消
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {it.video_prompt && (
                          <div>
                            <div className="text-xs text-ink-secondary mb-1">🎬 视频 Prompt</div>
                            <pre className="px-2 py-1 bg-surface-overlay/50 rounded text-xs whitespace-pre-wrap break-words text-ink-primary">
                              {it.video_prompt}
                            </pre>
                          </div>
                        )}
                        {it.image_prompt && (
                          <div>
                            <div className="text-xs text-ink-secondary mb-1">🎨 首帧图 Prompt</div>
                            <pre className="px-2 py-1 bg-surface-overlay/50 rounded text-xs whitespace-pre-wrap break-words text-ink-primary">
                              {it.image_prompt}
                            </pre>
                          </div>
                        )}
                        {!it.video_prompt && task.status === "running" && (
                          <div className="text-xs text-ink-muted">⏳ 渲染中...</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
