"use client";
import { useState, useEffect } from "react";
import { XCircle, Loader2, FileText, BookOpen, History, ChevronDown, ChevronRight, Scroll } from "lucide-react";
import { getToken } from "../../../../lib/auth";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

const STATUS_LABELS: Record<string, string> = {
  generated: "已生成",
  analyzed_v1: "第一轮质检",
  repairable_pending: "待修复",
  optimized_v1: "已优化",
  analyzed_v2: "第二轮质检",
  repairable_pending_v2: "待修复(二轮)",
  rejected_fatal: "致命缺陷淘汰",
  rejected_fatal_v2: "二轮淘汰",
  ready_for_script: "剧本生成中",
  completed: "剧本已完成",
  spare: "备用未启用",
};

/**
 * V4大纲详情弹窗
 *直接消费看板卡片数据(outline含analysis_v1/analysis_v2/scripts),
 * 并按需拉取大纲完整内容。
 */
export function OutlineDetailModal({ outline, traceData, onClose }: any) {
  const [loading, setLoading] = useState(true);
  const [rawContent, setRawContent] = useState<string>("");
  // 版本列表: [{version: "初始版本", content: "..."}, ..., {version: "最终版本", content: 当前content}]
  const [versions, setVersions] = useState<{ version: string; content: string }[]>([]);
  const [activeVersion, setActiveVersion] = useState(0);
  const [expandedChapter, setExpandedChapter] = useState<number | null>(null);
  //剧本内容展开
  const [expandedScript, setExpandedScript] = useState<number | null>(null);
  const [scriptContent, setScriptContent] = useState<Record<number, any>>({});
  const [loadingScript, setLoadingScript] = useState<number | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch(`${API}/products/${outline.id}`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (r.ok) {
          const data = await r.json();
          const content = data.content || "";
          setRawContent(content);
          // 组装版本列表:历史版本(meta_data.content_history) + 当前最终版
          const history = (data.meta_data?.content_history || []) as { version: string; content: string }[];
          const all = [...history, { version: "最终版本", content }];
          setVersions(all);
          setActiveVersion(all.length - 1); // 默认显示最终版
        }
      } catch (e) {
        console.error("Failed to load outline content:", e);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [outline.id]);

  const loadScriptContent = async (scriptId: number) => {
    if (scriptContent[scriptId] !== undefined) {
      setExpandedScript(expandedScript === scriptId ? null : scriptId);
      return;
    }
    setLoadingScript(scriptId);
    try {
      const r = await fetch(`${API}/products/${scriptId}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (r.ok) {
        const data = await r.json();
        let chapters: any[] = [];
        try {
          const parsed = JSON.parse(data.content || "{}");
          chapters = parsed.chapters || [];
        } catch {}
        setScriptContent(prev => ({ ...prev, [scriptId]: chapters }));
        setExpandedScript(scriptId);
      }
    } catch (e) {
      console.error("Failed to load script content:", e);
    } finally {
      setLoadingScript(null);
    }
  };

  // 解析当前选中版本的JSON
  const outlineJson = (() => {
    const v = versions[activeVersion];
    if (!v) return null;
    try {
      return JSON.parse(v.content);
    } catch {
      return null;
    }
  })();

  const renderAnalysis = (label: string, analysis: any) => {
    if (!analysis) return null;
    
    // 实际数据结构: {analysis: "markdown长文本", decision: "repairable/rejected_fatal", raw_response: "..."}
    const analysisText = analysis.analysis || "";
    const decision = analysis.decision || "";
    
    return (
      <div className="mb-4">
        <h5 className="text-sm font-semibold mb-2 flex items-center gap-2">
          {label}
          {decision === "repairable" && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500 text-white">可修复</span>}
          {decision === "rejected_fatal" && <span className="text-xs px-2 py-0.5 rounded-full bg-red-500 text-white">致命缺陷</span>}
        </h5>
        <div className={`p-4 rounded-lg border text-sm whitespace-pre-wrap leading-relaxed ${
          decision === "rejected_fatal"
            ? "bg-red-50 border-red-200 text-red-900"
            : "bg-yellow-50 border-yellow-200 text-yellow-900"
        }`}>
          {analysisText || JSON.stringify(analysis, null, 2)}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="p-4 border-b border-line flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-purple-500" />
            <h3 className="text-lg font-semibold">{outline.title}</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {STATUS_LABELS[outline.status] || outline.status}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded transition-colors"
          >
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* 质检分析记录 */}
          {(outline.analysis_v1 || outline.analysis_v2) && (
            <div className="mb-4">
              <h5 className="text-sm font-semibold mb-2 flex items-center gap-2 text-amber-700">
                <History className="w-4 h-4" />
                质检优化记录
                <span className="text-xs text-gray-400font-normal">（初始质检→第一轮优化→第二轮质检→最终优化结果见下方版本历史）</span>
              </h5>
              {renderAnalysis("第一轮质检结果", outline.analysis_v1)}
              {renderAnalysis("第二轮质检结果", outline.analysis_v2)}
            </div>
          )}

          {/* 关联剧本 */}
          {outline.scripts && outline.scripts.length > 0 && (
            <div className="mb-4">
              <h5 className="text-sm font-semibold mb-2 flex items-center gap-2 text-purple-700">
                <Scroll className="w-4 h-4" />
                生成的剧本 ({outline.scripts.length}) — 点击展开查看集数内容
              </h5><div className="space-y-2">
                {outline.scripts.map((s: any) => (
                  <div key={s.id} className="border border-purple-200 rounded-lg overflow-hidden">
                    <button
                      onClick={() => loadScriptContent(s.id)}
                      className="w-full p-3 bg-purple-50 hover:bg-purple-100 flex items-center justify-between transition-colors"
                    >
                      <div className="flex items-center gap-2flex-1 min-w-0">
                        <BookOpen className="w-4 h-4 text-purple-500flex-shrink-0" />
                        <span className="text-sm font-medium truncate">{s.title || `剧本 #${s.id}`}</span>{s.status === "generating" ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-700flex items-center gap-1 flex-shrink-0">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" />
                            {s.meta_data?.completed_episodes != null
                              ? `生成中 ${s.meta_data.completed_episodes}/${s.meta_data.episodes || "?"}集`
                              : "生成中"}
                          </span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700 flex-shrink-0">{s.status}</span>
                        )}
                      </div>
                      {loadingScript === s.id ? (<Loader2 className="w-4 h-4 animate-spin text-purple-400flex-shrink-0" />
                      ) : expandedScript === s.id ? (
                        <ChevronDown className="w-4 h-4 text-purple-400 flex-shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-purple-400 flex-shrink-0" />
                      )}
                    </button>
                    {expandedScript === s.id && scriptContent[s.id] !== undefined && (
                      <div className="max-h-[50vh] overflow-y-auto p-3 space-y-2 bg-white">
                        {scriptContent[s.id].length === 0 ? (
                          <p className="text-sm text-gray-400 text-center py-4">
                            {s.status === "generating" ? "⏳ 第一集尚未生成完成，请稍后刷新" : "暂无章节内容"}
                          </p>
                        ) : (
                          <>
                            {s.status === "generating" && (
                              <div className="flex items-center gap-2 text-xs text-blue-600 bg-blue-50 rounded px-3 py-2 mb-2">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>剧本生成中，已完成 {scriptContent[s.id].length} 集，刷新可查看最新进度</span>
                              </div>
                            )}
                            {scriptContent[s.id].map((ch: any, i: number) => (
                              <div key={i} className="p-3 border border-gray-100 rounded-lg">
                                <p className="text-sm font-medium text-purple-700 mb-2">
                                  第{ch.order || i + 1}集{ch.title ? `：${ch.title}` : ""}
                                  {ch.word_count &&<span className="text-xs text-gray-400 ml-2">({ch.word_count}字)</span>}
                                </p>
                                <p className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
                                  {ch.content || "（无正文）"}
                                </p>
                              </div>
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}{outline.scripts && outline.scripts.length === 0 && outline.status === "ready_for_script" && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              <p className="font-medium">⏳ 剧本生成中</p>
              <p className="text-xs mt-1">大纲已通过质检，剧本正在后台生成，请稍后刷新查看。</p>
            </div>
          )}

          {/* 大纲全文 - 结构化展示 + 版本切换 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h5 className="text-sm font-semibold flex items-center gap-2">
                <FileText className="w-4 h-4 text-purple-500" />
                大纲内容
                {versions.length <= 1 &&<span className="text-xs text-gray-400 font-normal">（历史版本需新任务才能记录）</span>}
              </h5>
              {versions.length > 0 && (
                <div className="flex gap-1">
                  {versions.map((v, i) => (
                    <button
                      key={i}
                      onClick={() => { setActiveVersion(i); setExpandedChapter(null); }}
                      disabled={versions.length === 1}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        i === activeVersion
                          ? "bg-purple-600 text-white border-purple-600"
                          : versions.length === 1
                          ? "bg-gray-100 text-gray-400 border-gray-300 cursor-not-allowed"
                          : "bg-white text-gray-600 border-gray-300 hover:border-purple-400"
                      }`}
                    >
                      {v.version}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
              </div>
            ) : outlineJson ? (
              <div className="space-y-3max-h-[45vh] overflow-y-auto">
                {outlineJson.synopsis && (
                  <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                    <p className="text-xs font-medium text-purple-700 mb-1">故事简介</p>
                    <p className="text-sm text-gray-800leading-relaxed">{outlineJson.synopsis}</p>
                  </div>
                )}
                {outlineJson.world && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs font-medium text-blue-700 mb-1">世界观</p>
                    <p className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap">
                      {typeof outlineJson.world === "string"
                        ? outlineJson.world
                        : Object.entries(outlineJson.world).map(([k, v]) => `${k}: ${v}`).join("\n")}
                    </p>
                  </div>
                )}
                {outlineJson.characters && Array.isArray(outlineJson.characters) && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-xs font-medium text-amber-700 mb-2">人物 ({outlineJson.characters.length})</p>
                    <div className="space-y-1.5">
                      {outlineJson.characters.map((ch: any, i: number) => (
                        <div key={i} className="text-sm">
                          <span className="font-medium">{ch.name || ch}</span>
                          {ch.description && <span className="text-gray-600"> — {ch.description}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {outlineJson.chapters && Array.isArray(outlineJson.chapters) && (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-xs font-medium text-green-700 mb-2">
                      分集大纲 ({outlineJson.chapters.length}集) — 点击展开完整内容
                    </p>
                    <div className="space-y-2">
                      {outlineJson.chapters.map((ch: any, i: number) => {
                        const isOpen = expandedChapter === i;
                        // 除order/title外的所有字段都作为详情展示
                        const detailFields = Object.entries(ch).filter(
                          ([k]) => !["order", "title"].includes(k)
                        );
                        return (
                          <div key={i} className="bg-white rounded border border-green-100 text-sm">
                            <button
                              onClick={() => setExpandedChapter(isOpen ? null : i)}
                              className="w-full text-left p-2 flex items-center justify-between hover:bg-green-50/50 transition-colors"
                            >
                              <span className="font-medium">
                                第{ch.order || i + 1}集{ch.title ?`: ${ch.title}` : ""}
                              </span><span className="text-xs text-gray-400">{isOpen ? "收起 ▲" : "展开 ▼"}</span>
                            </button>
                            {isOpen && (
                              <div className="px-3 pb-3 pt-1 border-t border-green-100space-y-2">
                                {detailFields.length > 0 ? detailFields.map(([key, val]) => (
                                  <div key={key}>
                                    <p className="text-xs font-medium text-green-700 mb-0.5">{key}</p>
                                    <p className="text-xs text-gray-700leading-relaxed whitespace-pre-wrap">
                                      {typeof val === "string" ? val : JSON.stringify(val, null, 2)}
                                    </p>
                                  </div>
                                )) : (
                                  <p className="text-xs text-gray-400">该集无更多详情字段</p>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}</div>
            ) : (
              <div className="p-4 bg-gray-50 rounded-lg text-sm whitespace-pre-wrap leading-relaxed max-h-[40vh] overflow-y-auto">
                {rawContent || outline.content_preview || "无内容"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}