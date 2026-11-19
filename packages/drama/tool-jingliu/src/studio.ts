/** Native studio operations used to review subtitle lines and manage shared assets. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'
import type { Dependencies } from './index.ts'

/**
 * Expose episode, subtitle, HD history and shared asset operations in chat.
 * @param deps - Current studio and user confirmation service.
 * @returns Additional studio operations absent from its desktop-agent catalog.
 */
export function studioTool(deps: Dependencies): ToolDefinition {
  return defineTool({ name: 'jingliu_studio',
    description: '镜流共享素材搜索与导入、查看剧本分集原文、逐条审校字幕、回写字幕的文本或时间、查看高清产物。',
    parameters: { action: { type: 'string', required: true, enum: ['library','import_assets','episodes','subtitles','edit_subtitle','hd_history'] },
      project_id: { type: 'string' }, query: { type: 'string' }, kind: { type: 'string', enum: ['character','location','prop'] },
      offset: { type: 'integer' }, asset_ids: { type: 'array', items: { type: 'string' } },
      clip_id: { type: 'string' }, text: { type: 'string' }, duration: { type: 'number' }, start_offset_sec: { type: 'number' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result: Record<string, JsonValue>) => [{ type: 'text', text: JSON.stringify(result) }] },
    async execute(params, exec): Promise<Record<string, JsonValue>> {
      const { action, project_id, query, kind, offset = 0, asset_ids, clip_id, text, duration, start_offset_sec } = params
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中使用镜流。', 'JINGLIU_SESSION_REQUIRED')
      const session = await deps.connect()
      const selected = await deps.selected?.(exec.agent.session.id, session.identity)
      const pid = project_id || selected?.id
      let result: unknown
      if (!Number.isSafeInteger(offset) || offset < 0 || (duration !== undefined && (!Number.isFinite(duration) || duration < 0.1)) || (start_offset_sec !== undefined && (!Number.isFinite(start_offset_sec) || start_offset_sec < 0))) throw new HarnessError('请检查分页或字幕时间。', 'JINGLIU_INVALID_ARGUMENTS')
      if (action === 'library') {
        const params = new URLSearchParams({ limit: '24', offset: String(offset), q: query ?? '', ...(kind && { kind }) })
        result = await session.request('/library?' + params.toString(), { signal: exec.signal })
      } else {
        if (!pid || !/^[\w-]+$/u.test(pid) || (selected && selected.id !== pid)) throw new HarnessError('请确认当前镜流项目。', 'JINGLIU_INVALID_PROJECT')
        const path = '/projects/' + pid
        if (action === 'episodes') result = await session.request(path + '/episodes/content', { signal: exec.signal })
        else if (action === 'hd_history') result = await session.request(path + '/video-upscale-jobs?limit=30', { signal: exec.signal })
        else if (action === 'import_assets') {
          if (!asset_ids?.length || asset_ids.some(id => !/^[\w-]+$/u.test(id))) throw new HarnessError('请指定共享库中的素材。', 'JINGLIU_INVALID_ARGUMENTS')
          if (!await deps.approve(exec, '将 ' + asset_ids.length + ' 项共享素材导入镜流项目 ' + pid)) throw new HarnessError('素材导入未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
          result = await session.request('/library/import', { method: 'POST', body: { project_id: pid, asset_ids }, signal: exec.signal })
        } else {
          const list = await session.request(path + '/subtitle-clips', { signal: exec.signal })
          if (!isFields(list) || !Array.isArray(list.clips)) throw new HarnessError('镜流字幕列表无效。', 'JINGLIU_INVALID_RESULT')
          if (action === 'subtitles') return list
          if (!clip_id || !/^[\w-]+$/u.test(clip_id) || !list.clips.some(c => isFields(c) && c.id === clip_id) ||
              (text === undefined && duration === undefined && start_offset_sec === undefined)) throw new HarnessError('请指定本项目内的字幕及需要修改的字段。', 'JINGLIU_INVALID_ARGUMENTS')
          const patch = { ...(text === undefined ? {} : { text: text.trim() }), ...(duration === undefined ? {} : { duration }),
            ...(start_offset_sec === undefined ? {} : { start_offset_sec }) }
          if (!await deps.approve(exec, '修改镜流项目 ' + pid + ' 的字幕 ' + clip_id + '\n' + JSON.stringify(patch))) throw new HarnessError('字幕修改未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
          result = await session.request('/subtitle-clips/' + clip_id, { method: 'PATCH', body: patch, signal: exec.signal })
          if (!isFields(result) || result.id !== clip_id || Object.entries(patch).some(([key, value]) => isFields(result) && result[key] !== value)) throw new HarnessError('镜流没有确认此次字幕修改的结果，请重新读取字幕。', 'JINGLIU_INVALID_RESULT')
        }
      }
      if (!isFields(result)) throw new HarnessError('镜流返回了无法辨认的结果。', 'JINGLIU_INVALID_RESULT')
      return result
    } })
}
