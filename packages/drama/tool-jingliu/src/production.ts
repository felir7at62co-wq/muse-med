/** Project lookup, approval and free-form images from the native studio. */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'
import type { Dependencies } from './workflow-tools.ts'
import { existingSubmission, submitOnce } from './submit-once.ts'

const output = { schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: Record<string, JsonValue>) => [{ type: 'text' as const, text: JSON.stringify(value) }] } as const

/**
 * Expose cloud project search, inspection and selection in chat.
 * @param deps - Muse account and project-selection services.
 * @returns Read and explicit selection operations available to the Router.
 */
export function projectsTool(deps: Dependencies): ToolDefinition {
  return defineTool({
    name: 'jingliu_projects', description: '搜索当前 Muse 用户有权查看的镜流制片项目，查看项目和本会话已确认的选择。select 只在用户确定项目后使用，右侧同步显示真实项目名。',
    parameters: { action: { type: 'string', required: true, enum: ['search','inspect','current','select'], description: '搜索、查看、读取当前选择或确认关联。' },
      query: { type: 'string', description: '项目名中的关键词。' }, project_id: { type: 'string', description: 'inspect 和 select 所需的确切编号。' },
      offset: { type: 'integer', description: '搜索结果分页起点。' } }, output,
    async execute({ action, query, project_id, offset = 0 }, exec): Promise<Record<string, JsonValue>> {
      const sid = exec.agent?.session.id
      if (!sid) throw new HarnessError('请在 Muse 聊天中查看制片项目。', 'JINGLIU_SESSION_REQUIRED')
      const session = await deps.connect()
      if (action === 'current') {
        const project = await deps.selected?.(sid, session.identity)
        return { project: project ? { ...project } : null }
      }
      if (action === 'search') {
        if (!Number.isSafeInteger(offset) || offset < 0) throw new HarnessError('搜索起点无效。', 'JINGLIU_INVALID_ARGUMENTS')
        const data = await session.request(`/projects?${new URLSearchParams({ q: query?.trim() ?? '' }).toString()}`, { signal: exec.signal })
        if (!isFields(data) || !Array.isArray(data.projects)) throw new HarnessError('镜流项目目录无法读取。', 'JINGLIU_INVALID_RESULT')
        return { total: data.projects.length, projects: data.projects.slice(offset, offset + 24).filter(isFields).map(p => ({
          id: p.id ?? null, title: p.title ?? null, episodes: p.episodes_count ?? null,
          shots: p.shots_total ?? null, ready: p.shots_done ?? null, role: p.my_role ?? null,
        })), ...(offset + 24 < data.projects.length && { next_offset: offset + 24 }) }
      }
      if (!project_id || !/^[a-zA-Z0-9_-]{1,128}$/u.test(project_id)) throw new HarnessError('请提供搜索结果中的项目 ID。', 'JINGLIU_INVALID_PROJECT')
      const data = await session.request('/projects/' + project_id, { signal: exec.signal })
      if (!isFields(data) || data.id !== project_id || typeof data.title !== 'string') throw new HarnessError('项目无法读取。', 'JINGLIU_INVALID_RESULT')
      if (action === 'inspect') return { project: data }
      if (!deps.select || !await deps.approve(exec, '将当前对话关联到镜流项目「' + data.title + '」 (' + project_id + ')')) throw new HarnessError('此对话尚未确认关联该项目。', 'JINGLIU_APPROVAL_REQUIRED')
      return { project: { ...await deps.select(sid, project_id, exec.signal) } }
    },
  })
}

/**
 * Generate standalone images and recover submitted job receipts.
 * @param deps - Authenticated studio and submission confirmation.
 * @returns The standalone Jingliu image tool.
 */
