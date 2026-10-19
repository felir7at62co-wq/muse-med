/** Source-backed screenplay projects with deployment-selected review guidance. @module @deepseek-ai/dsh-screenplay-project */

import { resolveTrustedVideoEvidence } from '@deepseek-ai/dsh-tool-video-inspect'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ActorId } from './ids.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, isAgentLoopRequest, type ContentBlock, type UserMessage, type MessageId, type Message } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectReadReceipt } from './review.ts'
import { sha256 } from './episode.ts'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { ProjectCommands } from './project.ts'
import { REQUEST, REQUEST_REFINEMENT, REQUEST_STORY, IMAGE_REFERENCE } from './schema.ts'
import type { ProjectLimits } from './project.ts'
import type { HumanAuthorization } from './refinement.ts'
import { captureRefinementAuthorization, refinementUserProjection } from './refinement-auth.ts'

export { acceptedScripts, sha256 } from './episode.ts'
import { storyReviewResultReceipt, validateStoryApprovalLog } from './story.ts'
export { validateAcceptedStoryEvidence, validateStoryApprovalLog } from './story.ts'
export { PROJECT_FILE } from './schema.ts'

/** Match exact read text and attachments; only observed history may carry logged offload flags. */
function matchesReadContext(message: Message, hash: string, observed: boolean): boolean {
  if (sha256(JSON.stringify(message)) === hash) return true
  if (!observed) return false
  const content = message.content.map((block) => {
    if (block.type !== 'image' || block.offloaded !== true) return block
    const { offloaded: _offloaded, ...original } = block
    return original
  })
  return sha256(JSON.stringify({ ...message, content })) === hash
}

/** Loader diagnostics name. */
export const name = 'screenplay-project'
/** Filesystem and logged tool registry required by this plugin. */
export const inject = ['fs', 'tools', 'attachments', 'llm']

/** Source allocation, durable project size, and bounded source-read budgets. */
export interface Config extends ProjectLimits {
  /** Agent-selected review guidance, or explicit independent/sequential review requirements. */
  reviewMode: 'independent' | 'self-check' | 'advisory'
  /** Creation-only source-preserving refinement fork; disabled keeps the historical tool schema. */
  refinementMode: 'disabled' | 'source-preserving-v1'
  /** Story-faithful video creation with current work grants and located semantic reports. */
  storyFaithfulMode: 'disabled' | 'story-faithful-v2'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Exact source-backed read context forwarded for a subsequent self-check model step.
     * @persistenceAttribution
     */
    'screenplay-project-read': { kind: 'screenplay-project-read' }
  }
}

