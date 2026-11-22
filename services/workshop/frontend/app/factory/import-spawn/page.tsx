"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getUser, getToken } from "../../../lib/auth";
import { UserNav } from "../../_UserNav";
import {
  ArrowLeft,
  FileUp,
  Loader2,
  AlertCircle,
  Sparkles,
  Info,
} from "lucide-react";
import { Button, Card, Textarea } from "@/components/ui";
import { FeishuFieldMapping } from "@/components/FeishuFieldMapping";
import { FeishuPreview } from "@/components/factory/FeishuPreview";
import { ValidationStandardCard } from "@/components/factory/ValidationStandardCard";
import { VideoConfigCard, VideoConfig } from "@/components/factory/VideoConfigCard";

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "";
const API = `${BASE}/v1/factory`;

type ImportMode = "factory" | "feishu" | "file" | "text";

type LibraryScript = {
  id: number;
  job_id: number;
  title: string;
  episodes: number;
  words: number;
};

export default function ImportSpawnPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/login?from=/factory/import-spawn";
      return null;
    }
  }

  const router = useRouter();
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` });

  // 导入来源
  const [importMode, setImportMode] = useState<ImportMode>("factory");

  // 工厂剧本批量选取
  const [library, setLibrary] = useState<LibraryScript[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [selectedScripts, setSelectedScripts] = useState<Set<number>>(new Set());

  // 飞书配置
  const [feishuUrl, setFeishuUrl] = useState("");
  const [feishuTextField, setFeishuTextField] = useState("content");
  const [feishuFileField, setFeishuFileField] = useState("");

  // 文件/文本
  const [file, setFile] = useState<File | null>(null);
  const [textContent, setTextContent] = useState("");

  // 校验标准
  const [validationCriteria, setValidationCriteria] = useState("");

  // 裂变配置
  const [enableNovel, setEnableNovel] = useState(true);
  const [novelCount, setNovelCount] = useState(1);

  const [enableTweet, setEnableTweet] = useState(true);
  const [tweetCount, setTweetCount] = useState(1);

  const [enableVideo, setEnableVideo] = useState(false);
  const [videoConfig, setVideoConfig] = useState<VideoConfig>({
    style: "normal",
    duration: 60,
    quality: "1080p",
    image_style: "",
    voice_mode: "auto",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // 加载工厂剧本库(批量选取)
  useEffect(() => {
    if (importMode !== "factory" || library.length > 0) return;
    setLibraryLoading(true);
    fetch(`${API}/scripts-library`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setLibrary(data || []))
      .catch(() => {})
      .finally(() => setLibraryLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importMode]);

  const toggleScript = (id: number) => {
    setSelectedScripts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");

    try {
      // 验证输入
      if (importMode === "factory" && selectedScripts.size === 0) {
        throw new Error("请至少勾选一部工厂剧本");
      }
      if (importMode === "feishu" && !feishuUrl.trim()) {
        throw new Error("请输入飞书文档链接");
      }
      if (importMode === "file" && !file) {
        throw new Error("请选择文件");
      }
      if (importMode === "text" && !textContent.trim()) {
        throw new Error("请输入文本内容");
      }

      // 至少选择一种裂变
      if (!enableNovel && !enableTweet && !enableVideo) {
        throw new Error("请至少选择一种裂变方式");
      }

      // 构造payload
      const config: any = {
        // 校验标准
        validation_criteria: validationCriteria.trim() || null,

        // 裂变配置
        spawn_config: {
          novel: { enabled: enableNovel, count: novelCount },
          tweet: { enabled: enableTweet, count: tweetCount },
          video: enableVideo
            ? {
                enabled: true,
                ...videoConfig,
              }
            : { enabled: false },
        },
      };

      if (importMode === "factory") {
        // 批量选取工厂剧本 → 多源
        config.import_sources = Array.from(selectedScripts).map((id) => ({
          type: "factory_script",
          product_id: id,
        }));
      } else {
        config.import_source = {
          type: importMode,
          url: importMode === "feishu" ? feishuUrl : undefined,
          text_field_name: importMode === "feishu" ? feishuTextField : undefined,
          file_field_name: importMode === "feishu" && feishuFileField ? feishuFileField : undefined,
          content: importMode === "text" ? textContent : undefined,
        };
      }

      const payload: any = { job_type: "import_spawn", config };

      // 如果是文件上传,使用FormData
      let body: any;
      let headers: any;
      
      if (importMode === "file" && file) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("config", JSON.stringify(payload.config));
        body = formData;
        headers = { ...authHeaders() }; // 不设置Content-Type,让浏览器自动设置
      } else {
        body = JSON.stringify(payload);
        headers = {
          ...authHeaders(),
          "Content-Type": "application/json",
        };
      }

      const r = await fetch(`${API}/jobs`, {
        method: "POST",
        headers,
        body,
      });

      if (!r.ok) {
        const data = await r.json().catch(() => ({ detail: "提交失败" }));
        throw new Error(data.detail || `HTTP ${r.status}`);
      }

      const { job_id } = await r.json();
      router.push(`/factory/jobs/${job_id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-surface-base">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部导航 */}
        <header className="h-topbar border-b border-line flex items-center justify-between px-6 bg-surface-elevated">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/factory")}
              className="gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </Button>
            <div className="flex items-center gap-2">
              <FileUp className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">导入剧本</h1>
            </div>
          </div>
          <UserNav />
        </header>

        {/* 主体内容 */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto space-y-6">
            {/* 错误提示 */}
            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 flex items-center gap-2">
                <AlertCircle className="w-5 h-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* 说明卡片 */}
            <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-3">
                <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-blue-900">
                  <p className="font-medium mb-1">导入剧本流程</p>
                  <p>填写参数 → 一键提交 → 后台自动执行(导入→V2.0校验→裂变)</p>
                  <p className="mt-2 text-blue-700">
                    ✓ 支持飞书文档/文件上传/直接粘贴<br />
                    ✓ 自动执行V2.0结构化检查(14项)<br />
                    ✓ 校验通过后自动裂变为小说/推文/视频
                  </p>
                </div>
              </div>
            </div>

            {/* 导入来源 */}
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">导入来源</h2>

              {/* Tab选择 */}
              <div className="flex gap-2 mb-6">
                <button
                  onClick={() => setImportMode("factory")}
                  className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                    importMode === "factory"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated text-ink-secondary hover:bg-surface-base"
                  }`}
                >
                  工厂剧本
                </button>
                <button
                  onClick={() => setImportMode("feishu")}
                  className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                    importMode === "feishu"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated text-ink-secondary hover:bg-surface-base"
                  }`}
                >
                  飞书文档
                </button>
                <button
                  onClick={() => setImportMode("file")}
                  className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                    importMode === "file"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated text-ink-secondary hover:bg-surface-base"
                  }`}
                >
                  上传文件
                </button>
                <button
                  onClick={() => setImportMode("text")}
                  className={`flex-1 py-2 px-4 rounded-lg font-medium transition-colors ${
                    importMode === "text"
                      ? "bg-primary text-white"
                      : "bg-surface-elevated text-ink-secondary hover:bg-surface-base"
                  }`}
                >
                  直接粘贴
                </button>
              </div>

              {/* 工厂剧本批量选取 */}
              {importMode === "factory" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-ink-primary">
                      选择工厂剧本(可多选) <span className="text-red-500">*</span>
                    </label>
                    <span className="text-xs text-ink-secondary">
                      已选 {selectedScripts.size} 部
                      {library.length > 0 && (
                        <button
                          className="ml-3 text-primary hover:underline"
                          onClick={() => setSelectedScripts(
                            selectedScripts.size === library.length
                              ? new Set()
                              : new Set(library.map((s) => s.id))
                          )}
                        >
                          {selectedScripts.size === library.length ? "取消全选" : "全选"}
                        </button>
                      )}
                    </span>
                  </div>
                  {libraryLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    </div>
                  ) : library.length === 0 ? (
                    <div className="text-center py-8 text-sm text-ink-secondary">
                      暂无已完成的工厂剧本，请先在「从零创作」中生成
                    </div>
                  ) : (
                    <div className="border border-line rounded-lg divide-y divide-line max-h-[360px] overflow-y-auto">
                      {library.map((s) => (
                        <label
                          key={s.id}
                          className="flex items-center gap-3 p-3 hover:bg-surface-elevated cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedScripts.has(s.id)}
                            onChange={() => toggleScript(s.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">{s.title}</div>
                            <div className="text-xs text-ink-secondary">
                              任务#{s.job_id} · {s.episodes}集 · {(s.words || 0).toLocaleString()}字
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 飞书导入 */}
              {importMode === "feishu" && (
                <div className="space-y-4">
                  <FeishuFieldMapping
                    url={feishuUrl}
                    textFieldName={feishuTextField}
                    fileFieldName={feishuFileField}
                    onUrlChange={setFeishuUrl}
                    onTextFieldChange={setFeishuTextField}
                    onFileFieldChange={setFeishuFileField}
                  />
                  
                  {/* 飞书预览 */}
                  <FeishuPreview
                    url={feishuUrl}
                    textFieldName={feishuTextField}
                    titleFieldName={feishuFileField}
                  />
                </div>
              )}

              {/* 文件上传 */}
              {importMode === "file" && (
                <div>
                  <label className="text-sm font-medium text-ink-primary block mb-2">
                    选择文件 <span className="text-red-500">*</span>
                  </label>
                  <div className="border-2 border-dashed border-line rounded-lg p-8 text-center hover:border-primary transition-colors">
                    <input
                      type="file"
                      accept=".txt,.docx,.pdf,.md"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="hidden"
                      id="file-upload"
                    />
                    <label
                      htmlFor="file-upload"
                      className="cursor-pointer text-primary hover:underline text-sm font-medium"
                    >
                      点击选择文件
                    </label>
                    <p className="text-xs text-ink-secondary mt-2">
                      支持 .txt, .docx, .pdf, .md 格式,最大 10MB
                    </p>
                    {file && (
                      <div className="mt-3 text-sm text-ink-primary">
                        已选择: <span className="font-medium">{file.name}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 文本粘贴 */}
              {importMode === "text" && (
                <div>
                  <label className="text-sm font-medium text-ink-primary block mb-2">
                    剧本内容 <span className="text-red-500">*</span>
                  </label>
                  <Textarea
                    value={textContent}
                    onChange={(e) => setTextContent(e.target.value)}
                    placeholder="请粘贴剧本内容..."
                    rows={15}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-ink-secondary mt-1">
                    {textContent.length} 字符
                  </p>
                </div>
              )}
            </Card>

            {/* 剧本校验标准(V2.0) */}
            <ValidationStandardCard
              customCriteria={validationCriteria}
              onCustomCriteriaChange={setValidationCriteria}
            />

            {/* 裂变配置 */}
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">裂变配置</h2>

              <div className="space-y-3">
                {/* 小说 */}
                <label className="flex items-center gap-3 p-4 border border-line rounded-lg hover:bg-surface-elevated cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={enableNovel}
                    onChange={(e) => setEnableNovel(e.target.checked)}
                    className="w-5 h-5"
                  />
                  <div className="flex-1">
                    <div className="font-medium">生成小说</div>
                    <div className="text-sm text-ink-secondary">
                      将剧本改写为小说体裁
                    </div>
                  </div>
                  {enableNovel && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ink-secondary">数量:</span>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={novelCount}
                        onChange={(e) => setNovelCount(Number(e.target.value))}
                        className="w-16 px-2 py-1 border border-line rounded text-center"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </label>

                {/* 推文 */}
                <label className="flex items-center gap-3 p-4 border border-line rounded-lg hover:bg-surface-elevated cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={enableTweet}
                    onChange={(e) => setEnableTweet(e.target.checked)}
                    className="w-5 h-5"
                  />
                  <div className="flex-1">
                    <div className="font-medium">生成推文</div>
                    <div className="text-sm text-ink-secondary">
                      将剧本改写为短推文格式
                    </div>
                  </div>
                  {enableTweet && (
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-ink-secondary">数量:</span>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={tweetCount}
                        onChange={(e) => setTweetCount(Number(e.target.value))}
                        className="w-16 px-2 py-1 border border-line rounded text-center"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </label>

                {/* 视频 */}
                <label className="flex items-center gap-3 p-4 border border-line rounded-lg hover:bg-surface-elevated cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={enableVideo}
                    onChange={(e) => setEnableVideo(e.target.checked)}
                    className="w-5 h-5"
                  />
                  <div className="flex-1">
                    <div className="font-medium">转为视频</div>
                    <div className="text-sm text-ink-secondary">
                      自动生成配音和视频(包含批量转视频功能)
                    </div>
                  </div>
                </label>
              </div>

              {/* 视频参数(折叠) */}
              {enableVideo && (
                <div className="mt-4">
                  <VideoConfigCard config={videoConfig} onChange={setVideoConfig} />
                </div>
              )}
            </Card>

            {/* 提交按钮 */}
            <Button
              onClick={handleSubmit}
              disabled={loading}
              className="w-full"
              size="lg"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  提交中...
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 mr-2" />
                  一键提交
                </>
              )}
            </Button>

            <p className="text-xs text-ink-secondary text-center">
              提交后将跳转到任务详情页面,您可以实时查看导入→校验→裂变的进度
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}