export function imageTool(deps: Dependencies): ToolDefinition {
  return defineTool({
    name: 'jingliu_image', description: '使用镜流生图。默认 GPT Image 2。提交后用 job_id 查进度，history 查看同项目产物。',
    parameters: { action: { type: 'string', required: true, enum: ['generate','history','models'] }, project_id: { type: 'string' },
      prompt: { type: 'string', description: '由 Muse 撰写或审校的完整生图提示词。' }, model: { type: 'string', description: '省略使用 gpt-image-2。' },
      size: { type: 'string', description: '尺寸，如 1024x1024。' }, count: { type: 'integer', description: '生成 1 至 4 张。' },
      reference_paths: { type: 'array', items: { type: 'string' }, description: '该项目已上传的镜流参考图路径。' } }, output,
    async execute({ action, project_id, prompt, model = 'gpt-image-2', size = '1024x1024', count = 1, reference_paths = [] }, exec): Promise<Record<string, JsonValue>> {
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中生图。', 'JINGLIU_SESSION_REQUIRED')
      const session = await deps.connect()
      const models = await session.request('/providers/image', { signal: exec.signal })
      if (!isFields(models) || !Array.isArray(models.models)) throw new HarnessError('镜流没有返回生图模型目录。', 'JINGLIU_INVALID_RESULT')
      if (action === 'models') return models
      const selected = await deps.selected?.(exec.agent.session.id, session.identity)
      const pid = project_id ?? selected?.id
      if (!pid || !/^[a-zA-Z0-9_-]{1,128}$/u.test(pid) || (selected && selected.id !== pid)) throw new HarnessError('请确认当前对话的镜流项目。', 'JINGLIU_INVALID_PROJECT')
      if (action === 'history') {
        const data = await session.request('/projects/' + pid + '/image-jobs?limit=60', { signal: exec.signal })
        if (!isFields(data)) throw new HarnessError('无法读取生图记录。', 'JINGLIU_INVALID_RESULT')
        return data
      }
      const chosen = models.models.find(m => isFields(m) && m.id === model)
      if (!isFields(chosen) || !prompt?.trim() || count < 1 || count > 4 || !/^\d{3,4}x\d{3,4}$/u.test(size)
        || (chosen.fixed_n != null && chosen.fixed_n !== count) || (chosen.supports_refs === false && reference_paths.length)
        || reference_paths.some(p => !/^\/fwp?\/media\//u.test(p) || /[?#\\]|%(?:2e|2f|5c|25)/iu.test(p) || p.split('/').includes('..'))) {
        throw new HarnessError('请核对模型、提示词、张数、尺寸及项目参考图。', 'JINGLIU_INVALID_ARGUMENTS')
      }
      const payload = { project_id: pid, model_id: model, prompt: prompt.trim(), size, n: count, ref_urls: reference_paths }
      const dir = join(resolveDshHome(), 'jingliu', 'submissions')
      const call = [exec.agent.session.id, exec.callId]
      const key = [session.identity, 'image', payload]
      const saved = await existingSubmission(dir, call, key)
      if (saved) return saved
      const quote = await session.request('/desktop-agent/tool', { method: 'POST', signal: exec.signal,
        body: { name: 'cost_estimate', project_id: pid, args: { project_id: pid, kind: 'image' }, call_id: call.join(':') + ':quote' } })
      if (!isFields(quote) || quote.ok !== true || quote.kind !== 'image' || typeof quote.estimate_fen !== 'number' || !Number.isSafeInteger(quote.estimate_fen) || quote.estimate_fen < 0) throw new HarnessError('未取得镜流生图报价。', 'JINGLIU_INVALID_QUOTE')
      const price = quote.estimate_fen > 0 ? '预计 ¥' + (quote.estimate_fen * count / 100).toFixed(2) : '镜流未给出金额，费用以实际结算为准'
      if (!await deps.approve(exec, `镜流生图 · ${model} · ${count} 张 · ${size}\n${price}\n${payload.prompt}`)) throw new HarnessError('本次生图未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
      return submitOnce(dir, call, key, () => session.request('/jobs', { method: 'POST', body: { kind: 'image', payload }, signal: exec.signal }))
    },
  })
}
