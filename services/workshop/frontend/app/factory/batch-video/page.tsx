"use client"

import { useState, useCallback, useEffect } from "react"
import { useRouter } from "next/navigation"
import { getUser, getToken } from "../../../lib/auth"
import { UserNav } from "../../_UserNav"
import { FeishuFieldMapping } from "../../../components/FeishuFieldMapping"
import { FeishuPreview } from "../../../components/factory/FeishuPreview"
import {
  ArrowLeft, Video, Upload, Type, Table2, Loader2, 
  Plus, X, Play, RefreshCw
} from "lucide-react"

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || ""
const API = `${BASE}/v1/factory`

// 清晰度选项(参考novel-video)
const QUALITY = [
  { id: "1k", label: "1K", short: 1080 },
  { id: "2k", label: "2K", short: 1440 },
  { id: "4k", label: "4K", short: 2160 },
]

// 比例选项
const RATIO = [
  { id: "9:16", label: "9:16 竖屏", w: 9, h: 16 },
  { id: "16:9", label: "16:9 横屏", w: 16, h: 9 },
  { id: "4:3", label: "4:3", w: 4, h: 3 },
  { id: "3:4", label: "3:4", w: 3, h: 4 },
  { id: "1:1", label: "1:1 方形", w: 1, h: 1 },
]

// 音色模式
const VOICE_MODES = [
  { id: "auto", label: "自动选择" },
  { id: "male", label: "男声" },
  { id: "female", label: "女声" },
]

type TextItem = {
  id: string
  content: string
  title: string
}

type FeishuImport = {
  url: string
  text_field_name: string
  title_field_name?: string
}

