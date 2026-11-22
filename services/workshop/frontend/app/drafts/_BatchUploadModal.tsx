"use client";
import { authFetch } from "../../lib/auth";
import { useState } from "react";
import { Upload, X, CheckCircle, AlertCircle, RefreshCw, FileEdit } from "lucide-react";
import { ChapterEditor } from "./_ChapterEditor";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Badge } from "@/components/ui/Badge";
import { IconButton } from "@/components/ui/IconButton";
import { ModelSelect } from "@/components/ModelSelect";
import { notify, notifyError, notifyWarning } from "@/lib/dialog";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type PreviewItem = {
  filename: string;
  file_type: string;
  title: string;
  word_count: number;
  length_category: "short" | "medium" | "long" | "";
  preview: string;
  error: string | null;
  content: string;
  episodeCount: number;
  detected_chapters?: number;
  splitMode: "auto" | "manual";
  editedChapters?: { order: number; title: string; content: string }[];
};

type UploadStatus = "idle" | "preview" | "uploading" | "done";

/**
 * 批量上传 Modal — Phase 3 重做版,接入 UI Kit (Modal / Card / Button / Input / Select / Badge / Spinner)。
 * 业务逻辑全部保留:多文件预览、按文件设置标题/拆分模式/集数、编辑章节、重试、批量提交。
 */
