/** Discover and invoke the current Jingliu desktop-agent workflow catalog. @module */
import type { Context } from '@deepseek-ai/cordis'
import { JingliuHttpError, projectMediaFolder, type JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { catalog, isFields, lookup, workflowArgs } from './catalog.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SelectedProject } from '@deepseek-ai/dsh-jingliu-connection/types'
import { installDraft } from './delivery.ts'
import { draftDirectory } from '@deepseek-ai/dsh-drama-settings'
import { studioTool } from './studio.ts'
import { reviewedShots } from './shots.ts'
import { imageTool, projectsTool } from './production.ts'
import { narrationTool } from './narration.ts'
import { mediaTool } from './media.ts'

/** Cordis plugin name. */
export const name = 'tool-jingliu'
/** Required Host services. */
export const inject = ['tools', 'jingliuConnection']

type Fields = Record<string, JsonValue>

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: Fields) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/** Authenticated transport and human confirmation for Jingliu tools. */
export interface Dependencies {
  connect(): Promise<JingliuSession>
  draftRoot?(): Promise<string>
  selected?(session: SessionId, owner: string): Promise<SelectedProject | null>
  select?(session: SessionId, project: string, signal: AbortSignal): Promise<SelectedProject>
  approve(exec: ToolRunContext, reason: string): Promise<boolean>
}

/**
 * Provide live catalog discovery and workflow submission for a Muse conversation.
 * @param deps - authenticated connection and one-time human approval channel.
 * @returns the workflow tools, without account credentials in their arguments or results.
 */