export default function BatchVideoPage() {
  if (typeof window !== "undefined") {
    if (!getUser()) {
      window.location.href = "/login?from=/factory/batch-video"
      return null
    }
  }

  const router = useRouter()
  const authHeaders = () => ({ Authorization: `Bearer ${getToken()}` })

  // 导入来源
  const [sourceType, setSourceType] = useState<"text" | "file" | "feishu">("text")
  const [textItems, setTextItems] = useState<TextItem[]>([
    { id: "1", content: "", title: "" }
  ])
  const [fileUploading, setFileUploading] = useState(false)
  const [feishuUrl, setFeishuUrl] = useState("")
  const [feishuTextField, setFeishuTextField] = useState("正文")
  const [feishuTitleField, setFeishuTitleField] = useState("标题")

  // 视频参数(参考novel-video风格)
  const [stylePrompt, setStylePrompt] = useState("")
  const [quality, setQuality] = useState("1k")
  const [ratio, setRatio] = useState("9:16")
  const [fps, setFps] = useState(30)
  const [perImageSeconds, setPerImageSeconds] = useState(10)
  const [voiceMode, setVoiceMode] = useState<"auto" | "male" | "female">("auto")

  // 提交状态
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")

  // 文本输入相关
  const addTextItem = () => {
    setTextItems([...textItems, { 
      id: Date.now().toString(), 
      content: "", 
      title: `文本${textItems.length + 1}` 
    }])
  }

  const removeTextItem = (id: string) => {
    if (textItems.length > 1) {
      setTextItems(textItems.filter(item => item.id !== id))
    }
  }

  const updateTextItem = (id: string, field: "content" | "title", value: string) => {
    setTextItems(textItems.map(item => 
      item.id === id ? { ...item, [field]: value } : item
    ))
  }

  // 文件上传
  const handleFileUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setFileUploading(true)
    setError("")

    try {
      const newItems: TextItem[] = []
      
      for (const file of Array.from(files)) {
        const text = await file.text()
        newItems.push({
          id: Date.now().toString() + Math.random(),
          content: text,
          title: file.name.replace(/\.[^/.]+$/, "")
        })
      }

      setTextItems(prevItems => {
        // 如果只有一个空白项,替换它;否则追加
        if (prevItems.length === 1 && !prevItems[0].content) {
          return newItems
        }
        return [...prevItems, ...newItems]
      })
    } catch (e: any) {
      setError(`文件读取失败: ${e.message}`)
    } finally {
      setFileUploading(false)
    }
  }

  // 提交批量转视频任务
  const handleSubmit = async () => {
    setError("")

    // 验证输入
    let texts: { content: string; title: string }[] = []
    
    if (sourceType === "text") {
      texts = textItems
        .filter(item => item.content.trim())
        .map(item => ({
          content: item.content.trim(),
          title: item.title.trim() || `文本${textItems.indexOf(item) + 1}`
        }))
      
      if (texts.length === 0) {
        setError("请至少输入一条文本内容")
        return
      }
    } else if (sourceType === "feishu") {
      if (!feishuUrl.trim()) {
        setError("请输入飞书多维表格URL")
        return
      }
    }

    setSubmitting(true)

    try {
      const config: any = {
        video_params: {
          style_prompt: stylePrompt || "生动细腻的画面,电影级质感",
          quality,
          ratio,
          fps,
          per_image_seconds: perImageSeconds,
          voice_mode: voiceMode,
        }
      }

      if (sourceType === "feishu") {
        config.source = {
          type: "feishu",
          url: feishuUrl,
          text_field_name: feishuTextField,
          title_field_name: feishuTitleField || undefined,
        }
      } else {
        config.source = {
          type: "texts",
          items: texts,
        }
      }

      const r = await fetch(`${API}/jobs`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          job_type: "batch_video",
          config,
        }),
      })

      if (!r.ok) {
        const errData = await r.json().catch(() => ({ detail: "提交失败" }))
        throw new Error(errData.detail || "提交失败")
      }

      const data = await r.json()
      router.push(`/factory/jobs/${data.job_id}`)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-screen bg-surface-base">
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 顶部导航 */}
        <header className="h-topbar border-b border-line flex items-center justify-between px-6 bg-surface-elevated">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push("/factory")}
              className="flex items-center gap-2 text-ink-secondary hover:text-ink-primary transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              返回
            </button>
            <div className="flex items-center gap-2">
              <Video className="w-5 h-5 text-primary" />
              <h1 className="text-xl font-semibold">批量转视频</h1>
            </div>
          </div>
          <UserNav />
        </header>

        {/* 主体内容 */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-5xl mx-auto space-y-6">
            {/* 错误提示 */}
            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
                {error}
              </div>
            )}

            {/* 导入来源选择 */}
            <div className="bg-surface-elevated rounded-lg border border-line p-6">
              <h2 className="text-lg font-semibold mb-4">导入来源</h2>
              <div className="flex gap-3 mb-4">
                <button
                  onClick={() => setSourceType("text")}
                  className={`flex-1 p-4 rounded-lg border-2 transition-all ${
                    sourceType === "text"
                      ? "border-primary bg-primary/5"
                      : "border-line hover:border-primary/50"
                  }`}
                >
                  <Type className="w-6 h-6 mx-auto mb-2" />
                  <div className="font-medium">直接输入</div>
                  <div className="text-xs text-ink-secondary mt-1">粘贴或输入文本</div>
                </button>

                <button
                  onClick={() => setSourceType("file")}
                  className={`flex-1 p-4 rounded-lg border-2 transition-all ${
                    sourceType === "file"
                      ? "border-primary bg-primary/5"
                      : "border-line hover:border-primary/50"
                  }`}
                >
                  <Upload className="w-6 h-6 mx-auto mb-2" />
                  <div className="font-medium">文件上传</div>
                  <div className="text-xs text-ink-secondary mt-1">支持 .txt 文件</div>
                </button>

                <button
                  onClick={() => setSourceType("feishu")}
                  className={`flex-1 p-4 rounded-lg border-2 transition-all ${
                    sourceType === "feishu"
                      ? "border-primary bg-primary/5"
                      : "border-line hover:border-primary/50"
                  }`}
                >
                  <Table2 className="w-6 h-6 mx-auto mb-2" />
                  <div className="font-medium">飞书表格</div>
                  <div className="text-xs text-ink-secondary mt-1">从多维表格导入</div>
                </button>
              </div>

              {/* 直接输入 */}
              {sourceType === "text" && (
                <div className="space-y-3">
                  {textItems.map((item, idx) => (
                    <div key={item.id} className="p-4 border border-line rounded-lg">
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="text"
                          value={item.title}
                          onChange={(e) => updateTextItem(item.id, "title", e.target.value)}
                          placeholder={`标题 ${idx + 1}`}
                          className="flex-1 px-3 py-1.5 border border-line rounded bg-surface-base text-sm"
                        />
                        {textItems.length > 1 && (
                          <button
                            onClick={() => removeTextItem(item.id)}
                            className="p-1.5 text-ink-secondary hover:text-red-600 transition-colors"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      <textarea
                        value={item.content}
                        onChange={(e) => updateTextItem(item.id, "content", e.target.value)}
                        placeholder="在此输入或粘贴文本内容..."
                        rows={4}
                        className="w-full px-3 py-2 border border-line rounded bg-surface-base resize-none"
                      />
                    </div>
                  ))}
                  <button
                    onClick={addTextItem}
                    className="w-full p-3 border-2 border-dashed border-line rounded-lg text-ink-secondary hover:border-primary hover:text-primary transition-all flex items-center justify-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    添加更多文本
                  </button>
                </div>
              )}

              {/* 文件上传 */}
              {sourceType === "file" && (
                <div>
                  <label className="block w-full p-8 border-2 border-dashed border-line rounded-lg text-center cursor-pointer hover:border-primary hover:bg-primary/5 transition-all">
                    <Upload className="w-12 h-12 mx-auto mb-3 text-ink-secondary" />
                    <div className="text-ink-primary font-medium mb-1">
                      {fileUploading ? "上传中..." : "点击或拖拽文件到此处"}
                    </div>
                    <div className="text-sm text-ink-secondary">
                      支持 .txt 文件,可多选批量上传
                    </div>
                    <input
                      type="file"
                      accept=".txt"
                      multiple
                      onChange={(e) => handleFileUpload(e.target.files)}
                      disabled={fileUploading}
                      className="hidden"
                    />
                  </label>
                  
                  {textItems.some(item => item.content) && (
                    <div className="mt-4 space-y-2">
                      <div className="text-sm font-medium">已加载文件 ({textItems.filter(i => i.content).length})</div>
                      {textItems.filter(item => item.content).map(item => (
                        <div key={item.id} className="flex items-center justify-between p-2 bg-surface-base rounded">
                          <span className="text-sm">{item.title}</span>
                          <button
                            onClick={() => removeTextItem(item.id)}
                            className="text-ink-secondary hover:text-red-600"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 飞书导入 */}
              {sourceType === "feishu" && (
                <div className="space-y-4">
                  <FeishuFieldMapping
                    url={feishuUrl}
                    textFieldName={feishuTextField}
                    fileFieldName={feishuTitleField}
                    onUrlChange={setFeishuUrl}
                    onTextFieldChange={setFeishuTextField}
                    onFileFieldChange={setFeishuTitleField}
                  />
                  
                  {/* 飞书预览 */}
                  <FeishuPreview
                    url={feishuUrl}
                    textFieldName={feishuTextField}
                    titleFieldName={feishuTitleField}
                  />
                </div>
              )}
            </div>

            {/* 视频参数配置(参考novel-video风格) */}
            <div className="bg-surface-elevated rounded-lg border border-line p-6">
              <h2 className="text-lg font-semibold mb-4">视频参数</h2>

              {/* 画风提示词 */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">画风提示词</label>
                <textarea
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  placeholder="描述画面风格,如: 生动细腻的画面,电影级质感,温暖色调..."
                  rows={3}
                  className="w-full px-3 py-2 border border-line rounded bg-surface-base resize-none"
                />
              </div>

              {/* 清晰度 */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">清晰度</label>
                <div className="flex gap-3">
                  {QUALITY.map(q => (
                    <button
                      key={q.id}
                      onClick={() => setQuality(q.id)}
                      className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                        quality === q.id
                          ? "border-primary bg-primary/5"
                          : "border-line hover:border-primary/50"
                      }`}
                    >
                      <div className="font-medium">{q.label}</div>
                      <div className="text-xs text-ink-secondary">{q.short}p</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 比例 */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">视频比例</label>
                <div className="grid grid-cols-5 gap-2">
                  {RATIO.map(r => (
                    <button
                      key={r.id}
                      onClick={() => setRatio(r.id)}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        ratio === r.id
                          ? "border-primary bg-primary/5"
                          : "border-line hover:border-primary/50"
                      }`}
                    >
                      <div className="text-sm font-medium">{r.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* FPS 和每图秒数 */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium mb-2">帧率 (FPS)</label>
                  <input
                    type="number"
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    min="24"
                    max="60"
                    className="w-full px-3 py-2 border border-line rounded bg-surface-base"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">每图秒数</label>
                  <input
                    type="number"
                    value={perImageSeconds}
                    onChange={(e) => setPerImageSeconds(Number(e.target.value))}
                    min="2"
                    max="60"
                    className="w-full px-3 py-2 border border-line rounded bg-surface-base"
                  />
                </div>
              </div>

              {/* 音色模式 */}
              <div>
                <label className="block text-sm font-medium mb-2">配音模式</label>
                <div className="flex gap-3">
                  {VOICE_MODES.map(mode => (
                    <button
                      key={mode.id}
                      onClick={() => setVoiceMode(mode.id as any)}
                      className={`flex-1 p-3 rounded-lg border-2 transition-all ${
                        voiceMode === mode.id
                          ? "border-primary bg-primary/5"
                          : "border-line hover:border-primary/50"
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 提交按钮 */}
            <div className="flex gap-3">
              <button
                onClick={() => router.push("/factory")}
                className="px-6 py-3 border border-line rounded-lg hover:bg-surface-elevated transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 px-6 py-3 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    提交中...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5" />
                    开始转换
                  </>
                )}
              </button>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}