export function BatchUploadModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [previewItems, setPreviewItems] = useState<PreviewItem[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [results, setResults] = useState<{ success: any[]; failed: any[] }>({ success: [], failed: [] });
  const [editingFileIdx, setEditingFileIdx] = useState<number | null>(null);

  const [mode, setMode] = useState<"draft_only" | "auto_outline" | "full_pipeline" | "import_script">("draft_only");
  const [modelProvider, setModelProvider] = useState("gemini");
  const [episodeCount, setEpisodeCount] = useState(3);
  const [preferFirstlineTitle, setPreferFirstlineTitle] = useState(false);

  function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 20) {
      notifyWarning("最多同时上传20个文件");
      return;
    }
    setFiles(selected);
    setPreviewItems([]);
    setSummary(null);
    setStatus("idle");
  }

  async function runPreview() {
    if (files.length === 0) {
      notifyWarning("请选择至少1个文件");
      return;
    }
    setStatus("uploading");
    const formData = new FormData();
    files.forEach((f) => formData.append("files", f));
    formData.append("prefer_firstline_title", preferFirstlineTitle ? "true" : "false");
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/batch-upload/preview`, { method: "POST", body: formData });
      if (!res.ok) {
        notifyError("预览失败: " + res.status);
        setStatus("idle");
        return;
      }
      const data = await res.json();
      const items = (data.items || []).map((it: any) => ({
        ...it,
        episodeCount: episodeCount,
        splitMode: (it.detected_chapters > 0 ? "auto" : "manual") as "auto" | "manual",
      }));
      setPreviewItems(items);
      setSummary(data.summary);
      setStatus("preview");
    } catch (e) {
      notifyError("预览出错: " + e);
      setStatus("idle");
    }
  }

  function updateItemTitle(idx: number, newTitle: string) {
    const next = [...previewItems];
    next[idx] = { ...next[idx], title: newTitle };
    setPreviewItems(next);
  }

  function handleChapterEditorConfirm(chapters: any[]) {
    if (editingFileIdx === null) return;
    const next = [...previewItems];
    next[editingFileIdx] = { ...next[editingFileIdx], editedChapters: chapters, detected_chapters: chapters.length };
    setPreviewItems(next);
    setEditingFileIdx(null);
  }

  function updateItemSplitMode(idx: number, m: "auto" | "manual") {
    const next = [...previewItems];
    next[idx] = { ...next[idx], splitMode: m };
    setPreviewItems(next);
  }

  function updateItemEpisodeCount(idx: number, count: number) {
    const next = [...previewItems];
    next[idx] = { ...next[idx], episodeCount: Math.max(1, Math.min(500, count || 1)) };
    setPreviewItems(next);
  }

  function removeItem(idx: number) {
    setPreviewItems(previewItems.filter((_, i) => i !== idx));
  }

  async function retryFile(idx: number) {
    const item = previewItems[idx];
    const origFile = files.find((f) => f.name === item.filename);
    if (!origFile) return;
    const formData = new FormData();
    formData.append("files", origFile);
    formData.append("prefer_firstline_title", preferFirstlineTitle ? "true" : "false");
    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/batch-upload/preview`, { method: "POST", body: formData });
      const data = await res.json();
      if (data.items?.[0]) {
        const next = [...previewItems];
        next[idx] = data.items[0];
        setPreviewItems(next);
      }
    } catch (e) {
      notifyError("重试失败: " + e);
    }
  }

  async function confirmUpload() {
    const validItems = previewItems.filter((p) => !p.error);
    if (validItems.length === 0) {
      notifyWarning("没有有效的文件可上传");
      return;
    }
    setStatus("uploading");
    setProgress({ current: 0, total: validItems.length });

    const editedFiles = validItems.filter((p) => p.editedChapters && p.editedChapters.length > 0);
    const normalFiles = validItems.filter((p) => !p.editedChapters || p.editedChapters.length === 0);

    const allCreated: any[] = [];
    const allFailed: any[] = [];

    for (const p of editedFiles) {
      try {
        const res = await authFetch(`${BASE}/v1/stages/drafts/create-from-chapters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: p.title,
            chapters: p.editedChapters,
            model_provider: modelProvider,
            auto_storyboard: false,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          allCreated.push({ id: data.draft_id, title: data.title, filename: p.filename, mode: "auto_split_edited", chapter_count: data.chapter_count });
        } else {
          allFailed.push({ filename: p.filename, error: `${res.status}` });
        }
      } catch (e: any) {
        allFailed.push({ filename: p.filename, error: String(e) });
      }
    }

    const titlesOverride: Record<string, string> = {};
    const episodeCountsMap: Record<string, number> = {};
    const splitModesMap: Record<string, string> = {};
    validItems.forEach((p) => {
      titlesOverride[p.filename] = p.title;
      episodeCountsMap[p.filename] = p.episodeCount || episodeCount;
      splitModesMap[p.filename] = p.splitMode || "manual";
    });

    if (normalFiles.length === 0) {
      setResults({ success: allCreated, failed: allFailed });
      setStatus("done");
      onSuccess();
      return;
    }

    const formData = new FormData();
    normalFiles.forEach((p) => {
      const origFile = files.find((f) => f.name === p.filename);
      if (origFile) formData.append("files", origFile);
    });
    formData.append("episode_count", String(episodeCount));
    formData.append("model_provider", modelProvider);
    formData.append("mode", mode);
    formData.append("prefer_firstline_title", preferFirstlineTitle ? "true" : "false");
    formData.append("titles_override", JSON.stringify(titlesOverride));
    formData.append("episode_counts", JSON.stringify(episodeCountsMap));
    formData.append("split_modes", JSON.stringify(splitModesMap));

    try {
      const res = await authFetch(`${BASE}/v1/stages/drafts/batch-upload`, { method: "POST", body: formData });
      if (!res.ok) {
        notifyError("上传失败: " + res.status);
        setStatus("preview");
        return;
      }
      const data = await res.json();
      setResults({ success: [...allCreated, ...(data.created || [])], failed: [...allFailed, ...(data.failed || [])] });
      setStatus("done");
      onSuccess();
    } catch (e) {
      notifyError("上传出错: " + e);
      setStatus("preview");
    }
  }

  function reset() {
    setFiles([]);
    setPreviewItems([]);
    setSummary(null);
    setStatus("idle");
    setProgress({ current: 0, total: 0 });
    setResults({ success: [], failed: [] });
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={
          <span className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            批量上传剧本
          </span>
        }
        size="lg"
      >
        <div className="space-y-4">
          {/* 步骤1: 选择文件 + 参数 */}
          {status === "idle" && (
            <>
              <div>
                <label className="block text-sm font-semibold mb-2 text-ink-primary">📁 选择文件</label>
                <input
                  type="file"
                  multiple
                  accept=".txt,.docx,.pdf,.md"
                  onChange={handleFilesSelected}
                  className="w-full text-sm file:mr-3 file:px-4 file:py-2 file:rounded-md file:border-0 file:bg-primary file:text-white file:cursor-pointer hover:file:bg-primary/90 bg-surface-base border border-line rounded-lg py-2 text-ink-primary"
                />
                <p className="text-xs text-ink-muted mt-1">支持: .txt/.docx/.pdf/.md | 单文件≤100MB | 最多20个</p>
                {files.length > 0 && <p className="text-xs text-cyan mt-1">已选择: {files.length}个文件</p>}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold mb-1 text-ink-primary">AI模型</label>
                  <ModelSelect
                    value={modelProvider}
                    onChange={setModelProvider}
                    label={null}
                    showHint={false}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold mb-1 text-ink-primary">
                    默认集数 <span className="text-xs text-ink-muted font-normal">(手动模式)</span>
                  </label>
                  <Input type="number" min={1} max={500} value={episodeCount} onChange={(e) => setEpisodeCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))} />
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-2 text-ink-primary">⚙️ 处理模式</label>
                <div className="space-y-2">
                  {[
                    { val: "draft_only", label: "📋 仅创建草稿", desc: "上传后手动生成大纲/章节/剧本" },
                    { val: "auto_outline", label: "📖 自动生成大纲", desc: "上传后后台自动生成大纲(锁定)" },
                    { val: "full_pipeline", label: "🚀 完整流水线", desc: "自动生成大纲+章节+剧本(耗时较长)" },
                    { val: "import_script", label: "📥 作为已有剧本导入", desc: "智能切分章节,适合长文(>2000字)" },
                  ].map((m) => (
                    <label
                      key={m.val}
                      className={`flex items-start gap-2 p-2 rounded-md cursor-pointer transition ${
                        mode === m.val ? "bg-primary/10 border border-primary/50" : "bg-surface-base border border-line hover:border-line-strong"
                      }`}
                    >
                      <input type="radio" name="mode" value={m.val} checked={mode === m.val} onChange={(e) => setMode(e.target.value as any)} className="mt-1 accent-primary" />
                      <div>
                        <div className="font-semibold text-sm text-ink-primary">{m.label}</div>
                        <div className="text-xs text-ink-secondary">{m.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm text-ink-primary">
                  <input type="checkbox" checked={preferFirstlineTitle} onChange={(e) => setPreferFirstlineTitle(e.target.checked)} className="accent-primary" />
                  <span>优先从文本第一行提取标题(否则使用文件名)</span>
                </label>
              </div>

              <div className="flex gap-2 pt-4 border-t border-line">
                <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
                <Button variant="primary" size="md" disabled={files.length === 0} onClick={runPreview} className="flex-1">
                  下一步:预览
                </Button>
              </div>
            </>
          )}

          {/* 上传/预览中 */}
          {status === "uploading" && previewItems.length === 0 && (
            <div className="py-20 text-center">
              <Spinner size="lg" className="mx-auto mb-4 text-primary" />
              <p className="text-ink-secondary">正在解析文件...</p>
            </div>
          )}

          {/* 步骤2: 预览与确认 */}
          {status === "preview" && (
            <>
              {summary && (
                <div className="p-3 bg-surface-base rounded-md text-sm flex items-center gap-3 flex-wrap">
                  <Badge tone="info" size="md">📊 共 {summary.total} 个</Badge>
                  {summary.short > 0 && <Badge tone="success" size="sm">短文 {summary.short}</Badge>}
                  {summary.medium > 0 && <Badge tone="warning" size="sm">中等 {summary.medium}</Badge>}
                  {summary.long > 0 && <Badge tone="info" size="sm">长文 {summary.long}（建议切分）</Badge>}
                  {summary.errors > 0 && <Badge tone="danger" size="sm">错误 {summary.errors}</Badge>}
                </div>
              )}

              <div className="space-y-2 max-h-96 overflow-y-auto">
                {previewItems.map((item, idx) => (
                  <div
                    key={idx}
                    className={`p-3 rounded-md border ${
                      item.error ? "bg-danger/5 border-danger/30" : "bg-surface-base border-line"
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {item.error ? <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-1" /> : <CheckCircle className="w-5 h-5 text-success flex-shrink-0 mt-1" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="text-xs text-ink-muted">{item.filename}</span>
                          <Badge tone="muted" size="sm">.{item.file_type}</Badge>
                          {item.word_count > 0 && <span className="text-xs text-ink-secondary">{item.word_count}字</span>}
                          {item.length_category === "short" && <Badge tone="success" size="sm">短文</Badge>}
                          {item.length_category === "medium" && <Badge tone="warning" size="sm">中等</Badge>}
                          {item.length_category === "long" && <Badge tone="info" size="sm">长文</Badge>}
                        </div>
                        {item.error ? (
                          <div className="text-sm text-danger">❌ {item.error}</div>
                        ) : (
                          <>
                            <Input
                              type="text"
                              value={item.title}
                              onChange={(e) => updateItemTitle(idx, e.target.value)}
                              placeholder="标题"
                              className="mb-1"
                            />
                            <div className="flex items-center gap-2 mb-1 text-xs flex-wrap">
                              <label
                                className={`flex items-center gap-1 cursor-pointer px-2 py-1 rounded transition ${
                                  item.splitMode === "auto" ? "bg-success/10 border border-success/40 text-success" : "bg-surface-base border border-line text-ink-secondary"
                                }`}
                              >
                                <input type="radio" name={`split-${idx}`} checked={item.splitMode === "auto"} onChange={() => updateItemSplitMode(idx, "auto")} className="hidden" />
                                🔍 自动拆分
                                {item.editedChapters
                                  ? ` (已编辑${item.editedChapters.length}章)`
                                  : item.detected_chapters
                                  ? ` (检测到${item.detected_chapters}集)`
                                  : " (未检测到章节)"}
                              </label>
                              {item.splitMode === "auto" && (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  leftIcon={<FileEdit className="w-3 h-3" />}
                                  onClick={() => setEditingFileIdx(idx)}
                                  title="精细编辑章节(合并/拆分/改名)"
                                >
                                  编辑章节
                                </Button>
                              )}
                              <label
                                className={`flex items-center gap-1 cursor-pointer px-2 py-1 rounded transition ${
                                  item.splitMode === "manual" ? "bg-primary/10 border border-primary/40 text-primary" : "bg-surface-base border border-line text-ink-secondary"
                                }`}
                              >
                                <input type="radio" name={`split-${idx}`} checked={item.splitMode === "manual"} onChange={() => updateItemSplitMode(idx, "manual")} className="hidden" />
                                ✏️ 手动指定
                              </label>
                              {item.splitMode === "manual" && (
                                <>
                                  <span className="text-ink-secondary">集数:</span>
                                  <Input
                                    type="number"
                                    min={1}
                                    max={500}
                                    value={item.episodeCount || 3}
                                    onChange={(e) => updateItemEpisodeCount(idx, parseInt(e.target.value) || 1)}
                                    className="!w-16 !py-1 text-center text-xs"
                                  />
                                </>
                              )}
                            </div>
                            <p className="text-xs text-ink-muted line-clamp-2">{item.preview}</p>
                          </>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        {item.error && (
                          <IconButton aria-label="重试" size="sm" variant="ghost" onClick={() => retryFile(idx)}>
                            <RefreshCw className="w-4 h-4" />
                          </IconButton>
                        )}
                        <IconButton aria-label="删除" size="sm" variant="ghost" onClick={() => removeItem(idx)}>
                          <X className="w-4 h-4 text-danger" />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 pt-4 border-t border-line">
                <Button variant="secondary" size="md" onClick={reset}>重新选择</Button>
                <Button
                  variant="primary"
                  size="md"
                  disabled={previewItems.filter((p) => !p.error).length === 0}
                  onClick={confirmUpload}
                  className="flex-1"
                >
                  确认创建 {previewItems.filter((p) => !p.error).length} 个草稿
                  {" ("}
                  {mode === "draft_only" ? "仅创建" : mode === "auto_outline" ? "自动大纲" : mode === "full_pipeline" ? "完整流水线" : "剧本导入"}
                  {")"}
                </Button>
              </div>
            </>
          )}

          {/* 上传中(第二步) */}
          {status === "uploading" && previewItems.length > 0 && (
            <div className="py-20 text-center">
              <Spinner size="lg" className="mx-auto mb-4 text-primary" />
              <p className="text-ink-secondary">正在创建草稿...</p>
              {progress.total > 0 && <p className="text-sm text-cyan mt-2">{progress.current}/{progress.total}</p>}
            </div>
          )}

          {/* 完成 */}
          {status === "done" && (
            <div className="py-2">
              <h3 className="text-lg font-bold mb-3 text-ink-primary">📊 上传完成</h3>
              {results.success.length > 0 && (
                <div className="mb-4">
                  <p className="text-sm text-success mb-2">✅ 成功创建 {results.success.length} 个草稿:</p>
                  <ul className="space-y-1 text-sm">
                    {results.success.map((s: any) => (
                      <li key={s.id} className="text-ink-primary">
                        <span className="text-primary mr-2">#{s.id}</span>
                        {s.title}
                        {s.chapter_count && <span className="text-xs text-ink-muted ml-2">({s.chapter_count}章)</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {results.failed.length > 0 && (
                <div className="mb-4">
                  <p className="text-sm text-danger mb-2">❌ 失败 {results.failed.length} 个:</p>
                  <ul className="space-y-1 text-sm">
                    {results.failed.map((f: any, i: number) => (
                      <li key={i} className="text-ink-secondary">• {f.filename}: {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-2 pt-4 border-t border-line">
                <Button variant="primary" size="md" onClick={reset} className="flex-1">继续上传</Button>
                <Button variant="secondary" size="md" onClick={onClose} className="flex-1">关闭</Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <ChapterEditor
        open={editingFileIdx !== null}
        file={editingFileIdx !== null ? files.find((f) => f.name === previewItems[editingFileIdx]?.filename) || null : null}
        onClose={() => setEditingFileIdx(null)}
        onConfirm={handleChapterEditorConfirm}
      />
    </>
  );
}
