"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { getToken } from "../../../lib/auth"
import { ArrowLeft, Sparkles, Loader2 } from "lucide-react"

const BASE = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || ""
const API = `${BASE}/v1/factory`

export default function CreateSpawnPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [distTargets, setDistTargets] = useState<{ id: number; name: string }[]>([])
  const [formData, setFormData] = useState({
    task_name: "",
    theme: "",
    total_scripts: 10,
    episodes: 80,
    words_per_chapter: 2000,
    planned_dist_target_id: 0,
  })

  // 拉取分发目标列表(供"预期分发给谁"下拉)
  useEffect(() => {
    fetch(`${API}/dist-targets`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((ts) => setDistTargets(ts || []))
      .catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const target = distTargets.find((t) => t.id === formData.planned_dist_target_id)
      const res = await fetch(`${API}/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          job_type: "create_spawn",
          config: {
            task_name: formData.task_name.trim(),
            theme: formData.theme.trim(),
            total_scripts: formData.total_scripts,
            episodes: formData.episodes,
            words_per_chapter: formData.words_per_chapter,
            planned_dist_target_id: formData.planned_dist_target_id || null,
            planned_dist_target_name: target?.name || "",
          },
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || `HTTP ${res.status}`)
      }
      const data = await res.json()
      router.push(data.job_id ? `/factory/jobs/${data.job_id}` : "/factory")
    } catch (err: any) {
      setError(err.message || "创建任务失败")
    } finally {
      setLoading(false)
    }
  }

  const set = (key: string, value: string | number) =>
    setFormData((prev) => ({ ...prev, [key]: value }))

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="max-w-3xl mx-auto px-4 py-8">
        {/* 顶部导航 */}
        <button
          onClick={() => router.push("/factory")}
          className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          返回工厂
        </button>

        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm">
          <div className="p-6 border-b border-gray-200 dark:border-gray-800">
            <h1 className="text-xl font-semibold flex items-center gap-2 text-gray-900 dark:text-gray-100">
              <Sparkles className="w-5 h-5 text-purple-500" />
              从零创作
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              AI 发散差异化创意 → 生成大纲 → 双轮质检优化 → 批量衍生剧本
            </p>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-5">
            {/* 任务名称 */}
            <div>
              <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">
                任务名称 <span className="text-gray-400 text-xs">(选填，留空自动用"从零创作 + 时间")</span>
              </label>
              <input
                value={formData.task_name}
                onChange={(e) => set("task_name", e.target.value)}
                placeholder="例如: 8月A组悬疑批次"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            {/* 预期分发给谁 */}
            <div>
              <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">
                预期分发给谁 <span className="text-gray-400 text-xs">(选填，仅作计划标记；实际分发在任务详情页操作)</span>
              </label>
              <select
                value={formData.planned_dist_target_id}
                onChange={(e) => set("planned_dist_target_id", parseInt(e.target.value) || 0)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value={0}>(暂不指定)</option>
                {distTargets.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              {distTargets.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">暂无分发目标，可在任务详情页「分发 → 目标配置」中创建</p>
              )}
            </div>

            {/* 创作主题(选填) */}
            <div>
              <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">
                创作主题 <span className="text-gray-400 text-xs">(选填，建议留空)</span>
              </label>
              <textarea
                value={formData.theme}
                onChange={(e) => set("theme", e.target.value)}
                placeholder="留空时 AI 会自由发散多个差异化题材（推荐，成片题材更丰富）；填写则所有剧本都围绕该方向创作"
                rows={3}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none"
              />
              <p className="text-xs text-amber-600 mt-1">
                💡 留空效果更好：AI 会按批次发散出题材/主角/冲突各不相同的创意，避免多部剧本高度雷同
              </p>
            </div>

            {/* 数量参数 */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">剧本数量</label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={formData.total_scripts}
                  onChange={(e) => set("total_scripts", parseInt(e.target.value) || 1)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">每部集数</label>
                <input
                  type="number"
                  min={30}
                  max={100}
                  value={formData.episodes}
                  onChange={(e) => set("episodes", parseInt(e.target.value) || 80)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5 text-gray-700 dark:text-gray-300">每章字数</label>
                <input
                  type="number"
                  min={500}
                  max={5000}
                  step={100}
                  value={formData.words_per_chapter}
                  onChange={(e) => set("words_per_chapter", parseInt(e.target.value) || 2000)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-transparent px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500"
                />
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </div>
            )}

            {/* 提交按钮 */}
            <button
              type="submit"
              disabled={loading}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-purple-600 hover:bg-purple-700 disabled:opacity-60 text-white text-sm font-medium py-2.5 transition-colors"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  创建中...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  开始创作
                </>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}