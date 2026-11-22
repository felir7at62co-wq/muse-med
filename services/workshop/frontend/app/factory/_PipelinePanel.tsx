"use client";
import { useState, useEffect, useCallback } from "react";
import { Loader2, Play, Plus, Trash2, CheckCircle, XCircle, Workflow, Pencil } from "lucide-react";
import { Button, Badge } from "@/components/ui";
import { getToken } from "../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

const STEP_LABELS: Record<string, string> = {
  video_transcribe: "视频转剧本",
  create_spawn: "从零创作",
  import_spawn: "裂变",
  distribute: "分发",
};
const PROVIDERS = ["gemini", "qwen", "deepseek", "gpt5", "claude"];
const STAGE_LABELS: Record<string, string> = {
  brainstorm: "创意", outline: "大纲", check: "质检", script: "剧本", novel: "小说", tweet: "推文",
};

type HitStatus = { ready: boolean; error?: string; queue?: Record<string, number>; maxSlots?: number };
const HIT_DEFAULTS = { count: 0, concurrency: 1, quality: "720p", publish: false, only_series: "" };
const hitSummary = (c: any) => [
  c?.count ? `${c.count}部` : "持续",
  `同时${c?.concurrency ?? 1}部`,
  c?.quality || "720p",
  c?.publish ? "自动上架" : "",
  (c?.only_series || []).length ? `指定${c.only_series.length}部` : "",
].filter(Boolean).join(" · ");