export function workflowTools(deps: Dependencies): ToolDefinition[] {
  return [defineTool({
    name: 'jingliu_workflows',
    description: '查找镜流影视制作工作流，包括项目、剧本、拆镜、素材、生成、任务进度、后期和剪映交付。按名称查询可取得完整调用参数。',
    parameters: {
      query: { type: 'string', description: '按名称或说明搜索。省略时列出目录。' },
      name: { type: 'string', description: '精确的工作流名称，用于查看参数。' },
      offset: { type: 'integer', description: '下一页起点，来自 next_offset。' },
    },
    output, isConcurrencySafe: () => true,
    async execute({ query, name: exactName, offset = 0 }, exec): Promise<Fields> {
      if (offset < 0) throw new HarnessError('offset 必须大于等于 0。', 'JINGLIU_INVALID_ARGUMENTS')
      const entries = await catalog(await deps.connect(), exec.signal)
      if (exactName !== undefined) return { ...lookup(entries, exactName) }
      const search = query?.trim().toLowerCase()
      const matches = search ? entries.filter(entry => (entry.name + ' ' + entry.description).toLowerCase().includes(search)) : entries
      const page = matches.slice(offset, offset + 24)
      return { total: matches.length, workflows: page.map(entry => ({
        name: entry.name, description: entry.description.slice(0, 150), risk: entry.risk, costs: entry.costs,
        scope: entry.account_scoped ? 'account' : 'project',
      })), ...(offset + page.length < matches.length ? { next_offset: offset + page.length } : {}) }
    },
  }), defineTool({
    name: 'jingliu_run',
    description: '执行镜流目录中的工作流并返回镜流结果。异步任务用返回的 job_id 查进度。提交结果未知时先查原任务。',
    parameters: {
      workflow: { type: 'string', required: true, description: 'jingliu_workflows 中的精确名称。' },
      project_id: { type: 'string', description: '项目级工作流必填，账号级省略。' },
      args: { type: 'object', additionalProperties: true, description: '按该工作流的 parameters 填写。' },
    },
    output,
    async execute({ workflow: workflowName, project_id, args = {} }, exec): Promise<Fields> {
      if (!exec.agent) throw new HarnessError('请在 Muse 会话中调用镜流。', 'JINGLIU_SESSION_REQUIRED')
      const session = await deps.connect()
      const workflow = lookup(await catalog(session, exec.signal), workflowName)
      const selected = await deps.selected?.(exec.agent.session.id, session.identity)
      const project = project_id?.trim() || (workflow.account_scoped ? '' : selected?.id ?? '')
      if (!workflow.account_scoped && selected && selected.id !== project) throw new HarnessError('这个工作流指向另一个云项目，请先确认要切换的项目。', 'JINGLIU_INVALID_PROJECT')
      const businessArgs = workflowArgs(workflow, project, args)
      let destination: string | undefined
      if (workflow.name === 'export_jianying' && deps.draftRoot) {
        destination = await deps.draftRoot()
        if (!destination) throw new HarnessError('请先在 Muse 的短剧设置指定剪映草稿根目录，或使用 drama_draft_dir 设置。', 'JINGLIU_DRAFT_ROOT_REQUIRED')
        businessArgs.single_file = false
      }
      const review = workflow.name === 'run_shot_videos' ? await reviewedShots(session, project, businessArgs, exec.signal) : undefined
      if (review) { businessArgs.shot_ids = review.ids; delete businessArgs.episode }
      const operation = { name: workflow.name, project_id: project, args: businessArgs }
      const subject = '镜流 · ' + workflow.name + (project ? ' · 项目 ' + project : ' · 当前账号')
      const ask = async (reason: string): Promise<void> => {
        if (!await deps.approve(exec, subject + '\n' + reason)) {
          throw new HarnessError('本次镜流操作未获确认。', 'JINGLIU_APPROVAL_REQUIRED')
        }
        exec.signal.throwIfAborted()
      }
      if (workflow.costs || workflow.risk === 'generate') {
        const quote = await session.request('/desktop-agent/quote', { method: 'POST', body: operation, signal: exec.signal })
        if (!isFields(quote) || quote.tool !== workflow.name || typeof quote.estimate_fen !== 'number'
            || !Number.isSafeInteger(quote.estimate_fen) || quote.estimate_fen < 0 || typeof quote.note !== 'string') {
          throw new HarnessError('未取得此工作流的有效报价。', 'JINGLIU_INVALID_QUOTE')
        }
        const price = quote.estimate_fen > 0 ? '预计 ¥' + (quote.estimate_fen / 100).toFixed(2) : '费用以实际结算为准'
        await ask(workflow.description + '\n' + price + (quote.note ? ' · ' + quote.note : '') + (review ? '\n' + review.prompts.join('\n\n') : ''))
      } else if (workflow.risk !== 'read' || workflow.needs_confirm) {
        await ask(workflow.description)
      }
      if (destination) await ask('将可编辑的镜头、音轨和字幕导入剪映草稿目录 ' + destination)
      const callId = exec.agent.session.id + ':' + exec.callId
      const submit = async (confirmed: boolean): Promise<unknown> => {
        if (review) {
          const fresh = await reviewedShots(session, project, businessArgs, exec.signal)
          if (fresh.prompts.length !== review.prompts.length || fresh.prompts.some((prompt, index) => prompt !== review.prompts[index])) throw new HarnessError('审校稿在确认后发生变更，请重新核对镜头。', 'JINGLIU_SHOT_CHANGED')
        }
        return session.request('/desktop-agent/tool', {
          method: 'POST', body: { ...operation, call_id: callId, confirmed }, signal: exec.signal,
        })
      }
      let result: unknown
      try {
        result = await submit(false)
      } catch (error) {
        if (!(error instanceof JingliuHttpError && error.status === 409 && error.code === 'needs_confirm')) throw error
        await ask(error.message)
        result = await submit(true)
      }
      if (!isFields(result)) throw new HarnessError('镜流返回了无法识别的执行结果。请核对原任务。', 'JINGLIU_INVALID_RESULT')
      if (result.ok === false) {
        const message = typeof result.error === 'string' ? result.error : result.message
        throw new HarnessError(typeof message === 'string' ? message : '镜流未完成本次工作流。', 'JINGLIU_WORKFLOW_REJECTED')
      }
      if (destination) {
        // Drafts of one production share its media folder, so a shot used by several episodes downloads once.
        const workspace = exec.agent.session.header.cwd
        const folder = workspace && project ? projectMediaFolder(workspace, project) : undefined
        const draft = await installDraft(session, result, destination, callId, exec.signal, folder)
        return { workflow: workflow.name, project_id: project, draft }
      }
      return { workflow: workflow.name, project_id: project, result }
    },
    presentCall: args => ({ card: 'generic', title: '镜流 · ' + args.workflow, kind: 'other', rawInput: args }),
  }), narrationTool(deps), projectsTool(deps), imageTool(deps), studioTool(deps), mediaTool(deps)]
}

/**
 * Register the catalog and workflow tools in the current scope.
 * @param ctx - Cordis context providing the authenticated connection and tool registry.
 */
export function apply(ctx: Context): void {
  const tools = workflowTools({
    connect: () => ctx.jingliuConnection.connection(),
    selected: (sid, owner) => ctx.jingliuConnection.selected(sid, owner),
    select: (sid, project, signal) => ctx.jingliuConnection.selectProject(sid, project, signal),
    draftRoot: async () => (await draftDirectory(ctx.settings)).path,
    approve: async (exec, reason) => {
      const approval = ctx.get('approval')
      return !!approval && !!exec.agent && await approval.request({
        agent: exec.agent, callId: exec.callId, toolName: exec.name, reason, signal: exec.signal,
      }) === 'allowed-once'
    },
  })
  for (const definition of tools) ctx.effect(() => ctx.tools.register(definition))
}