/** Validate deployment-varying budgets before mounting the tool. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  reviewMode: Schema.union(['independent', 'self-check', 'advisory']).default('independent'),
  refinementMode: Schema.union(['disabled', 'source-preserving-v1']).default('disabled'),
  storyFaithfulMode: Schema.union(['disabled', 'story-faithful-v2']).default('disabled'),
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
  if (config.storyFaithfulMode !== 'disabled' && config.reviewMode === 'independent') throw Error('screenplay-project: story-faithful-v2 requires self-check or advisory reviewMode')
  if (ctx.fs.sandboxMode !== undefined && ctx.get('sandboxPolicy') === undefined) {
    throw Error('screenplay-project: sandboxed filesystem requires sandboxPolicy')
  }
  const projections = ctx.get('sessionProjections')
  if ((config.reviewMode === 'self-check' || (config.refinementMode !== 'disabled' || config.storyFaithfulMode !== 'disabled')) && projections === undefined) {
    throw Error('screenplay-project: self-check requires live sessionProjections')
  }
  if ((config.refinementMode !== 'disabled' || config.storyFaithfulMode !== 'disabled')) {
    ctx.inject(['sessionProjections'], (scope) => { scope.sessionProjections.register(refinementUserProjection) })
  }
  const commands = new ProjectCommands(ctx.fs, config, ctx.attachments, config.reviewMode, config.refinementMode, config.storyFaithfulMode)
  const pending = new WeakMap<ToolExecution, { context: UserMessage; receipt: ProjectReadReceipt; valueHash: string; contentHash: string; root: ToolExecution['rootCallId'] }>()
  const delivered = new Map<MessageId, { contextHash: string; receipt: ProjectReadReceipt; root: ToolExecution['rootCallId']; observed: boolean }>()
  ctx.effect(() => () => { delivered.clear() })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, read] of delivered) if (read.receipt.actor === brandString<ActorId>(agent.session.id)) delivered.delete(id)
  })
  ctx.on('tools/result', (exec, result) => {
    const read = pending.get(exec)
    pending.delete(exec)
    if (read !== undefined && !result.isError && sha256(JSON.stringify(result.value)) === read.valueHash
      && sha256(JSON.stringify(result.content)) === read.contentHash
      && result.additionalContexts?.some(context => context.id === read.context.id
        && JSON.stringify(context) === JSON.stringify(read.context))) {
      for (const [id, prior] of delivered) {
        if (prior.receipt.actor === read.receipt.actor && prior.receipt.project_id === read.receipt.project_id
          && (prior.receipt.project_sha256 !== read.receipt.project_sha256
            || (prior.receipt.step === read.receipt.step && prior.root === read.root
              && JSON.stringify(prior.receipt.reads) === JSON.stringify(read.receipt.reads)))) delivered.delete(id)
      }
      delivered.set(read.context.id, { contextHash: sha256(JSON.stringify(read.context)), receipt: read.receipt,
        root: read.root, observed: false })
    }
  })
  ctx.on('llm/stream', async function* (options, next) {
    const roots = new Set(options.messages.flatMap(message => message.role === 'tool' && message.isError !== true
      ? [message.toolCallId] : []))
    const eligible = !isAgentLoopRequest(options) ? [] : options.messages.flatMap((message) => {
      const read = message.id === undefined ? undefined : delivered.get(message.id)
      return read !== undefined && options.sessionId !== undefined
        && read.receipt.actor === brandString<ActorId>(options.sessionId) && roots.has(read.root)
        && message.source?.kind === 'screenplay-project-read' && sha256(JSON.stringify(message)) === read.contextHash ? [read] : []
    })
    let complete = false
    for await (const chunk of next()) {
      if (chunk.type === 'finish') complete = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind)
      yield chunk
    }
    if (complete && !options.signal?.aborted) for (const read of eligible) read.observed = true
  })
  ctx.tools.register(defineTool({
    name: 'screenplay_project',
    description: config.reviewMode === 'advisory'
      ? '小说、视频、换梗剧本的来源、版本与交付记录工具。当前为自主审校模式：新旧项目都由你根据任务决定是否自检、何时复核或委托子代理；不强制独立会话、固定分轮或先批准再起草和交付。'
        + 'init 记录方向，import_source 导入原文、转写或实际 video_inspect 帧清单；read_source/read_fact/list_facts/read_candidate 供实际核对。propose_fact/propose_facts 记录有来源或真实改编授权的事实；review_fact/review_facts/review 可记录你实际作出的决定与理由，同一会话可审校，不得把自主判断称为独立审校。'
        + 'stage/stage_files 保存候选，commit 由你决定采用哪个当前版本，export 导出采用的正文；采用不等于已独立审校。工具返回的审校建议供判断，不要求逐项放行。status 恢复项目和当前修订，所有修改携带当前 expected_revision，保留真实作者、审校者、来源与历史记录。'
        + '来源编号原样使用 status.sources[].id；事实状态读取 fact.review?.decision，缺失表示未记录审校，不能声称已批准。文件、版本、引用与用户实际授权仍须有效，不能伪造来源或扩大改编许可；用户已编辑内容的保护保持有效。'
        + (config.storyFaithfulMode === 'disabled' ? '' : 'init_story_faithful 绑定真实用户作品请求、原视频及集号；故事清单、定位与语义报告供创作核对，不强制审校者身份或A/B/C轮。')
        + (config.refinementMode === 'disabled' ? '' : 'fork_refinement 保留真实基线和用户原话授权；新增演绎保留来源归属与实际修改说明，重大事件和关系变化仍须明确授权。')
      : '小说、视频、换梗剧本的来源与逐集验收工具。init 记录用户方向；import_source 导入原文、segments 转写或 video_inspect 实际生成的 video_inspection 帧清单；'
      + 'read_source 返回程序生成的片段编号与原文。propose_fact 区分动作、发声、角色心理、作者分析；review_fact 须由另一会话核对归属。'
      + `propose_facts/review_facts 可原子批量处理最多 ${config.maxFactBatch} 条事实，每条独立归属与审校理由必须保留，任一失败整批不写入。read_source/list_facts 每次最多 ${config.maxReadUnits} 条，编号从 1 开始。`
      + `list_facts 从 1 起始恢复事实，按 ${config.maxReadBytes} 字节返回完整事实的前缀，用实际 next 继续直到 null，不以请求 count 推定已读完。read_fact/read_candidate 读取事实或完整候选。stage 提交结构化场次；stage_files 按文件顺序组稿，每个 JSON 文件含一个完整场次，单文件最多 ${config.maxReadBytes} 字节、最多 ${config.maxReadUnits} 个文件，避免一次生成长 JSON；正文引用已批准事实。review 独立核对，commit 推进下一集。`
      + 'status 是中断恢复依据，export 只导出已验收正文。所有修改携带当前 expected_revision；编号、时间、摘要和引用行号由程序生成。'
      + '来源编号原样使用 status.sources[].id，含 :text/:transcript/:video_inspection 类型后缀；按 kind/path 选择，不用正则截取或摘要旧值。read_source.units[] 的编号/原文是 id/text，事实审校状态是 fact.review?.decision，缺失 review 表示未审。'
      + '视频转剧本 init 必须指定 workflow=video_to_screenplay；先导入并实际查看本集帧，分类、独立审校事实，再 stage/stage_files。coverage.windows 填本集完整来源范围，required_beats 保留范围内已批准事实的动作、对白、OS/VO类型；关键事件、无对白行动和人物反应不能遗漏。零动作候选 approve 时须提供 zero_action_reason，记录实际复看依据，不能为通过检查虚构动作或旁白。'
      + '已验收稿需修改时用 fork_project，从 before_episode 集之前复制已验收状态到新的 destination 项目；原稿与原项目保留，修订仍须独立验收。'
      + '批准事实有误时用 withdraw_fact 独立撤销，保留原审批但禁止再用于正文。已有候选引用时先 fork_project 到最早受影响集之前；更正事实须重新提出和独立审校，不覆盖原版本。'
      + 'OS 仅对应本人的心理，作者分析不能变成 OS。characters/actor/witnesses 保留纯人物名，characters 包含本场所有参与人物；仅以 VO 发声的人物也须列入 characters，再列入 voice_only_characters，程序在人物行标注（VO）。witnesses 仅填实际听见发声或看见动作的人。OS 无见证者；电话或播放语音等 VO 仅在 audible_in_scene=true 且引用已批准发声事实时可声明听者，未声明的 VO 仅观众可闻。'
      + 'requires_knowledge 填本人物须先获知的事实编号；未知身份使用声音编号，不猜角色。机械通过不等于语义通过，独立审校仍须读取来源和完整候选正文。'
      + (config.reviewMode === 'self-check' ? '当前为创作自检部署：新 init 项目使用 self-check，前述独立验收规则仅适用于旧独立项目；withdraw_fact 仅对本模式自检批准的事实允许原会话在批准后的重读轮与下一模型轮自检撤销，保留原批准记录；旧独立审批仍须独立撤销。自检必须由原会话完成：编写轮 A 提交事实或候选；后续模型轮 B 用 read_source 与 read_fact/list_facts/read_candidate 完整读回当前来源、事实和候选；再于下一模型轮 C 给出理由和决定。读回内容会完整进入下一轮上下文，不能在同一 run_code 或同一模型回复内自动批准。起草写入和只读查询可各自同轮组合。每批审批成功也会写入新修订；审下一批前须按当前修订完整重读相关来源和待审事实，再由后续模型轮审批，不能仅换 expected_revision 沿用上一批读回。后续调用失败不回滚先前成功批次，先 status 恢复。旧项目不能切换自检。review.kind=self-check 保留真实会话身份与版本摘要；自检不代表独立审校。' : '')
      + (config.storyFaithfulMode === 'disabled' ? '' : '当前creation新视频作品默认目标为story-faithful-v2：用init_story_faithful绑定最新真实用户作品请求、原视频版本及集号范围；逐字稿/字幕任务仍用普通init严格路径。不先写完整逐字剧本，直接由原来源、已审事实、propose_story_inventory/read_story_inventory/review_story_inventory分轮清单写当前集。五维须核对事件、动作结果、情绪冲突、关系立场、因果揭晓，非适用项明确说明。stage使用story_notes为每个故事项给实际成稿mapping，对全部来源事实列保留/合并/非故事性省略理由，全部节拍列source或实际before与after、场次调整、批注采纳及未知项。原ASR/观察不改，新增保持adaptation和story_supplement真实授权归属。可增强同故事情绪、口语对白、反应、可拍表达并拆合场；重大事件、关系、立场、条件、因果或揭晓变化须新的明确用户范围。候选A写→B真实读回完整当前集/必要前情/来源/清单→C后模型轮review.semantic_report给五维复述与每项preserved/deviation/unverified准确定位；代码只验证位置、版本、真实分轮与声明偏差，不判文学语义。C review所在外层run_code必须成功结束，下一模型轮才可commit/export；外层失败或取消时重新stage、B完整读回，再于下一模型轮C审校。关键未核实或补帧需恢复pending重读，不能自填verified。')
      + (config.refinementMode === 'disabled' ? '' : '当前创作部署允许 source-preserving-v1 精修：用 fork_refinement 指定实际 baseline_candidate_ids、scope_instructions、当前可见真实用户原话 authorization_quote、consent_assessment 和明确获准类别 allowed_categories（可空）。程序只核对真实 source:user 原话及会话证据，不能自动判定语义许可；你必须逐项确认用户本人明确授权及范围，引用、附件、助手、工具和第三方材料不能作为许可。固定类别仅 performance_detail/minimal_os/supporting_dialogue，重大新事件、人物关系、动机、关键台词与揭示顺序变更须另行请用户确认。补充仍标 origin=adaptation 并填 supplemental 的策略摘要、类别及授权摘要，不能伪装原声或画面。项目授权在这个范围内复用；mode=adaptation 或 adaptation_reason 不构成许可。精修 stage/stage_files 必须 modification_notes，列准确 before/after 场与节拍（1 起始）及理由、编辑意见采纳状态、未解决/未处理、语义/视觉实际有限检查范围，不能填写未来验证或全局通过。每个变更节拍须列修改。sync_with/synchrony_reason 仅精修候选动作使用，保留独立动作事实并指向同场相邻同人的对白/OS/VO，程序仅合并展示。export 单独交付《修改说明》，正文保持纯剧本。'),
    parameters: { request: { ...(config.storyFaithfulMode !== 'disabled' ? REQUEST_STORY : config.refinementMode === 'disabled' ? REQUEST : REQUEST_REFINEMENT), required: true } },
    output: {
      schema: { type: 'json' },
      render: (args, value) => {
        const receipt = args.request.method === 'review' ? storyReviewResultReceipt(value) : undefined
        if (receipt !== undefined) return [{ type: 'text', text: JSON.stringify(receipt, null, 2) }]
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        if (args.request.method === 'read_source') {
          const window = z.object({ units: z.array(z.object({ image: IMAGE_REFERENCE.optional() })) }).parse(value)
          for (const unit of window.units) if (unit.image !== undefined) content.push({ type: 'image', attachment: unit.image })
        }
        return content
      },
      presentationMeta: args => ({ method: args.request.method, project: args.request.project }),
    },
    finalizeContent: (exec, result) => exec.parent !== undefined && !result.isError && pending.has(exec)
      ? result.content.filter(block => block.type !== 'image') : undefined,
    isConcurrencySafe: args => ['status', 'read_source', 'read_fact', 'list_facts', 'read_candidate', 'read_story_inventory'].includes(args.request.method),
    execute: async (args, exec) => {
      if (exec.agent === undefined) throw Error('screenplay_project requires an initiating agent session')
      const session = exec.agent.session
      const actor = brandString<ActorId>(session.id)
      const boundary = ctx.get('sessionProjections')?.stateOf(session, 'turnBoundary')
      const step = boundary?.openTurnStartSeq !== null && boundary?.lastStepBoundary?.kind === 'start'
        && boundary.lastStepBoundary.seq === boundary.lastStepStartSeq ? boundary.lastStepStartSeq : undefined
      const messages = config.reviewMode === 'self-check' || (config.refinementMode !== 'disabled' || config.storyFaithfulMode !== 'disabled') ? session.deriveMessages() : []
      const visible = new Map(messages.map(message => [message.id, message]))
      const roots = new Set(messages.flatMap(message => message.role === 'tool' && message.isError !== true
        ? [message.toolCallId] : []))
      const retained = new Map<string, MessageId>()
      for (const [id, read] of delivered) {
        if (read.receipt.actor !== actor || step === undefined || read.receipt.step >= step) continue
        const message = visible.get(id)
        if (message === undefined || !roots.has(read.root) || !matchesReadContext(message, read.contextHash, read.observed)) {
          delivered.delete(id); continue
        }
        const key = JSON.stringify([read.receipt.project_id, read.receipt.project_sha256, read.receipt.reads])
        const prior = retained.get(key)
        if (prior !== undefined) delivered.delete(prior)
        retained.set(key, id)
      }
      const receipts: ProjectReadReceipt[] = []
      for (const message of messages) {
        const read = delivered.get(message.id)
        if (read !== undefined && roots.has(read.root) && message.source.kind === 'screenplay-project-read'
          && matchesReadContext(message, read.contextHash, read.observed)) receipts.push(read.receipt)
      }
      let observation: ProjectReadReceipt | undefined
      const policy = ctx.get('sandboxPolicy')?.resolve({ session })
      let authorization: HumanAuthorization | undefined
      let latestUserSeq
      if (args.request.method === 'fork_refinement' || (args.request.method === 'init_story_faithful' || args.request.method === 'fork_story_faithful')) {
        const request = args.request
        if (!args.request.authorization_quote.trim()) throw Error('refinement_human_authorization: 请引用真实用户的明确授权。')
        const users = projections?.stateOf(session, 'screenplayRefinementUsers')
        if (users === undefined) throw Error('refinement_human_authorization: 真实用户消息投影尚未就绪。')
        authorization = captureRefinementAuthorization(users, messages, actor, request.authorization_quote, request.consent_assessment)
        latestUserSeq = users.users.at(-1)?.seq
        if ((args.request.method === 'init_story_faithful' || args.request.method === 'fork_story_faithful') && authorization.seq !== latestUserSeq) throw Error('story_human_authorization: 新作品必须引用最新真实用户请求，不能复用研发或历史作品授权。')
      }
      const result = await commands.execute(args.request, { actor,
        ...(authorization === undefined ? {} : { authorization }),
        ...(latestUserSeq === undefined ? {} : { latestUserSeq }),
        ...(step === undefined ? {} : { step }), receipts,
        observeRead: (receipt) => { observation = receipt },
        ...(exec.agent.session.header.cwd === undefined ? {} : { cwd: exec.agent.session.header.cwd }),
        signal: exec.signal, verifyStoryApproval: (project, candidate) => validateStoryApprovalLog(ctx, project, candidate,
          exec.signal), verifyStoryVideo: (input, persistedReceipt) => resolveTrustedVideoEvidence(ctx, session, input,
          exec.signal, persistedReceipt), ...(policy === undefined ? {} : { policy }) })
      if (args.request.method === 'read_source' && z.object({ units: z.array(z.object({ image: IMAGE_REFERENCE.optional() })) }).parse(result).units.some(unit => unit.image !== undefined)) {
        const request = exec.agent.session.requestHeader()?.config
        const provider = request?.provider ?? exec.agent.options.provider, model = request?.model ?? exec.agent.options.model
        if (provider === undefined || model === undefined) throw Error('image_route: 查看帧需明确支持图像的模型。')
        const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
        if (!info.inputModalities?.includes('image')) throw Error('image_route: 当前模型不支持图像，不能声称已查看画面。')
      }
      const value = z.json().parse(JSON.parse(JSON.stringify(result)))
      if (observation !== undefined) {
        const content: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        if (args.request.method === 'read_source') {
          const window = z.object({ units: z.array(z.object({ image: IMAGE_REFERENCE.optional() })) }).parse(value)
          for (const unit of window.units) if (unit.image !== undefined) content.push({ type: 'image', attachment: unit.image })
        }
        const context = createUserMessage({ source: { kind: 'screenplay-project-read' }, content })
        pending.set(exec, { context, receipt: observation, valueHash: sha256(JSON.stringify(value)),
          contentHash: sha256(JSON.stringify(exec.parent === undefined ? content : content.filter(block => block.type !== 'image'))), root: exec.rootCallId })
        exec.deferContext(context)
      }
      return value
    },
  }))
}