export function PipelinePanel() {
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}`, "Content-Type": "application/json" });
  const [pipelines, setPipelines] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);  // 非null=编辑既有预设
  const [running, setRunning] = useState<number | null>(null);

  // 编辑器状态
  const [pName, setPName] = useState("");
  const [enableHit, setEnableHit] = useState(false);
  const [hitCfg, setHitCfg] = useState(HIT_DEFAULTS);
  const [hitStatus, setHitStatus] = useState<HitStatus | null>(null);
  const [enableCreate, setEnableCreate] = useState(true);
  const [createCfg, setCreateCfg] = useState({ total_scripts: 10, episodes: 50, words_per_chapter: 1000, theme: "" });
  const [enableSpawn, setEnableSpawn] = useState(false);
  const [spawnNovel, setSpawnNovel] = useState(true);
  const [spawnTweet, setSpawnTweet] = useState(true);
  const [enableDist, setEnableDist] = useState(false);
  const [distTargetId, setDistTargetId] = useState(0);
  // 分发产物类型(剧本/小说/推文可分别勾选)
  const [distScript, setDistScript] = useState(true);
  const [distNovel, setDistNovel] = useState(true);
  const [distTweet, setDistTweet] = useState(true);
  const [modelCfg, setModelCfg] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pr, rr, tr] = await Promise.all([
        fetch(`${API}/pipelines`, { headers: authHeaders() }),
        fetch(`${API}/pipeline-runs?limit=8`, { headers: authHeaders() }),
        fetch(`${API}/dist-targets`, { headers: authHeaders() }),
      ]);
      if (pr.ok) setPipelines(await pr.json());
      if (rr.ok) setRuns(await rr.json());
      if (tr.ok) setTargets(await tr.json());
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!showEditor) return;
    fetch(`${API}/video-transcribe/status`, { headers: authHeaders() })
      .then((r) => r.ok ? r.json() : null).then(setHitStatus).catch(() => setHitStatus(null));
  }, [showEditor]);
  // 有运行中的流时轮询
  useEffect(() => {
    if (!runs.some((r) => r.status === "running")) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [runs, load]);

  const handleSave = async () => {
    if (!pName.trim()) { alert("请填预设名称"); return; }
    const steps: any[] = [];
    if (enableHit) steps.push({ type: "video_transcribe", config: { ...hitCfg, only_series: hitCfg.only_series.split(/[\s,，、]+/).filter(Boolean) } });
    if (enableCreate) steps.push({ type: "create_spawn", config: { ...createCfg } });
    if (enableSpawn) steps.push({ type: "import_spawn", config: { spawn_config: { novel: { enabled: spawnNovel, count: 1 }, tweet: { enabled: spawnTweet, count: 1 }, video: { enabled: false } } } });
    if (enableDist && distTargetId) {
      const ptypes = [distScript && "script", distNovel && "novel", distTweet && "tweet"].filter(Boolean);
      if (ptypes.length === 0) { alert("分发步骤请至少勾选一种产物类型"); return; }
      steps.push({ type: "distribute", config: { target_id: distTargetId, product_types: ptypes } });
    }
    if (steps.length === 0) { alert("请至少启用一个步骤"); return; }
    setSaving(true);
    try {
      const url = editingId ? `${API}/pipelines/${editingId}` : `${API}/pipelines`;
      const r = await fetch(url, {
        method: editingId ? "PUT" : "POST", headers: authHeaders(),
        body: JSON.stringify({ name: pName, steps, model_config_map: modelCfg }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "保存失败");
      closeEditor();
      await load();
    } catch (e: any) { alert(`❌ ${e.message}`); } finally { setSaving(false); }
  };

  const closeEditor = () => {
    setShowEditor(false); setEditingId(null); setPName("");
    setEnableHit(false); setHitCfg(HIT_DEFAULTS);
    setEnableCreate(true); setCreateCfg({ total_scripts: 10, episodes: 50, words_per_chapter: 1000, theme: "" });
    setEnableSpawn(false); setSpawnNovel(true); setSpawnTweet(true);
    setEnableDist(false); setDistTargetId(0);
    setDistScript(true); setDistNovel(true); setDistTweet(true);
    setModelCfg({});
  };

  const handleEdit = (p: any) => {
    // 把既有预设的steps回填到编辑器
    setEditingId(p.id); setPName(p.name || "");
    const steps: any[] = p.steps || [];
    const vt = steps.find((s) => s.type === "video_transcribe");
    setEnableHit(!!vt);
    setHitCfg(vt ? { ...HIT_DEFAULTS, ...vt.config, only_series: (vt.config?.only_series || []).join(", ") } : HIT_DEFAULTS);
    const cs = steps.find((s) => s.type === "create_spawn");
    setEnableCreate(!!cs);
    if (cs) setCreateCfg({
      total_scripts: cs.config?.total_scripts ?? 10,
      episodes: cs.config?.episodes ?? 50,
      words_per_chapter: cs.config?.words_per_chapter ?? 1000,
      theme: cs.config?.theme ?? "",
    });
    const sp = steps.find((s) => s.type === "import_spawn");
    setEnableSpawn(!!sp);
    setSpawnNovel(sp ? !!sp.config?.spawn_config?.novel?.enabled : true);
    setSpawnTweet(sp ? !!sp.config?.spawn_config?.tweet?.enabled : true);
    const ds = steps.find((s) => s.type === "distribute");
    setEnableDist(!!ds);
    setDistTargetId(ds?.config?.target_id ?? 0);
    const pt: string[] = ds?.config?.product_types || ["script", "novel", "tweet"];
    setDistScript(pt.includes("script"));
    setDistNovel(pt.includes("novel"));
    setDistTweet(pt.includes("tweet"));
    setModelCfg(p.model_config || {});
    setShowEditor(true);
  };

  const handleRun = async (id: number, name: string) => {
    if (!confirm(`执行预设「${name}」？将自动完成全部步骤。`)) return;
    setRunning(id);
    try {
      const r = await fetch(`${API}/pipelines/${id}/run`, { method: "POST", headers: authHeaders() });
      if (!r.ok) throw new Error("启动失败");
      await load();
    } catch (e: any) { alert(`❌ ${e.message}`); } finally { setRunning(null); }
  };

  const handleResume = async (runId: number, name: string) => {
    if (!confirm(`断点续跑「${name}」？已完成部分将跳过, 从中断处继续。`)) return;
    try {
      const r = await fetch(`${API}/pipeline-runs/${runId}/resume`, { method: "POST", headers: authHeaders() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "续跑失败");
      await load();
    } catch (e: any) { alert(`❌ ${e.message}`); }
  };

  const handleStop = async (run: any) => {
    const step = (run.step_runs || []).find((s: any) => s.status === "running" && s.job_id);
    if (!step || !confirm(`停止「${run.pipeline_name}」？正在转写的剧会保留进度，断点续跑时接着转。`)) return;
    await fetch(`${API}/jobs/${step.job_id}/stop`, { method: "POST", headers: authHeaders() });
    await load();
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`删除预设「${name}」？`)) return;
    await fetch(`${API}/pipelines/${id}`, { method: "DELETE", headers: authHeaders() });
    await load();
  };

  const activeRuns = runs.filter((r) => r.status === "running");
  const recentRuns = runs.filter((r) => r.status !== "running").slice(0, 3);

  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-line">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Workflow className="w-5 h-5 text-primary" /> 自动化流水线
          {activeRuns.length > 0 && (
            <Badge className="bg-blue-500 text-white">{activeRuns.length} 运行中</Badge>
          )}
        </h2>
        <Button size="sm" variant="outline" onClick={() => { if (showEditor) { closeEditor(); } else { setShowEditor(true); } }}>
          <Plus className="w-4 h-4 mr-1" /> 新建预设
        </Button>
      </div>

      {/* 运行中的自动流(实时) */}
      {activeRuns.length > 0 && (
        <div className="space-y-3 mb-4">
          {activeRuns.map((r) => (
            <div key={r.id} className="p-4 border-2 border-blue-200 bg-blue-50/50 rounded-xl">
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  {r.pipeline_name}
                </span>
                <span className="flex items-center gap-2 text-xs text-ink-secondary">步骤 {Math.min(r.current_step + 1, r.total_steps)}/{r.total_steps}
                  <button onClick={() => handleStop(r)} className="px-1.5 py-0.5 rounded border border-red-300 text-red-600 hover:bg-red-50">停止</button>
                </span>
              </div>
              <div className="flex items-center gap-2">
                {(r.step_runs || []).map((s: any, i: number) => (
                  <div key={i} className={`flex-1 p-2 rounded-lg text-xs text-center border ${
                    s.status === "running" ? "bg-blue-100 border-blue-300 text-blue-700"
                    : s.status === "completed" || s.status === "succeeded" ? "bg-green-50 border-green-300 text-green-700"
                    : s.status === "failed" ? "bg-red-50 border-red-300 text-red-700"
                    : "bg-gray-50 border-gray-200 text-gray-500"
                  }`}>
                    <div className="font-medium">{STEP_LABELS[s.type] || s.type}</div>
                    <div className="mt-0.5">{s.status === "running" ? "执行中..." : (s.summary || s.status)}</div>
                    {s.job_id && (
                      <a href={`/jubengongfang/factory/jobs/${s.job_id}`} className="text-primary hover:underline">查看任务 #{s.job_id}</a>
                    )}
                  </div>
                ))}
                {Array.from({ length: Math.max(0, r.total_steps - (r.step_runs || []).length) }).map((_, i) => (
                  <div key={`p${i}`} className="flex-1 p-2 rounded-lg text-xs text-center border bg-gray-50 border-gray-200 text-gray-400">待执行</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 预设列表 */}
      {pipelines.length === 0 && !showEditor ? (
        <p className="text-sm text-ink-secondary text-center py-4">暂无预设，点击“新建预设”组合自动流(创作→裂变→分发)</p>
      ) : (
        <div className="space-y-2">
          {pipelines.map((p) => {
            const steps: any[] = p.steps || [];
            const vt = steps.find((s: any) => s.type === "video_transcribe");
            const cs = steps.find((s: any) => s.type === "create_spawn");
            const sp = steps.find((s: any) => s.type === "import_spawn");
            const ds = steps.find((s: any) => s.type === "distribute");
            const spawnKinds = sp ? [
              sp.config?.spawn_config?.novel?.enabled && "小说",
              sp.config?.spawn_config?.tweet?.enabled && "推文",
            ].filter(Boolean).join("+") : "";
            const distTypes = ds ? ((ds.config?.product_types || ["script", "novel", "tweet"]) as string[])
              .map((t) => ({ script: "剧本", novel: "小说", tweet: "推文" } as any)[t] || t).join("+") : "";
            const distName = ds ? (targets.find((t) => t.id === ds.config?.target_id)?.name || `目标#${ds.config?.target_id}`) : "";
            return (
              <div key={p.id} className="flex items-center justify-between p-3 border border-line rounded-lg hover:border-primary transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{p.name}</div>
                  {/* 步骤要点标签: 一眼看清这条流水线做什么 */}
                  <div className="text-xs mt-1 flex items-center gap-1.5 flex-wrap">
                    {vt && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">
                        转写 {hitSummary(vt.config)}
                      </span>
                    )}
                    {cs && (
                      <span className="px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">
                        创作 {cs.config?.total_scripts ?? "?"}部×{cs.config?.episodes ?? "?"}集×{cs.config?.words_per_chapter ?? "?"}字/集
                        {cs.config?.theme ? ` · 主题:${cs.config.theme}` : ""}
                      </span>
                    )}
                    {sp && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-50 border border-purple-200 text-purple-700">
                        裂变 {spawnKinds || "-"}
                      </span>
                    )}
                    {ds && (
                      <span className="px-1.5 py-0.5 rounded bg-green-50 border border-green-200 text-green-700">
                        分发 {distTypes} → {distName}
                      </span>
                    )}
                    {Object.keys(p.model_config || {}).length > 0 && (
                      <span className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-500">
                        {Object.entries(p.model_config).map(([k, v]) => `${STAGE_LABELS[k] || k}:${v}`).join(" ")}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 ml-3">
                  <Button size="sm" onClick={() => handleRun(p.id, p.name)} disabled={running === p.id}>
                    {running === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 mr-1" />}
                    执行
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => handleEdit(p)} title="编辑预设">
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-red-500" onClick={() => handleDelete(p.id, p.name)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 最近执行记录 */}
      {recentRuns.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-ink-secondary cursor-pointer">最近执行记录 ({recentRuns.length})</summary>
          <div className="mt-2 space-y-1">
            {recentRuns.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs text-ink-secondary p-2 bg-surface-elevated rounded">
                {r.status === "completed" ? <CheckCircle className="w-3 h-3 text-green-500" /> : <XCircle className="w-3 h-3 text-red-500" />}
                <span>{r.pipeline_name}</span>
                <span>· {(r.step_runs || []).map((s: any) => s.summary).filter(Boolean).join(" / ")}</span>
                {r.status !== "completed" && (
                  <button onClick={() => handleResume(r.id, r.pipeline_name)}
                    className="px-1.5 py-0.5 rounded border border-blue-300 text-blue-600 hover:bg-blue-50">
                    断点续跑
                  </button>
                )}
                <span className="ml-auto">{r.created_at ? new Date(r.created_at + "Z").toLocaleString("zh-CN") : ""}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* 预设编辑器 */}
      {showEditor && (
        <div className="mt-4 p-4 border-2 border-dashed border-line rounded-xl space-y-4">
          {editingId && (
            <div className="text-sm font-medium text-blue-600 flex items-center gap-1.5">
              <Pencil className="w-4 h-4" /> 编辑预设 #{editingId}
            </div>
          )}
          <input
            className="w-full border border-line rounded-lg px-3 py-2 text-sm"
            placeholder="预设名称, 如: 周更20部悬疑+全裂变+分发A组"
            value={pName}
            onChange={(e) => setPName(e.target.value)}
          />

          {/* 剧本来源: 视频转剧本 */}
          <div className={`p-3 rounded-lg border ${enableHit ? "border-amber-300 bg-amber-50/40" : "border-line"}`}>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={enableHit} onChange={(e) => { setEnableHit(e.target.checked); if (e.target.checked) setEnableCreate(false); }} />
              ① 视频转剧本
              {hitStatus?.ready && hitStatus.queue && <span className="text-xs font-normal text-ink-secondary">队列 {hitStatus.queue.queued ?? 0} 部</span>}
            </label>
            {enableHit && hitStatus && !hitStatus.ready && <p className="text-xs text-red-500 mt-2">{hitStatus.error}</p>}
            {enableHit && (
              <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
                <label>部数<input type="number" min={0} className="w-full border border-line rounded px-2 py-1 mt-0.5" placeholder="0 = 持续" value={hitCfg.count} onChange={(e) => setHitCfg({ ...hitCfg, count: Math.max(0, parseInt(e.target.value) || 0) })} /></label>
                <label>同时转写<input type="number" min={1} max={hitStatus?.maxSlots ?? 4} className="w-full border border-line rounded px-2 py-1 mt-0.5" value={hitCfg.concurrency} onChange={(e) => setHitCfg({ ...hitCfg, concurrency: Math.min(hitStatus?.maxSlots ?? 4, Math.max(1, parseInt(e.target.value) || 1)) })} /></label>
                <label>画质<select className="w-full border border-line rounded px-2 py-1 mt-0.5" value={hitCfg.quality} onChange={(e) => setHitCfg({ ...hitCfg, quality: e.target.value })}><option value="720p">720p</option><option value="1080p">1080p</option></select></label>
                <label className="flex items-end gap-1 pb-1"><input type="checkbox" checked={hitCfg.publish} onChange={(e) => setHitCfg({ ...hitCfg, publish: e.target.checked })} />通过检查后上架</label>
                <label className="col-span-4">只转这些剧<input className="w-full border border-line rounded px-2 py-1 mt-0.5" placeholder="红果作品编号，留空按队列" value={hitCfg.only_series} onChange={(e) => setHitCfg({ ...hitCfg, only_series: e.target.value })} /></label>
              </div>
            )}
          </div>

          {/* 步骤1: 从零创作 */}
          <div className={`p-3 rounded-lg border ${enableCreate ? "border-blue-300 bg-blue-50/40" : "border-line"}`}>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={enableCreate} onChange={(e) => { setEnableCreate(e.target.checked); if (e.target.checked) setEnableHit(false); }} />
              ① 从零创作
            </label>
            {enableCreate && (
              <div className="grid grid-cols-4 gap-2 mt-2 text-xs">
                <label>剧本数<input type="number" min={1} className="w-full border border-line rounded px-2 py-1 mt-0.5" value={createCfg.total_scripts} onChange={(e) => setCreateCfg({ ...createCfg, total_scripts: parseInt(e.target.value) || 1 })} /></label>
                <label>每部集数<input type="number" min={10} className="w-full border border-line rounded px-2 py-1 mt-0.5" value={createCfg.episodes} onChange={(e) => setCreateCfg({ ...createCfg, episodes: parseInt(e.target.value) || 50 })} /></label>
                <label>每集字数<input type="number" min={500} step={100} className="w-full border border-line rounded px-2 py-1 mt-0.5" value={createCfg.words_per_chapter} onChange={(e) => setCreateCfg({ ...createCfg, words_per_chapter: parseInt(e.target.value) || 1000 })} /></label>
                <label>主题(选填)<input className="w-full border border-line rounded px-2 py-1 mt-0.5" placeholder="留空自由发散" value={createCfg.theme} onChange={(e) => setCreateCfg({ ...createCfg, theme: e.target.value })} /></label>
              </div>
            )}
          </div>

          {/* 步骤2: 裂变 */}
          <div className={`p-3 rounded-lg border ${enableSpawn ? "border-purple-300 bg-purple-50/40" : "border-line"}`}>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={enableSpawn} onChange={(e) => setEnableSpawn(e.target.checked)} />
              ② 裂变(对上一步产出的全部剧本)
            </label>
            {enableSpawn && (
              <div className="flex gap-4 mt-2 text-xs">
                <label className="flex items-center gap-1"><input type="checkbox" checked={spawnNovel} onChange={(e) => setSpawnNovel(e.target.checked)} />生成小说</label>
                <label className="flex items-center gap-1"><input type="checkbox" checked={spawnTweet} onChange={(e) => setSpawnTweet(e.target.checked)} />生成推文</label>
              </div>
            )}
          </div>

          {/* 步骤3: 分发 */}
          <div className={`p-3 rounded-lg border ${enableDist ? "border-green-300 bg-green-50/40" : "border-line"}`}>
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <input type="checkbox" checked={enableDist} onChange={(e) => setEnableDist(e.target.checked)} />
              ③ 分发(全部产物自动分发到飞书)
            </label>
            {enableDist && (
              <div className="mt-2 space-y-2">
                <select className="w-full border border-line rounded px-2 py-1.5 text-xs" value={distTargetId} onChange={(e) => setDistTargetId(parseInt(e.target.value) || 0)}>
                  <option value={0}>选择分发目标...</option>
                  {targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <div className="flex gap-4 text-xs items-center">
                  <span className="text-ink-secondary">分发产物:</span>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={distScript} onChange={(e) => setDistScript(e.target.checked)} />剧本</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={distNovel} onChange={(e) => setDistNovel(e.target.checked)} />小说</label>
                  <label className="flex items-center gap-1"><input type="checkbox" checked={distTweet} onChange={(e) => setDistTweet(e.target.checked)} />推文</label>
                </div>
              </div>
            )}
          </div>

          {/* 模型配置 */}
          <details>
            <summary className="text-sm font-medium cursor-pointer">阶段模型配置(默认全gemini)</summary>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {Object.keys(STAGE_LABELS).map((stage) => (
                <label key={stage} className="text-xs">
                  {STAGE_LABELS[stage]}
                  <select
                    className="w-full border border-line rounded px-2 py-1 mt-0.5"
                    value={modelCfg[stage] || ""}
                    onChange={(e) => setModelCfg({ ...modelCfg, [stage]: e.target.value })}
                  >
                    <option value="">默认(gemini)</option>
                    {PROVIDERS.map((pv) => <option key={pv} value={pv}>{pv}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </details>

          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={saving} className="flex-1">
              {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {editingId ? "保存修改" : "保存预设"}
            </Button>
            <Button variant="ghost" onClick={closeEditor}>取消</Button>
          </div>
        </div>
      )}
    </div>
  );
}
