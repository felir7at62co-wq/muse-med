"use client";
import { authFetch } from "../../lib/auth";
import { draftPath } from "@/components/VersionSwitcher";
import { confirmAsync, notifyError, notifyWarning } from "@/lib/dialog";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Edit, Trash2, ChevronUp, ChevronDown, Scissors, Plus, MergeIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { OutlinePreview, buildContinuous, type OutlineEpisode } from "./_OutlinePreview";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";

type ChapterPreview = {
  order: number;
  title: string;
  content: string;
  word_count: number;
};

type PreviewResult = {
  chapters: ChapterPreview[];
  characters: string[];
  total_words: number;
  chapter_count: number;
  file_name: string;
};

type Step = "upload" | "preview" | "creating";

interface ImportScriptModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 导入剧本 Modal — Phase 3 重做版,接入 UI Kit。业务逻辑全部保留。
 */
export function ImportScriptModal({ open, onClose }: ImportScriptModalProps) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [importType, setImportType] = useState<"script" | "outline">("script"); // 导入类型(需求3)
  const [inputType, setInputType] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState("");
  const [title, setTitle] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  // 大纲导入: 预览阶段的单集列表(可纠错)
  const [outlineEps, setOutlineEps] = useState<OutlineEpisode[]>([]);

  // 大纲: 解析 + AI 拆解混合集 → 预览
  async function handleOutlinePreview() {
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      if (inputType === "file" && file) formData.append("file", file);
      else if (inputType === "text" && textContent) formData.append("content", textContent);
      else { setError("请上传文件或粘贴文本"); setLoading(false); return; }
      const res = await authFetch(`${BASE}/v1/stages/import-outline/preview`, { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setOutlineEps(data.episodes || []);
      if (!title && data.file_name) setTitle(data.file_name.replace(/\.(txt|docx|doc|pdf)$/i, ""));
      setStep("preview");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // 大纲: 确认创建
  async function handleOutlineCreate() {
    setLoading(true);
    setError("");
    // 前端先校验空集 (后端也会校验)
    const empties = buildContinuous(outlineEps).filter((e) => !e.summary.trim());
    if (empties.length) {
      setError(`第${empties.map((e) => e.order).join("、")}集大纲为空, 请补充内容或删除该空集后再创建`);
      setLoading(false);
      return;
    }
    setStep("creating");
    try {
      const res = await authFetch(`${BASE}/v1/stages/import-outline/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || "导入的大纲", episodes: outlineEps }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      onClose();
      // 走 draftPath：本弹窗在旧版列表与新版的 /v2 首页都会被打开，
      // 写死 `/drafts/${id}` 会把新版用户丢回旧版。
      router.push(draftPath(data.draft_id));
    } catch (e: any) {
      setError(e.message);
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      if (inputType === "file" && file) {
        formData.append("file", file);
      } else if (inputType === "text" && textContent) {
        formData.append("content", textContent);
      } else {
        setError("请上传文件或粘贴文本");
        setLoading(false);
        return;
      }
      const res = await authFetch(`${BASE}/v1/stages/import-script/preview`, { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data: PreviewResult = await res.json();
      setPreview(data);
      if (!title && data.file_name) {
        setTitle(data.file_name.replace(/\.(txt|docx|doc|pdf)$/i, ""));
      }
      setStep("preview");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!preview) return;
    setLoading(true);
    setError("");
    setStep("creating");
    try {
      const res = await authFetch(`${BASE}/v1/stages/import-script/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title || "导入的剧本",
          chapters: preview.chapters,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      onClose();
      router.push(draftPath(data.draft_id));
    } catch (e: any) {
      setError(e.message);
      setStep("preview");
    } finally {
      setLoading(false);
    }
  }

  function updateChapter(idx: number, patch: Partial<ChapterPreview>) {
    if (!preview) return;
    const chapters = [...preview.chapters];
    chapters[idx] = { ...chapters[idx], ...patch };
    chapters[idx].word_count = chapters[idx].content.length;
    setPreview({ ...preview, chapters });
  }

  async function deleteChapter(idx: number) {
    if (!preview) return;
    if (preview.chapters.length === 1) {
      notifyWarning("至少保留1个章节");
      return;
    }
    if (!(await confirmAsync({ title: `删除第 ${preview.chapters[idx].order} 集`, tone: "danger", confirmText: "删除" }))) return;
    const chapters = preview.chapters.filter((_, i) => i !== idx);
    chapters.forEach((c, i) => (c.order = i + 1));
    setPreview({ ...preview, chapters });
  }

  function moveChapter(idx: number, direction: -1 | 1) {
    if (!preview) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= preview.chapters.length) return;
    const chapters = [...preview.chapters];
    [chapters[idx], chapters[newIdx]] = [chapters[newIdx], chapters[idx]];
    chapters.forEach((c, i) => (c.order = i + 1));
    setPreview({ ...preview, chapters });
  }

  function mergeWithNext(idx: number) {
    if (!preview) return;
    if (idx + 1 >= preview.chapters.length) return;
    const chapters = [...preview.chapters];
    chapters[idx].content = chapters[idx].content + "\n\n" + chapters[idx + 1].content;
    chapters[idx].word_count = chapters[idx].content.length;
    chapters.splice(idx + 1, 1);
    chapters.forEach((c, i) => (c.order = i + 1));
    setPreview({ ...preview, chapters });
  }

  function insertChapterAfter(idx: number) {
    if (!preview) return;
    const chapters = [...preview.chapters];
    const newChapter: ChapterPreview = { order: idx + 2, title: `新增第${idx + 2}集`, content: "", word_count: 0 };
    chapters.splice(idx + 1, 0, newChapter);
    chapters.forEach((c, i) => (c.order = i + 1));
    setPreview({ ...preview, chapters, chapter_count: chapters.length });
    setEditingIdx(idx + 1);
  }

  function splitChapterAt(idx: number) {
    if (!preview) return;
    const ch = preview.chapters[idx];
    if (!ch.content || ch.content.length < 20) {
      notifyWarning("内容太短,无法拆分");
      return;
    }
    const mid = Math.floor(ch.content.length / 2);
    let splitPos = mid;
    for (let offset = 0; offset < 200; offset++) {
      if (mid + offset < ch.content.length && ch.content[mid + offset] === "\n") {
        splitPos = mid + offset + 1;
        break;
      }
      if (mid - offset >= 0 && ch.content[mid - offset] === "\n") {
        splitPos = mid - offset + 1;
        break;
      }
    }
    const chapters = [...preview.chapters];
    const part1 = ch.content.slice(0, splitPos).trimEnd();
    const part2 = ch.content.slice(splitPos).trimStart();
    chapters[idx] = { ...ch, content: part1, word_count: part1.length, title: ch.title + "(上)" };
    const newCh: ChapterPreview = { order: idx + 2, title: ch.title + "(下)", content: part2, word_count: part2.length };
    chapters.splice(idx + 1, 0, newCh);
    chapters.forEach((c, i) => (c.order = i + 1));
    setPreview({ ...preview, chapters, chapter_count: chapters.length });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-2">📥 导入剧本转写为剧本</span>}
      size="lg"
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-danger/10 border border-danger/40 rounded-md text-sm text-danger">❌ {error}</div>
        )}

        {step === "upload" && (
          <>
            {/* 导入类型选择 (需求3): 剧本 / 大纲 */}
            <div>
              <label className="block text-sm mb-1.5 font-semibold text-ink-primary">我要导入的是：</label>
              <div className="flex gap-2">
                <Button variant={importType === "script" ? "primary" : "secondary"} size="md" onClick={() => setImportType("script")}>📖 完整剧本</Button>
                <Button variant={importType === "outline" ? "primary" : "secondary"} size="md" onClick={() => setImportType("outline")}>🗂️ 剧情大纲</Button>
              </div>
              <p className="text-xs text-ink-muted mt-1.5">
                {importType === "script"
                  ? "导入完整剧本正文, 自动切分章节 + 提取大纲。"
                  : "导入分集大纲(支持「第3集：…」单集 与「第41-43集：…」混合集); 混合集将由 AI 自动拆解成对应单集。"}
              </p>
            </div>

            <div className="flex gap-2 mb-2">
              <Button variant={inputType === "file" ? "primary" : "secondary"} size="md" onClick={() => setInputType("file")}>📁 上传文件</Button>
              <Button variant={inputType === "text" ? "primary" : "secondary"} size="md" onClick={() => setInputType("text")}>📝 粘贴文本</Button>
            </div>

            {inputType === "file" ? (
              <div>
                <input
                  type="file"
                  accept=".txt,.docx,.pdf"
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                  className="block w-full text-sm file:mr-3 file:px-4 file:py-2 file:rounded-md file:border-0 file:bg-primary file:text-white hover:file:bg-primary/90 file:cursor-pointer p-3 bg-surface-base border border-line rounded-md text-ink-primary"
                />
                <p className="text-xs text-ink-muted mt-2">
                  支持: .txt / .docx / .pdf 最大500MB
                  <br />
                  💡 .doc格式请先用Word另存为.docx格式
                </p>
                {file && <p className="mt-2 text-sm text-success">✓ 已选择: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)</p>}
              </div>
            ) : (
              <Textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                rows={15}
                placeholder={"粘贴完整剧本内容...\n支持识别 '第N集'/'第N章' 等分隔符自动切分章节"}
                className="font-mono text-sm"
              />
            )}

            <Card padding="md" className="bg-info/5 border-info/40">
              <p className="text-sm font-semibold text-ink-primary mb-1">📋 系统会自动:</p>
              <ul className="list-disc ml-5 space-y-1 text-xs text-ink-secondary">
                <li>识别"第N集"/"第N章"等分隔符切分章节</li>
                <li>提取角色名清单</li>
                <li>AI辅助生成大纲(梗概+人物+各集要点)</li>
                <li>后台批量生成剧本(▲格式)</li>
              </ul>
            </Card>

            <div className="flex justify-end gap-2 pt-4 border-t border-line">
              <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
              <Button
                variant="primary"
                size="md"
                loading={loading}
                disabled={loading || (inputType === "file" ? !file : !textContent)}
                onClick={importType === "outline" ? handleOutlinePreview : handlePreview}
              >
                {importType === "outline" ? "下一步:解析大纲(含AI拆解)" : "下一步:预览章节切分"}
              </Button>
            </div>
          </>
        )}

        {/* 大纲预览 + 纠错 (需求3) */}
        {step === "preview" && importType === "outline" && (
          <>
            <div>
              <label className="block text-sm mb-1 text-ink-primary">大纲标题</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="导入的大纲" />
            </div>
            <OutlinePreview episodes={outlineEps} onChange={setOutlineEps} />
            <div className="flex justify-between gap-2 pt-4 border-t border-line">
              <Button variant="secondary" size="md" onClick={() => setStep("upload")}>← 返回</Button>
              <Button
                variant="primary"
                size="md"
                loading={loading}
                disabled={loading || !outlineEps.length}
                onClick={handleOutlineCreate}
              >
                ✅ 确认创建草稿
              </Button>
            </div>
          </>
        )}

        {step === "preview" && importType === "script" && preview && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Card padding="sm" className="bg-surface-base text-center">
                <div className="text-2xl font-bold text-primary">{preview.chapter_count}</div>
                <div className="text-xs text-ink-muted">识别集数</div>
              </Card>
              <Card padding="sm" className="bg-surface-base text-center">
                <div className="text-2xl font-bold text-cyan">{preview.total_words.toLocaleString()}</div>
                <div className="text-xs text-ink-muted">总字数</div>
              </Card>
              <Card padding="sm" className="bg-surface-base text-center">
                <div className="text-2xl font-bold text-success">{preview.characters.length}</div>
                <div className="text-xs text-ink-muted">识别角色</div>
              </Card>
            </div>

            <div>
              <label className="block text-sm mb-1 text-ink-primary">剧本标题</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="导入的剧本" />
            </div>

            {preview.characters.length > 0 && (
              <div>
                <label className="block text-sm mb-1 text-ink-primary">识别到的角色 (前30):</label>
                <div className="flex flex-wrap gap-1">
                  {preview.characters.map((c) => (
                    <Badge key={c} tone="info" size="sm" variant="outline">{c}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm mb-2 font-semibold text-ink-primary">📋 章节切分预览(可调整):</label>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {preview.chapters.map((ch, idx) => (
                  <div key={idx} className="bg-surface-base border border-line rounded-md p-3">
                    <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
                      <div className="flex-1 min-w-[200px]">
                        {editingIdx === idx ? (
                          <Input value={ch.title} onChange={(e) => updateChapter(idx, { title: e.target.value })} className="!py-1" />
                        ) : (
                          <div className="text-sm font-semibold flex items-center gap-2 text-ink-primary">
                            <span className="text-primary">#{ch.order}</span>
                            {ch.title}
                            <span className="text-xs text-ink-muted">({ch.word_count}字)</span>
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1 flex-shrink-0 flex-wrap">
                        <Button variant="secondary" size="sm" onClick={() => moveChapter(idx, -1)} disabled={idx === 0}><ChevronUp className="w-3 h-3" /></Button>
                        <Button variant="secondary" size="sm" onClick={() => moveChapter(idx, 1)} disabled={idx === preview.chapters.length - 1}><ChevronDown className="w-3 h-3" /></Button>
                        <Button variant="secondary" size="sm" leftIcon={<MergeIcon className="w-3 h-3" />} onClick={() => mergeWithNext(idx)} disabled={idx === preview.chapters.length - 1} title="与下一集合并">合并</Button>
                        <Button variant="secondary" size="sm" leftIcon={<Scissors className="w-3 h-3" />} onClick={() => splitChapterAt(idx)} title="从中间拆分为两集">拆分</Button>
                        <Button variant="secondary" size="sm" leftIcon={<Plus className="w-3 h-3" />} onClick={() => insertChapterAfter(idx)} title="在此集后插入新章节">插入</Button>
                        <Button variant="secondary" size="sm" onClick={() => setEditingIdx(editingIdx === idx ? null : idx)}><Edit className="w-3 h-3" /></Button>
                        <Button variant="ghost" size="sm" onClick={() => deleteChapter(idx)} className="text-danger hover:text-danger"><Trash2 className="w-3 h-3" /></Button>
                      </div>
                    </div>
                    {editingIdx === idx ? (
                      <Textarea value={ch.content} onChange={(e) => updateChapter(idx, { content: e.target.value })} rows={8} className="font-mono text-xs leading-relaxed" />
                    ) : (
                      <div className="text-xs text-ink-muted line-clamp-3">{ch.content.slice(0, 200)}...</div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-between gap-2 pt-4 border-t border-line">
              <Button variant="secondary" size="md" onClick={() => setStep("upload")}>← 返回上传</Button>
              <Button
                variant="primary"
                size="md"
                loading={loading}
                disabled={loading || !preview.chapters.length}
                onClick={handleCreate}
              >
                ✅ 确认导入
              </Button>
            </div>
          </>
        )}

        {step === "creating" && (
          <div className="text-center py-20">
            <Spinner size="lg" className="mx-auto mb-4 text-primary" />
            <h3 className="text-xl font-bold mb-2 text-ink-primary">正在导入剧本...</h3>
            <p className="text-ink-secondary text-sm">
              正在保存原文,不调用模型,很快就好
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
