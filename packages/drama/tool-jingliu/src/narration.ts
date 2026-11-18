/** ShotFlow narration-dialogue workflows published by the project and job APIs. @module */
import { join } from 'node:path'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isFields } from './catalog.ts'
import type { Dependencies } from './index.ts'
import { installDraft } from './delivery.ts'
import { existingSubmission, submitOnce } from './submit-once.ts'

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new HarnessError('请选择镜流返回的项目或镜头编号。', 'JINGLIU_INVALID_ID')
  return value
}

function response(value: unknown): Record<string, JsonValue> {
  if (!isFields(value)) throw new HarnessError('镜流没有返回有效的解说剧结果。', 'JINGLIU_INVALID_RESULT')
  return value
}

/**
 * Create the tool for the narration-dialogue mode outside the desktop-agent catalog.
 * @param deps - authenticated connection and confirmation channel.
 * @returns one scoped production tool.
 */
export function narrationTool(deps: Dependencies): ToolDefinition {
  return defineTool({
    name: 'jingliu_narration',
    description: '镜流「解说剧·角色开口」工作流。state 查分集、镜头、核对报告和可用模型；model 切换模型；breakdown 拆解台词；produce 出片、对齐和核对；accept 接受某句差异；export 导出剪映草稿。任务提交后用 get_job 查进度。',
    parameters: {
      action: { type: 'string', required: true, enum: ['state', 'model', 'breakdown', 'produce', 'accept', 'export'] },
      project_id: { type: 'string', required: true, description: '镜流解说剧项目 ID。' },
      model: { type: 'string', description: 'model 操作使用 state 返回的模型 ID。' },
      episode: { type: 'integer', description: '指定集号，适用于拆解、出片或导出。拆解指定集会替换该集现有分镜。' },
      shot_id: { type: 'string', description: 'accept 的镜头，或 produce 要整条重做的单个镜头。' },
      beat: { type: 'integer', description: 'accept 所针对的核对报告中的 beat 值。' },
      force: { type: 'boolean', description: '全剧重新拆台词，仅适用于 breakdown。' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute({ action, project_id, model, episode, shot_id, beat, force }, exec): Promise<Record<string, JsonValue>> {
      const pid = identifier(project_id)
      const scope = '/projects/' + pid + '/nd'
      if (episode !== undefined && (!['produce', 'breakdown', 'export'].includes(action) || episode < 1)
          || shot_id !== undefined && (!['accept', 'produce'].includes(action) || episode !== undefined)
          || model !== undefined && action !== 'model' || force !== undefined && action !== 'breakdown'
          || beat !== undefined && action !== 'accept') throw new HarnessError('目标范围与解说剧操作不匹配。', 'JINGLIU_INVALID_ARGUMENTS')
      if (shot_id !== undefined) identifier(shot_id)
      const session = await deps.connect()
      const selected = exec.agent && await deps.selected?.(exec.agent.session.id, session.identity)
      if (selected && selected.id !== pid) throw new HarnessError('这个操作指向另一个制片项目。', 'JINGLIU_INVALID_PROJECT')
      const dir = join(resolveDshHome(), 'jingliu', 'submissions')
      const input = [session.identity, pid, action, episode ?? null, shot_id ?? null, force ?? false]
      if (exec.agent && (action === 'produce' || action === 'breakdown')) {
        const saved = await existingSubmission(dir, [exec.agent.session.id, exec.callId], input)
        if (saved) return saved
      }
      const state = response(await session.request(scope + '/state', { signal: exec.signal }))
      if (!Array.isArray(state.episodes) || !Array.isArray(state.models)) throw new HarnessError('镜流未返回解说剧状态。', 'JINGLIU_INVALID_RESULT')
      if (action === 'state') return state
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中操作解说剧。', 'JINGLIU_SESSION_REQUIRED')
      const ask = async (message: string): Promise<void> => {
        if (!await deps.approve(exec, '镜流解说剧 · 项目 ' + pid + '\n' + message)) {
          throw new HarnessError('本次解说剧操作未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
        }
        exec.signal.throwIfAborted()
      }
      if (action === 'model') {
        if (!model || !state.models.includes(model)) throw new HarnessError('请从 state 的 models 中选择已开通的模型。', 'JINGLIU_INVALID_ARGUMENTS')
        await ask('将出片模型设为 ' + model)
        return response(await session.request(scope + '/model', { method: 'PUT', body: { model }, signal: exec.signal }))
      }
      if (action === 'accept') {
        if (!shot_id || beat === undefined) throw new HarnessError('请提供核对报告中的 shot_id 和 beat。', 'JINGLIU_INVALID_ARGUMENTS')
        await ask('接受镜头 ' + shot_id + ' 的差异 ' + beat)
        return response(await session.request(scope + '/shots/' + shot_id + '/accept', { method: 'POST', body: { beat }, signal: exec.signal }))
      }
      if (action === 'export') {
        const root = await deps.draftRoot?.()
        if (deps.draftRoot && !root) throw new HarnessError('请先在 Muse 的短剧设置指定剪映草稿根目录。', 'JINGLIU_DRAFT_ROOT_REQUIRED')
        await ask('导出' + (episode === undefined ? '全剧' : '第 ' + episode + ' 集') + '剪映草稿' + (root ? '到 ' + root : ''))
        const result = response(await session.request(scope + '/export', { method: 'POST', body: { episode: episode ?? null, single_file: !root }, signal: exec.signal }))
        return root ? { draft: await installDraft(session, result, root, exec.agent.session.id + ':' + exec.callId, exec.signal) } : result
      }
      const kind = action === 'produce' ? 'nd_produce' : 'nd_breakdown'
      const payload: Record<string, JsonValue> = { project_id: pid }
      const estimateArgs: Record<string, JsonValue> = { project_id: pid, kind }
      if (action === 'produce' && (episode !== undefined || shot_id !== undefined)) {
        const shotIds: string[] = []
        for (const row of state.episodes) {
          if (!isFields(row) || (episode !== undefined && row.episode !== episode) || !Array.isArray(row.shots)) continue
          for (const shot of row.shots) {
            if (isFields(shot) && typeof shot.id === 'string' && (shot_id ? shot.id === shot_id : shot.status !== 'aligned')) shotIds.push(shot.id)
          }
        }
        if (!shotIds.length) throw new HarnessError('选定范围内没有要处理的镜头。', 'JINGLIU_EMPTY_SCOPE')
        payload.shot_ids = shotIds
        estimateArgs.shot_ids = shotIds
        if (shot_id) payload.redo = true
      } else if (episode !== undefined) {
        payload.episodes = [episode]
      }
      if (force) payload.force = true
      if (state.has_script !== true) throw new HarnessError('请先导入解说剧剧本。', 'JINGLIU_INVALID_PROJECT')
      const call = [exec.agent.session.id, exec.callId]
      const quote = response(await session.request('/desktop-agent/tool', { method: 'POST', body: {
        name: 'cost_estimate', project_id: pid, args: estimateArgs, call_id: call.join(':') + ':quote',
      }, signal: exec.signal }))
      if (quote.ok !== true || quote.kind !== kind || typeof quote.estimate_fen !== 'number'
          || !Number.isSafeInteger(quote.estimate_fen) || quote.estimate_fen < 0) throw new HarnessError('无法取得此解说剧任务的报价。', 'JINGLIU_INVALID_QUOTE')
      const target = shot_id ? '镜头 ' + shot_id : episode ? '第 ' + episode + ' 集' : '全剧'
      const effect = action === 'produce' ? '出片和核对，自动重出按实际用量计费' : force || episode ? '重拆台词并替换已有分镜' : '为尚未拆解的集拆台词'
      await ask(target + ' · ' + effect + '\n预计 ¥' + (quote.estimate_fen / 100).toFixed(2) + '，按实际用量结算。')
      const body = { kind, payload }
      return submitOnce(dir, call, input,
        () => session.request('/jobs', { method: 'POST', body, signal: exec.signal }))
    },
  })
}
