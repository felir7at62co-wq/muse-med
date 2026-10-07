/** Source-backed screenplay project tool for bounded writing and independent review. @module @deepseek-ai/dsh-screenplay-project */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId } from './ids.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ProjectCommands } from './project.ts'
import { REQUEST, IMAGE_REFERENCE } from './schema.ts'
import type { ProjectLimits } from './project.ts'

/** Loader diagnostics name. */
export const name = 'screenplay-project'
/** Filesystem and logged tool registry required by this plugin. */
export const inject = ['fs', 'tools', 'attachments', 'llm']

/** Source allocation, durable project size, and bounded source-read budgets. */
export interface Config extends ProjectLimits {}

/** Validate deployment-varying budgets before mounting the tool. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  maxSourceBytes: Schema.number().step(1).min(1).default(16 * 1024 * 1024),
  maxProjectBytes: Schema.number().step(1).min(1).default(32 * 1024 * 1024),
  maxReadUnits: Schema.number().step(1).min(1).default(100),
  maxReadBytes: Schema.number().step(1).min(1).default(64 * 1024),
  maxFactBatch: Schema.number().step(1).min(1).default(20),
})

/**
 * Mount the source and episode command provider behind one model-facing tool.
 * @param ctx - Host tool registry and filesystem provider.
 * @param config - Resolved allocation and read budgets.
 */
export function apply(ctx: Context, config: Config): void {
  if (ctx.fs.sandboxMode !== undefined && ctx.get('sandboxPolicy') === undefined) {
    throw Error('screenplay-project: sandboxed filesystem requires sandboxPolicy')
  }
  const commands = new ProjectCommands(ctx.fs, config, ctx.attachments)
  ctx.tools.register(defineTool({
    name: 'screenplay_project',
    description: '小说、视频、换梗剧本的来源与逐集验收工具。init 记录用户方向；import_source 导入原文、segments 转写或 video_inspect 实际生成的 video_inspection 帧清单；'
      + 'read_source 返回程序生成的片段编号与原文。propose_fact 区分动作、发声、角色心理、作者分析；review_fact 须由另一会话核对归属。'
      + `propose_facts/review_facts 可原子批量处理最多 ${config.maxFactBatch} 条事实，每条独立归属与审校理由必须保留，任一失败整批不写入。read_source/list_facts 每次最多 ${config.maxReadUnits} 条，编号从 1 开始。`
      + `list_facts 从 1 起始分页恢复事实，read_fact/read_candidate 读取审校所需的事实或完整候选。stage 提交结构化场次；stage_files 按文件顺序组稿，每个 JSON 文件含一个完整场次，单文件最多 ${config.maxReadBytes} 字节、最多 ${config.maxReadUnits} 个文件，避免一次生成长 JSON；正文引用已批准事实。review 独立核对，commit 推进下一集。`
      + 'status 是中断恢复依据，export 只导出已验收正文。所有修改携带当前 expected_revision；编号、时间、摘要和引用行号由程序生成。'
      + '已验收稿需修改时用 fork_project，从 before_episode 集之前复制已验收状态到新的 destination 项目；原稿与原项目保留，修订仍须独立验收。'
      + 'OS 仅对应本人的心理，作者分析不能变成 OS。witnesses 仅填实际听见对白或看见动作的人；OS/VO 无场内见证者。'
      + 'requires_knowledge 填本人物须先获知的事实编号；未知身份使用声音编号，不猜角色。机械通过不等于语义通过，独立审校仍须读取来源和完整候选正文。',
    parameters: { request: { ...REQUEST, required: true } },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        if (args.request.method === 'read_source') {
          const window = z.object({ units: z.array(z.object({ image: IMAGE_REFERENCE.optional() })) }).parse(value)
          for (const unit of window.units) if (unit.image !== undefined) content.push({ type: 'image', attachment: unit.image })
        }
        return content
      },
      presentationMeta: args => ({ method: args.request.method, project: args.request.project }),
    },
    isConcurrencySafe: args => ['status', 'read_source', 'read_fact', 'list_facts', 'read_candidate'].includes(args.request.method),
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw Error('screenplay_project requires an initiating agent session')
      const policy = ctx.get('sandboxPolicy')?.resolve({ session: exec.agent.session })
      const result = await commands.execute(args.request, { actor: brandString<ActorId>(exec.agent.session.id),
        ...(exec.agent.session.header.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
        signal: exec.signal, ...(policy === undefined ? {} : { policy }) })
      if (args.request.method === 'read_source' && z.object({ units: z.array(z.object({ image: IMAGE_REFERENCE.optional() })) }).parse(result).units.some(unit => unit.image !== undefined)) {
        const request = exec.agent.session.requestHeader()?.config
        const provider = request?.provider ?? exec.agent.options.provider, model = request?.model ?? exec.agent.options.model
        if (provider === undefined || model === undefined) throw Error('image_route: 查看帧需明确支持图像的模型。')
        const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
        if (!info.inputModalities?.includes('image')) throw Error('image_route: 当前模型不支持图像，不能声称已查看画面。')
      }
      return z.json().parse(JSON.parse(JSON.stringify(result)))
    },
  }))
}
