"use client";
import { useEffect, useState } from "react";
import { confirmAsync, notifySuccess, notifyError } from "@/lib/dialog";
import { useParams, useRouter } from "next/navigation";
import { RefreshCw, Save, Zap } from "lucide-react";
import { authFetch } from "../../../../lib/auth";
import ContractFold from "../_ContractFold";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

/**
 * 注: 此页面是 /drafts/[id]/outline 独立入口, 与工作台主页 /drafts/[id]?tab=outline
 * 提供基本相同的能力, 主要给后端 redirect / 老链接保留. 视觉与主体风格对齐 (token 化).
 */

export default function OutlineEditPage() {
  const params = useParams();
  const router = useRouter();
  const draftId = params.id as string;
  
  const [draft, setDraft] = useState<any>(null);
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{msg: string; type: 'success'|'error'} | null>(null);
  const [lintReport, setLintReport] = useState<any>(null);
  const [linting, setLinting] = useState(false);
  // D6: 剧情结构门禁（零 LLM，秒级返回）
  const [dramaReport, setDramaReport] = useState<any>(null);
  const [gating, setGating] = useState(false);
  // 2026-10-09：大纲可生成度（零 LLM，随草稿一起拿）
  const [density, setDensity] = useState<any>(null);
  const [expanding, setExpanding] = useState(false);
  // 2026-10-09：扩写后的人物越界审计（强模型会编出全剧不存在的人名）
  const [charIssues, setCharIssues] = useState<Record<string, string[]>>({});

  useEffect(() => {
    fetchDraft();
  }, [draftId]);

  async function fetchDraft() {
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}`);
      if (res.ok) {
        const data = await res.json();
        setDraft(data);
        const eps = data.outline?.chapters || data.outline?.episodes || [];
        setEpisodes(eps);
        setLintReport(data.outline?.lint_report || null);
        setDramaReport(data.outline?.drama_report || null);
      }
      // 可生成度单独取（零 LLM，独立于草稿响应 —— 免得草稿接口变重）
      try {
        const dres = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/density`);
        if (dres.ok) setDensity(await dres.json());
      } catch {
        // 拿不到只是少一条提示，不影响页面
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  // P2/P6: 触发一致性校验(硬伤检测), 只标注不自动改
  async function runLint() {
    setLinting(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/lint`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setLintReport(data.lint_report || null);
        const s = data.lint_report?.summary || { error: 0, warn: 0 };
        setToast({ msg: `校验完成: ${s.error} 个硬伤, ${s.warn} 个提醒`, type: s.error > 0 ? "error" : "success" });
      } else {
        setToast({ msg: "校验失败", type: "error" });
      }
      setTimeout(() => setToast(null), 3000);
    } catch (e) {
      setToast({ msg: "校验失败", type: "error" });
      setTimeout(() => setToast(null), 2000);
    } finally {
      setLinting(false);
    }
  }

  // 按集号归组 issues, 供每集标注
  function issuesForEpisode(order: number): any[] {
    const all = lintReport?.issues || [];
    return all.filter((i: any) => i.episode === order);
  }

  // D6: 跑剧情结构门禁（查"疲软"：没钩子/没升级/伏笔没收）
  // 与"校验硬伤"的分工：那个查矛盾(自洽)，这个查结构(好看)。零 LLM，秒级。
  async function runDramaGate() {
    setGating(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/drama-gate`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setDramaReport(data.drama_report || null);
        const s = data.drama_report?.summary || { error: 0, warn: 0 };
        setToast({
          msg: `门禁完成：${s.error} 个结构问题, ${s.warn} 个提醒（未计费）`,
          type: s.error > 0 ? "error" : "success",
        });
      } else {
        const msg = await res.json().catch(() => ({}));
        setToast({ msg: msg.detail || "门禁执行失败", type: "error" });
      }
      setTimeout(() => setToast(null), 3500);
    } catch (e) {
      setToast({ msg: "门禁执行失败", type: "error" });
      setTimeout(() => setToast(null), 2500);
    } finally {
      setGating(false);
    }
  }

  // 门禁 issues 按集归组（与 lint 分开统计，两类问题性质不同）
  function gateIssuesForEpisode(order: number): any[] {
    const all = dramaReport?.issues || [];
    return all.filter((i: any) => i.episode === order);
  }

  async function updateEpisode(order: number, title: string, synopsis: string) {
    setSaving(true);
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/episodes/${order}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, synopsis }),
      });
      setToast({ msg: "保存成功", type: "success" });
      setTimeout(() => setToast(null), 2000);
      fetchDraft();
    } catch (e) {
      setToast({ msg: "保存失败", type: "error" });
      setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function regenerateSolo(order: number) {
    if (!(await confirmAsync({ title: `重新生成第 ${order} 集`, tone: "warning", confirmText: "重新生成" }))) return;
    setSaving(true);
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/episodes/${order}/regenerate-solo`, {
        method: "POST",
      });
      setToast({ msg: "重新生成成功", type: "success" });
      setTimeout(() => setToast(null), 2000);
      fetchDraft();
    } catch (e) {
      setToast({ msg: "重新生成失败", type: "error" });
      setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function regenerateFrom(order: number) {
    const total = episodes.length;
    if (!(await confirmAsync({ title: `重新生成第 ${order}-${total} 集`, description: `共 ${total - order + 1} 集`, tone: "warning", confirmText: "开始" }))) return;
    setSaving(true);
    try {
      await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/regenerate-range`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ start_order: order, end_order: total }),
      });
      setToast({ msg: `正在生成${total - order + 1}集...`, type: "success" });
      setTimeout(() => setToast(null), 3000);
      fetchDraft();
    } catch (e) {
      setToast({ msg: "生成失败", type: "error" });
      setTimeout(() => setToast(null), 2000);
    } finally {
      setSaving(false);
    }
  }

  // 2026-10-09：把「只有简短梗概」的集扩写成有场景节拍、有戏剧契约的大纲。
  //
  // 交互取舍：**默认只补空缺**（overwrite=false），已有的节拍一个字不动 ——
  // 所以重复点是安全的。要重做已有的节拍，走下面那个勾选。
  async function expandOutline() {
    const gaps = density?.counts?.thin ?? 0;
    const fair = density?.counts?.fair ?? 0;
    const target = gaps + fair;
    const desc =
      target > 0
        ? `将扩写 ${target} 集（偏低 ${gaps} 集 + 只有梗概 ${fair} 集）：为它们补出「按顺序演哪几拍」的场景节拍与戏剧契约。\n\n` +
          `已有节拍的集不会被改动；你的标题和梗概也不会被改动。\n\n` +
          `补完你可以逐条看、逐条改，改好了再生成正文/剧本 —— 这样写出来的才是你要的戏。`
        : "将扩写还没有场景节拍的集。已有节拍与你写的标题/梗概都不会被改动。";
    if (
      !(await confirmAsync({
        title: "补全本集大纲",
        description: desc,
        confirmText: "开始补全",
      }))
    )
      return;
    setExpanding(true);
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/${draftId}/outline/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 如实报错，不谎报成功（后端在扩写失败时是 502 + 原有大纲一字未改）
        notifyError(data?.detail || data?.message || "补全失败，请稍后重试");
        return;
      }
      // 2026-10-09：扩写出来的集里，若模型编了全剧不存在的人物，
      // 在这里显式提示。后端只报不改 —— 内容照常写入，由用户判断。
      setCharIssues(data?.char_issues || {});
      notifySuccess(data?.message || `已补全 ${data?.expanded ?? 0} 集`);
      await fetchDraft();
    } catch (e) {
      console.error(e);
      notifyError("补全失败，请稍后重试");
    } finally {
      setExpanding(false);
    }
  }

  if (loading) return <div className="p-8 bg-surface-base min-h-screen text-ink-primary">加载中...</div>;

  return (
    <div className="min-h-screen bg-surface-base text-ink-primary p-8">
      {toast && (
        <div
          className={`fixed top-4 right-4 px-4 py-2 rounded-lg shadow-lg z-50 ${
            toast.type === "success" ? "bg-success text-white" : "bg-danger text-white"
          }`}
        >
          {toast.msg}
        </div>
      )}
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">{draft?.title} - 大纲编辑</h1>
            <p className="text-sm text-ink-secondary mt-1">共 {episodes.length} 集</p>
          </div>
          <div className="flex gap-2">
            {/* 2026-10-09：把薄大纲**扩写**成有节拍、有契约的大纲。
                为什么要有这个按钮（用户提问）：导入的大纲常常只有几十字一集，
                直接生成剧本时模型会大量补写大纲里没有的情节。
                与其让剧本步骤偷偷补，不如在这里明着补 —— 补出来的东西
                在这个页面上**看得见、改得动**，用户点头后再去生成。 */}
            <button
              onClick={expandOutline}
              disabled={expanding}
              className="px-4 py-2 bg-primary hover:bg-primary/90 rounded-lg text-white disabled:opacity-50"
              title="把只有简短梗概的集，扩写成「按顺序演哪几拍」的场景节拍（会调用模型）"
            >
              {expanding ? "补全中..." : "补全本集大纲"}
            </button>
            <button
              onClick={runDramaGate}
              disabled={gating}
              className="px-4 py-2 bg-success hover:bg-success/90 rounded-lg text-white disabled:opacity-50"
              title="检查剧情结构：钩子链、升级曲线、伏笔回收（纯本地，不计费）"
            >
              {gating ? "检查中..." : "跑剧情门禁"}
            </button>
            <button
              onClick={runLint}
              disabled={linting}
              className="px-4 py-2 bg-primary hover:bg-primary/90 rounded-lg text-white disabled:opacity-50"
            >
              {linting ? "校验中..." : "校验硬伤"}
            </button>
            <button
              onClick={() => router.push(`/drafts/${draftId}`)}
              className="px-4 py-2 bg-surface-overlay hover:bg-surface-overlay rounded-lg"
            >
              返回
            </button>
          </div>
        </div>

        {/* 2026-10-09：可生成度提醒 —— 在用户**去生成之前**就把风险说清楚。
            之前这件事完全不可见：用户导入一份几十字一集的大纲，直接点生成，
            拿到的是模型自己补出来的戏，而他从不知道里面有多少不是他写的。
            ⚠️ 用 warning 而非 danger：这是"信息不完整"，不是错误。 */}
        {density && (density.counts?.thin ?? 0) > 0 && (
          <div className="mb-6 p-4 rounded-xl border border-warning/50 bg-warning/10">
            <div className="flex items-center gap-3 text-sm font-medium flex-wrap">
              <span className="font-semibold">大纲信息量偏低</span>
              <span className="text-warning">
                ● {density.counts.thin} 集只有很短的梗概
                {density.counts.fair > 0 && ` · ${density.counts.fair} 集只有分集梗概`}
              </span>
              <span className="text-ink-secondary text-xs">
                平均 {density.avg_synopsis} 字/集
              </span>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-ink-secondary">
              {(density.advice || []).map((a: string, i: number) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={expandOutline}
                disabled={expanding}
                className="px-3 py-1.5 text-sm bg-primary hover:bg-primary/90 rounded-lg text-white disabled:opacity-50"
              >
                {expanding ? "补全中..." : "补全本集大纲"}
              </button>
              <span className="text-xs text-ink-secondary">
                补出来的是场景节拍，你能逐条看、逐条改 —— 比让剧本自己补可控得多。
              </span>
            </div>
          </div>
        )}

        {/* 2026-10-09：人物越界审计 —— 扩写后若模型编了全剧不存在的人，在这里点名。
            为什么值得占一块版面：实测同一提示词下，模型越强越会"自作主张"给
            身份指代补人名（草稿 624 里给"海归精英男"起名叫"林启文"，
            而这个名字全剧 60 集梗概里出现 0 次）。用户不点开看就永远发现不了，
            等到成片里多出个陌生人，返工成本已经是几十集。
            ⚠️ 只提示不改内容 —— 万一判错了，用户自己判断。 */}
        {Object.keys(charIssues).length > 0 && (
          <div className="mb-6 p-4 rounded-xl border border-danger/50 bg-danger/10">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span>⚠️ 有 {Object.keys(charIssues).length} 集出现了大纲里没有的人物</span>
              <button
                onClick={() => setCharIssues({})}
                className="ml-auto text-xs text-ink-secondary hover:text-ink-primary"
              >
                知道了
              </button>
            </div>
            <p className="mt-1 text-xs text-ink-secondary">
              这些名字在你任何一集的梗概里都找不到出处，是 AI 自己加的。
              建议核对后再生成剧本 —— 凭空多出来的人会一直演下去。
            </p>
            <ul className="mt-2 space-y-1 text-sm text-danger max-h-48 overflow-auto">
              {Object.entries(charIssues).map(([order, msgs]) => (
                <li key={order}>
                  <span className="font-mono text-xs text-ink-secondary">第{order}集：</span>
                  {(msgs || []).join("；")}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* D6: 剧情结构门禁报告（查"疲软"：钩子/升级/伏笔，与下方"硬伤"性质不同） */}
        {dramaReport && (
          <div className={`mb-6 p-4 rounded-xl border ${
            (dramaReport.summary?.error || 0) > 0
              ? "border-danger/50 bg-danger/10"
              : (dramaReport.summary?.warn || 0) > 0
                ? "border-warning/50 bg-warning/10"
                : "border-success/50 bg-success/10"
          }`}>
            <div className="flex items-center gap-3 text-sm font-medium flex-wrap">
              <span className="font-semibold">剧情结构门禁</span>
              <span className="text-danger">● {dramaReport.summary?.error || 0} 个结构问题</span>
              <span className="text-warning">● {dramaReport.summary?.warn || 0} 个提醒</span>
              <span className="text-ink-secondary text-xs">
                已检查 {dramaReport.summary?.checked || 0} 集 · 仅标注供参考，是否修订由你决定
              </span>
            </div>
            {(dramaReport.issues || []).length > 0 && (
              <ul className="mt-3 space-y-1 text-sm max-h-60 overflow-auto">
                {(dramaReport.issues || []).map((it: any, i: number) => (
                  <li key={i} className={it.level === "error" ? "text-danger" : "text-warning"}>
                    [{it.level === "error" ? "结构" : "提醒"}]
                    {typeof it.episode === "number" ? ` 第${it.episode}集:` : ""} {it.message}
                    {it.fix_hint && (
                      <span className="text-ink-secondary text-xs block ml-4">→ {it.fix_hint}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(dramaReport.summary?.error || 0) === 0 && (dramaReport.summary?.warn || 0) === 0 && (
              <p className="mt-2 text-sm text-success">
                钩子链连续、压迫强度在上升、伏笔都有回收 —— 结构没有发现问题。
              </p>
            )}
          </div>
        )}

        {/* P6: 一致性校验报告横幅(只标注,用户自行决定是否修订) */}
        {lintReport && (
          <div className={`mb-6 p-4 rounded-xl border ${
            (lintReport.summary?.error || 0) > 0
              ? "border-danger/50 bg-danger/10"
              : (lintReport.summary?.warn || 0) > 0
                ? "border-warning/50 bg-warning/10"
                : "border-success/50 bg-success/10"
          }`}>
            <div className="flex items-center gap-3 text-sm font-medium">
              <span className="text-danger">● {lintReport.summary?.error || 0} 个硬伤(error)</span>
              <span className="text-warning">● {lintReport.summary?.warn || 0} 个提醒(warn)</span>
              <span className="text-ink-secondary text-xs">仅标注供参考,是否修订由你决定</span>
            </div>
            {(lintReport.issues || []).length > 0 && (
              <ul className="mt-3 space-y-1 text-sm max-h-48 overflow-auto">
                {(lintReport.issues || []).map((it: any, i: number) => (
                  <li key={i} className={it.level === "error" ? "text-danger" : "text-warning"}>
                    [{it.level === "error" ? "硬伤" : "提醒"}] 第{it.episode}集: {it.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="space-y-4">
          {episodes.map((ep) => {
            // D6: 问题集一眼可见——红点=有 error（硬伤或结构），黄点=有 warn
            const epIssues = [...issuesForEpisode(ep.order), ...gateIssuesForEpisode(ep.order)];
            const hasErr = epIssues.some((i: any) => i.level === "error");
            const hasWarn = epIssues.some((i: any) => i.level !== "error");
            return (
            <div
              key={ep.order}
              className={`p-4 rounded-xl border bg-surface-base/30 ${
                hasErr ? "border-danger/60" : hasWarn ? "border-warning/60" : "border-line"
              }`}
            >
              <div className="flex items-start gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-mono text-ink-secondary">#{ep.order}</span>
                    {hasErr && <span className="text-danger text-xs" title="该集有 error 级问题">●</span>}
                    {!hasErr && hasWarn && <span className="text-warning text-xs" title="该集有提醒">●</span>}
                    <input
                      type="text"
                      value={ep.title || ""}
                      onChange={(e) => {
                        const newEps = [...episodes];
                        const idx = newEps.findIndex((x) => x.order === ep.order);
                        if (idx >= 0) newEps[idx].title = e.target.value;
                        setEpisodes(newEps);
                      }}
                      className="flex-1 px-3 py-1 bg-surface-overlay/50 border border-line-strong rounded text-sm"
                    />
                  </div>
                  <textarea
                    value={ep.synopsis || ""}
                    onChange={(e) => {
                      const newEps = [...episodes];
                      const idx = newEps.findIndex((x) => x.order === ep.order);
                      if (idx >= 0) newEps[idx].synopsis = e.target.value;
                      setEpisodes(newEps);
                    }}
                    /* 2026-11-07：大纲正文改成要素块（【开场卡点】【冲突】…【结尾钩子】），
                       一集三四百字、七八个换行。原来 3 行只能看到开头两要素，
                       用户等于「看不全自己要审的东西」。按内容行数自适应。 */
                    rows={Math.min(20, Math.max(4, (ep.synopsis || "").split("\n").length + 1))}
                    className="w-full px-3 py-2 bg-surface-overlay/50 border border-line-strong rounded text-sm resize-y leading-relaxed"
                  />
                  {/* D6: 戏剧契约折叠区（默认折叠；老数据无契约字段时不渲染） */}
                  <ContractFold
                    ep={ep}
                    issues={[...issuesForEpisode(ep.order), ...gateIssuesForEpisode(ep.order)]}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => updateEpisode(ep.order, ep.title, ep.synopsis)}
                    disabled={saving}
                    className="p-2 bg-info hover:bg-info/90 rounded disabled:opacity-50 text-white"
                    title="保存"
                  >
                    <Save className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => regenerateSolo(ep.order)}
                    disabled={saving}
                    className="p-2 bg-primary hover:bg-primary rounded disabled:opacity-50"
                    title="重新生成此集"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => regenerateFrom(ep.order)}
                    disabled={saving}
                    className="p-2 bg-warning hover:bg-warning/90 rounded disabled:opacity-50 text-white"
                    title="生成后续"
                  >
                    <Zap className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
