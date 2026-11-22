'use client'

import { useState } from 'react'
import { authFetch } from '@/lib/auth'

interface PreviewItem {
  row_id: string
  title: string
  text_preview: string
  text_length: number
  has_content: boolean
}

interface PreviewData {
  success: boolean
  total: number
  empty_rows: number
  field_exists: {
    text_field: boolean
    title_field: boolean
  }
  preview: PreviewItem[]
}

interface FeishuPreviewProps {
  url: string
  textFieldName: string
  titleFieldName?: string
  onPreviewSuccess?: (data: PreviewData) => void
}

export function FeishuPreview({
  url,
  textFieldName,
  titleFieldName,
  onPreviewSuccess
}: FeishuPreviewProps) {
  const [previewData, setPreviewData] = useState<PreviewData | null>(null)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string>('')

  const handleFetchPreview = async () => {
    if (!url || !textFieldName) return

    setFetching(true)
    setError('')
    setPreviewData(null)

    try {
      const params = new URLSearchParams({
        url,
        text_field_name: textFieldName,
        ...(titleFieldName && { title_field_name: titleFieldName }),
        limit: '10'
      })

      // ⚠ 原先读 localStorage('token') —— 键名不存在(真实键见 lib/auth.ts),
      // 于是一直发的是字面量 `Bearer null`。统一走 authFetch。
      const res = await authFetch(`/v1/factory/feishu/preview?${params}`)

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '预览失败')
      }

      const data: PreviewData = await res.json()
      setPreviewData(data)
      onPreviewSuccess?.(data)
    } catch (e: any) {
      setError(e.message || '预览失败')
    } finally {
      setFetching(false)
    }
  }

  const canFetch = url && textFieldName && !fetching

  return (
    <div className="space-y-3">
      {/* 获取预览按钮 */}
      <button
        onClick={handleFetchPreview}
        disabled={!canFetch}
        className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
          canFetch
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-gray-300 text-gray-500 cursor-not-allowed'
        }`}
      >
        {fetching ? '获取中...' : '获取预览'}
      </button>

      {/* 错误提示 */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded">
          <div className="font-medium text-red-700 text-sm">获取预览失败</div>
          <div className="text-red-600 text-sm mt-1">{error}</div>
          <div className="text-gray-600 text-sm mt-2">请检查:</div>
          <ul className="list-disc list-inside text-gray-600 text-sm">
            <li>飞书表格链接是否正确</li>
            <li>字段名是否与表格列名完全匹配</li>
            <li>是否有权限访问该表格</li>
          </ul>
        </div>
      )}

      {/* 预览结果 */}
      {previewData && (
        <div className="p-4 border border-gray-200 rounded-lg bg-gray-50">
          {/* 统计信息 */}
          <div className="flex items-center justify-between mb-3 pb-3 border-b border-gray-300">
            <span className="text-sm">
              共检测到 <strong className="text-blue-600">{previewData.total}</strong> 条记录
            </span>
            {previewData.empty_rows > 0 && (
              <span className="text-yellow-600 text-sm">
                包含 {previewData.empty_rows} 个空行(将跳过)
              </span>
            )}
          </div>

          {/* 字段验证状态 */}
          <div className="mb-3 space-y-1">
            <div
              className={`text-sm ${
                previewData.field_exists.text_field ? 'text-green-600' : 'text-red-600'
              }`}
            >
              {previewData.field_exists.text_field ? '✓' : '✗'} 文本字段 &quot;{textFieldName}&quot;{' '}
              {previewData.field_exists.text_field ? '存在' : '不存在'}
            </div>
            {titleFieldName && (
              <div
                className={`text-sm ${
                  previewData.field_exists.title_field ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {previewData.field_exists.title_field ? '✓' : '✗'} 标题字段 &quot;{titleFieldName}&quot;{' '}
                {previewData.field_exists.title_field ? '存在' : '不存在'}
              </div>
            )}
          </div>

          {/* 预览列表 */}
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {previewData.preview.map((item, idx) => (
              <div key={item.row_id || idx} className="p-3 bg-white rounded border border-gray-200">
                <div className="font-medium text-gray-900 text-sm mb-1">{item.title}</div>
                <div className="text-gray-600 text-sm line-clamp-2">{item.text_preview}</div>
                <div className="text-xs text-gray-500 mt-2">{item.text_length.toLocaleString()} 字</div>
              </div>
            ))}
          </div>

          {/* 更多提示 */}
          {previewData.total > 10 && (
            <div className="text-xs text-gray-500 mt-3 text-center">
              ...及其他 {previewData.total - 10} 条记录
            </div>
          )}
        </div>
      )}
    </div>
  )
}