/** Muse-owned local packaging, candidate review and free batch publication. */
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { JUBIAN_TOKEN_REF, JubianLedger, configuredJubianClient } from '@deepseek-ai/dsh-jubian'
import { readScript, resolveVideoModel, stableSha256, storyboardMaterials } from '@deepseek-ai/dsh-jubian-api'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { buildProductionPlan, productionHash, requirementKey } from './production-plan.ts'
import { productionMetadata } from './production-metadata.ts'
import { reviewPresentationMeta } from './session-video.ts'
import { parseShotScript } from './script.ts'
import type { ProductionChoice, ProductionPlan, ProductionRequirement } from './production-types.ts'

/** Deployment limits and the same account ledger root used by the native Jubian tools. */
export interface ProductionConfig {
  /** Jubian origin override; omitted uses the native transport default. */
  baseUrl?: string
  /** Native transport timeout in milliseconds. */
  timeoutMs?: number
  /** Permit the native workspace credential fallback; defaults to true. */
  workspaceSecrets?: boolean
  /** Native storyboard ledger root; use the same location as tool-jubian when overridden. */
  ledgerRoot?: string
  /** Maximum rows acquired per provider page, 1–1000; defaults to 1000. */
  pageSize?: number
  /** Maximum pages per complete inventory; defaults to 100. */
  pageLimit?: number
  /** Ordinary candidate rows per requirement; defaults to 8, with full inventory available through read. */
  candidateLimit?: number
  /** Maximum authored source bytes per episode; defaults to 1 MiB. */
  maxSourceBytes?: number
  /** Maximum complete shots per episode; defaults to 1000. */
  maxShots?: number
  /** Maximum draft packages per episode; defaults to 1000. */
  maxPackages?: number
}

const configSchema = z.object({ baseUrl: z.url().optional(), timeoutMs: z.number().int().positive().optional(),
  workspaceSecrets: z.boolean().optional(), ledgerRoot: z.string().optional(),
  pageSize: z.number().int().min(1).max(1000).default(1000), pageLimit: z.number().int().min(1).default(100),
  candidateLimit: z.number().int().min(1).max(100).default(8),
  maxSourceBytes: z.number().int().min(1).default(1024 * 1024), maxShots: z.number().int().min(1).default(1000),
  maxPackages: z.number().int().min(1).default(1000) }).strict()
const kindSchema = z.enum(['character', 'scene', 'prop', 'voice'])
const requirementSchema = z.object({ shot: z.number().int().positive(), kind: kindSchema, name: z.string().min(1),
  state: z.string().optional(), conditions: z.array(z.string()).optional(), character_id: z.string().optional(),
  voice_period_id: z.string().optional() }).strict()
const choiceSchema = z.object({ shot: z.number().int().positive(), kind: kindSchema, name: z.string().min(1),
  asset_id: z.number().int().positive().nullable() }).strict()
const targetSchema = z.object({ index: z.number().int().positive(), storyboard_id: z.number().int().positive().nullable() }).strict()
const assetSchema = z.object({ asset_id: z.number().int().positive(), name: z.string(), kind: kindSchema,
  url: z.string().nullable(), material_id: z.string().nullable(), usable: z.boolean(), character_id: z.string().optional(),
  voice_period_id: z.string().optional(), duration_seconds: z.number().positive().optional(), aliases: z.array(z.string()).optional(),
  state_or_costume: z.string().optional(), scene_conditions: z.array(z.string()).optional(),
  audio_duration_basis: z.literal('project_reference_metadata').optional() })
const planSchema = z.object({ version: z.literal(1), operation: z.literal('muse_production'), project_dir: z.string(),
  script_id: z.number().int().positive(), script_name: z.string(), episode: z.number().int().positive(),
  episode_id: z.number().int().positive(), source_path: z.string(), source_sha256: z.string(), source: z.string(),
  requirements: z.array(requirementSchema), choices: z.array(choiceSchema), targets: z.array(targetSchema), assets: z.array(assetSchema),
  matches: z.array(requirementSchema.extend({
    candidates: z.array(assetSchema.extend({ reasons: z.array(z.string()), compatible: z.boolean() })),
    candidate_count: z.number(), candidates_truncated: z.boolean(), selected_asset_id: z.number().nullable(),
    selection_basis: z.enum(['explicit', 'unique_metadata', 'unresolved', 'omitted']), review_required: z.literal(true) })),
  packages: z.array(z.object({ index: z.number(), name: z.string(), shots: z.array(z.number()), duration: z.number(), prompt: z.string(),
    images: z.array(z.object({ asset_id: z.number(), material_key: z.string() })), voices: z.array(assetSchema),
    storyboard_id: z.number().nullable(), expected_snapshot_sha256: z.string().nullable(), current_assets: z.array(z.object({
      material_key: z.string(), name: z.string(), asset_id: z.number().nullable(), kind: z.string(), url: z.string().nullable() })),
    target_candidates: z.array(z.number()) })),
  warnings: z.array(z.object({ code: z.string(), shot: z.number().nullable(), name: z.string().optional(), message: z.string() })),
  model: z.object({ modelId: z.string(), platformId: z.string(), standardId: z.number(), modelGenerationTypeId: z.number(),
    videoStandardId: z.number(), genType: z.number(), ratio: z.string(), resolution: z.string(),
    maxDurationSeconds: z.number().nullable(), revision: z.number() }), fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) })

interface ProductionArgs {
  method: 'preview' | 'read' | 'update' | 'apply'
  project_dir?: string
  script?: string
  episode?: number
  ratio?: string
  gen_type?: number
  plan_path?: string
  requirements?: ProductionRequirement[]
  choices?: ProductionChoice[]
  targets?: { index: number; storyboard_id: number | null }[]
  section?: 'matches' | 'packages' | 'warnings' | 'assets'
  offset?: number
  limit?: number
}

async function loadPlan(path: string): Promise<ProductionPlan> {
  const bytes = await readFile(path, 'utf8')
  const plan = planSchema.parse(JSON.parse(bytes))
  const { fingerprint, ...body } = plan
  if (stableSha256(body) !== fingerprint) throw new Error('本地制作方案已被外部修改；用 update 重新生成可回读的方案。')
  const actual = await realpath(path), root = await realpath(join(plan.project_dir, '.muse', 'production'))
  if (dirname(actual) !== root || !relative(root, actual).endsWith(`${fingerprint}.json`)) throw new Error('制作方案路径与其项目或版本不一致。')
  return plan
}

function seal(plan: ProductionPlan): ProductionPlan {
  const { fingerprint: _fingerprint, ...body } = plan
  return { ...body, fingerprint: stableSha256(body) }
}

async function savePlan(plan: ProductionPlan): Promise<string> {
  const path = join(plan.project_dir, '.muse', 'production', `${plan.fingerprint}.json`)
  await writeFileAtomic(path, JSON.stringify(plan, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
  return path
}

function view(plan: ProductionPlan, path: string, args: ProductionArgs): Record<string, JsonValue> {
  const section = args.section ?? 'matches', offset = args.offset ?? 0, limit = args.limit ?? 20
  const all = plan[section], next = offset + limit < all.length ? offset + limit : null
  const missingVoices = plan.matches.filter(item => item.kind === 'voice' && item.selection_basis !== 'omitted'
    && (item.selected_asset_id === null || !plan.assets.find(asset => asset.asset_id === item.selected_asset_id)?.duration_seconds))
  return z.record(z.string(), z.json()).parse({ method: args.method, mode: 'advisory', plan_path: path, fingerprint: plan.fingerprint, paid_requests: 0,
    script_id: plan.script_id, episode: plan.episode, source_path: plan.source_path, source_sha256: plan.source_sha256,
    model: plan.model, summary: { packages: plan.packages.length, requirements: plan.matches.length,
      warnings: plan.warnings.length, unresolved: plan.matches.filter(item => item.selection_basis === 'unresolved').length },
    production_review: { script: plan.source_path, packages: plan.packages.map(item => ({ index: item.index,
      shots: item.shots, submit_seconds: item.duration })), revision: plan.model.revision, available: true },
    package_index: plan.packages.slice(0, limit).map(item => ({ index: item.index, name: item.name, shots: item.shots,
      duration: item.duration, storyboard_id: item.storyboard_id, target_candidates: item.target_candidates,
      current_assets: item.current_assets, proposed_image_ids: item.images.map(image => image.asset_id),
      proposed_voice_ids: item.voices.map(voice => voice.asset_id) })), package_index_truncated: plan.packages.length > limit,
    section, rows: all.slice(offset, offset + limit), total: all.length, next_offset: next,
    voice_follow_up: { missing: missingVoices.map(item => ({ shot: item.shot, name: item.name,
      character_id: item.character_id ?? null, voice_period_id: item.voice_period_id ?? null })),
    next: missingVoices.length ? '先查询同项目完整共享音频库。已有候选但缺时长或身份时，先下载测量、听音核对并保存当前人物时期的真实引用，不因此重新生成。已有制作与费用授权且没有可核实样本时，先生成该人物首次清晰讲话的包；实际核对说话人和区间后抽取短样本，上传并登记character_id与voice_period_id，再刷新候选。登记前再查共享库，优先复用协作者已建立的样本；换装沿用同人物同时期声线，不自动替换已认可默认。'
      : '声线候选仍须核对实际说话人、时期和音频；元数据匹配不等于听音验收。' },
    next: '候选和时长均为提示，不要求警告清零。实际看图／听音并对照逐镜剧情；用update按镜号选择或更正版本。read分页读取完整matches/packages/warnings；候选被截断时读assets完整库存。apply免费批量写卡并回读，不会生成；仅按原任务授权另行prepare_video。' })
}

/** Register the Muse batch tool beside the existing advisory compiler.
 * @param ctx - Scoped tool registry, credentials and session video-selection owner.
 * @param input - Deployment transport and inventory bounds.
 * @param actionShotSeconds - Existing compiler's silent-shot estimate.
 * @returns Resolves after the optional native provider and batch tool are registered.
 */
export async function registerProductionTool(ctx: Context, input: ProductionConfig, actionShotSeconds: number): Promise<void> {
  const config = configSchema.parse(input)
  const { productionRows, productionCard, publishProductionCard, readProductionLibrary } = await import('@deepseek-ai/dsh-tool-jubian')
  const credentials = ctx.get('credentials'), video = ctx.get('jubianVideoSelection')
  if (!credentials || !video) throw new Error('Muse批量制作需要凭证与当前会话视频模型服务。')
  const client = configuredJubianClient(async () => (await credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? '', {
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.workspaceSecrets === undefined ? {} : { workspaceSecrets: config.workspaceSecrets }),
  }, process.cwd())
  const ledger = new JubianLedger({ root: config.ledgerRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'jubian', 'ledger') })
  const preview = async (args: ProductionArgs, agent: Parameters<typeof video.current>[0], signal: AbortSignal,
    previous?: ProductionPlan): Promise<ProductionPlan> => {
    const root = resolve(agent.session.header.cwd ?? process.cwd(), args.project_dir ?? previous?.project_dir ?? '')
    const script = resolve(root, args.script ?? previous?.source_path ?? '')
    const episode = args.episode ?? previous?.episode
    if (!args.project_dir && !previous || !args.script && !previous || !episode) throw new Error('preview需要project_dir、script与真实集号episode。')
    const project = z.object({ jubian_script_id: z.number().int().positive() }).loose()
      .parse(JSON.parse(await readFile(join(root, 'project_config.json'), 'utf8')))
    const bytes = await readFile(script)
    if (bytes.byteLength > config.maxSourceBytes) throw new Error(`镜头脚本超过${config.maxSourceBytes}字节；按真实分集缩小范围，不截断原稿。`)
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (parseShotScript(source, { actionShotSeconds }).shots.length > config.maxShots) throw new Error('本集完整镜头数量超过部署上限；按真实分集缩小范围，不截断。')
    const selection = video.current(agent) ?? await video.initialize(agent)
    if (!selection) throw new Error('当前会话没有可用视频模型；先读取或选择本会话模型。')
    const ratio = args.ratio ?? previous?.model.ratio, genType = args.gen_type ?? previous?.model.genType
    if (!ratio || genType === undefined) throw new Error('preview需要本项目ratio与gen_type；沿用项目已确认画幅和生成类型。')
    const remote = readScript((await client.request({ method: 'GET', path: `/aigc/script/${project.jubian_script_id}` })).data)
    const episodes = await productionRows(client, project.jubian_script_id, 'episode', config.pageSize, config.pageLimit, signal)
    const targets = episodes.filter(item => Number(item.episodeCount) === episode)
    const episodeTarget = targets[0]
    if (targets.length !== 1 || episodeTarget === undefined) throw new Error('本集没有唯一远端episode_id；先查询真实分集，不能把集号当ID。')
    const models = (await client.request({ method: 'GET', path: '/model/charge/getSelectList?taskType=1' })).data
    const model = resolveVideoModel(models, { modelId: selection.modelId, platformId: selection.platformId,
      ratio, resolution: selection.resolution, genType, duration: 4, genNum: 1 })
    const { duration: _duration, genNum: _genNum, ...selectors } = model
    let assets = await readProductionLibrary(client, project.jubian_script_id, config.pageSize, config.pageLimit, signal)
    const decisions = new Map((previous?.choices ?? []).map(item => [requirementKey(item), item]))
    for (const choice of args.choices ?? []) decisions.set(requirementKey(choice), choice)
    const requirements = new Map((previous?.requirements ?? []).map(item => [requirementKey(item), item]))
    for (const item of args.requirements ?? []) requirements.set(requirementKey(item), item)
    const inputPlan = { project_dir: root, script_id: remote.script_id, script_name: remote.name ?? '',
      episode, episode_id: Number(episodeTarget.id), source_path: script, source_sha256: productionHash(bytes),
      source, requirements: [...requirements.values()], choices: [...decisions.values()],
      targets: args.targets ?? previous?.targets ?? [], assets,
      model: { ...selectors, maxDurationSeconds: selection.maxDurationSeconds, revision: selection.revision } }
    let plan = buildProductionPlan(inputPlan, config.candidateLimit, actionShotSeconds)
    let manifest: unknown
    try { manifest = JSON.parse(await readFile(join(root, 'assets_manifest.json'), 'utf8')) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const metadata = productionMetadata(assets, manifest, project, plan.matches.map(item => requirementSchema.strip().parse(item)))
    assets = metadata.assets
    const enriched = new Map([...requirements])
    for (const item of metadata.requirements.filter(item => item.kind === 'voice')) enriched.set(requirementKey(item), item)
    plan = buildProductionPlan({ ...inputPlan, assets, requirements: [...enriched.values()] }, config.candidateLimit, actionShotSeconds)
    plan.requirements = [...requirements.values()]
    if (plan.packages.length > config.maxPackages) throw new Error('制作范围超过部署的视频包上限；按分集缩小本次范围。')
    const boards = await productionRows(client, plan.script_id, 'storyboard', config.pageSize, config.pageLimit, signal)
    const usedTargets = new Set<number>()
    for (const pack of plan.packages) {
      const override = plan.targets.find(item => item.index === pack.index)
      const existing = override ? override.storyboard_id === null ? [] : boards.filter(row => Number(row.id) === override.storyboard_id)
        : boards.filter(row => Number(row.episodeId) === plan.episode_id && row.storyboardName === pack.name)
      if (override?.storyboard_id && !existing.length) throw new Error(`${pack.name}选择的原卡不在当前项目库存中。`)
      if (existing.some(row => row.episodeId !== undefined && row.episodeId !== null && Number(row.episodeId) !== plan.episode_id)) throw new Error(`${pack.name}选择的原卡属于另一集。`)
      pack.target_candidates = existing.map(row => Number(row.id))
      const existingCard = existing[0]
      if (existing.length === 1 && existingCard !== undefined) {
        if (usedTargets.has(Number(existingCard.id))) throw new Error('两个视频包不能覆盖同一原卡；按包分别选择targets。')
        usedTargets.add(Number(existingCard.id))
        const current = await productionCard(client, Number(existingCard.id))
        pack.storyboard_id = current.card.storyboard_id; pack.expected_snapshot_sha256 = current.sha256
        pack.current_assets = storyboardMaterials(current.card.snapshot).materials.map(item => ({
          material_key: String(item.materialKey), name: typeof item.fileName === 'string' ? item.fileName
            : typeof item.assetName === 'string' ? item.assetName : '',
          asset_id: item.materialAssetId === undefined ? null : Number(item.materialAssetId),
          kind: String(item.materialType), url: typeof item.materialUrl === 'string' ? item.materialUrl : null }))
        const currentIds = pack.current_assets.filter(item => item.kind === 'image').map(item => item.asset_id)
        if (JSON.stringify(currentIds) !== JSON.stringify(pack.images.map(item => item.asset_id))) plan.warnings.push({
          code: 'existing_asset_selection_changed', shot: null, message: `${pack.name}原卡${pack.storyboard_id}的图片选择将改变；对照current_assets、本镜状态和候选图片核对，避免把正确换装改回旧版本。` })
      } else if (existing.length > 1) plan.warnings.push({ code: 'duplicate_card_names', shot: null,
        message: `${pack.name}存在多个原卡；保留全部原卡，先按ID和内容核对。` })
    }
    if (previous && previous.source_sha256 !== plan.source_sha256) plan.warnings.push({ code: 'source_changed', shot: null,
      message: '原稿在上次预览后已修改；当前方案使用最新全文，重新核对逐镜要求，保留用户改稿。' })
    if (video.current(agent)?.revision !== selection.revision) plan.warnings.push({ code: 'model_changed_during_preview', shot: null,
      message: '预览期间会话模型发生切换；当前报告保留开始时的规格，update重新分包。' })
    plan = seal(plan)
    return plan
  }
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'muse_production',
    description: 'Muse自有批量制作：preview读取完整分镜脚本、当前会话视频模型和剧变库存，按完整镜头自动分包，逐镜给出人物／服装、场景、道具、音频候选和依据；保存本地方案，不写剧变、不收费。'
      + 'read分页查看matches/packages/warnings；update只提交要调整的逐镜choices或requirements，刷新库存与模型后重新预览。'
      + 'apply将方案免费批量写入剧变并真实回读，已有同名同集卡原位更新；不提交生成。所有创作、匹配和时长问题为提示，不要求清零，也不需要用户逐包批准。'
      + '预览结果须实际交回你看图／听音核对，不能在同一脚本里直接把未审候选连到apply。保留用户当前稿、原台词、说话人和换装节点；不要用一个全局人物映射覆盖不同镜头。'
      + '缺声线看voice_follow_up：按已有制作授权先生成首个清晰讲话包，再核对和抽取、上传登记共享声线；换装不换声线时期。',
    parameters: {
      method: { type: 'string', required: true, enum: ['preview', 'read', 'update', 'apply'] },
      project_dir: { type: 'string', description: 'preview必填：已有project_config.json且绑定剧变项目的本地根目录。' },
      script: { type: 'string', description: 'preview必填：本集完整导演分镜脚本UTF-8文件；使用【镜头N】和本镜人物、场景、道具字段。' },
      episode: { type: 'integer', description: 'preview必填：真实显示集号，工具查询远端episode_id。' },
      ratio: { type: 'string', description: '首次preview必填：项目已确认画幅，如16:9，不改变项目风格。' },
      gen_type: { type: 'integer', description: '首次preview必填：当前模型支持且本项目采用的生成类型。' },
      plan_path: { type: 'string', description: 'read/update/apply必填：上次返回的完整本地方案路径。' },
      requirements: { type: 'array', description: '可选逐镜更正或补充要求；人物名用稳定故事身份，state写本镜服装，conditions写具体场景或道具条件；声音明确character_id与voice_period_id。', items: {
        type: 'object', additionalProperties: false, properties: { shot: { type: 'integer', required: true },
          kind: { type: 'string', required: true, enum: ['character', 'scene', 'prop', 'voice'] }, name: { type: 'string', required: true },
          state: { type: 'string' }, conditions: { type: 'array', items: { type: 'string' } }, character_id: { type: 'string' }, voice_period_id: { type: 'string' } } } },
      choices: { type: 'array', description: '只提交要改的逐镜选择，其他选择保留。asset_id=null明确暂不绑定；同名人物换装按镜分别选，不按列表顺序猜。', items: {
        type: 'object', additionalProperties: false, properties: { shot: { type: 'integer', required: true },
          kind: { type: 'string', required: true, enum: ['character', 'scene', 'prop', 'voice'] }, name: { type: 'string', required: true },
          asset_id: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] } } } },
      targets: { type: 'array', description: '可选原卡选择：index是方案包序号，storyboard_id是实际原卡ID；null明确新建。默认复用同集同名唯一原卡，重名时按target_candidates核对，不猜、不重复建卡。', items: {
        type: 'object', additionalProperties: false, properties: { index: { type: 'integer', required: true },
          storyboard_id: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] } } } },
      section: { type: 'string', enum: ['matches', 'packages', 'warnings', 'assets'] }, offset: { type: 'integer' }, limit: { type: 'integer' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, presentationMeta: reviewPresentationMeta,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    presentCall: args => ({ card: 'generic', kind: args.method === 'apply' ? 'edit' : 'read', title: 'Muse批量制作', rawInput: args }),
    isConcurrencySafe: args => args.method === 'read',
    execute: async (args, exec) => {
      const request: ProductionArgs = { ...args }
      if (!Number.isSafeInteger(request.offset ?? 0) || (request.offset ?? 0) < 0
        || !Number.isSafeInteger(request.limit ?? 20) || (request.limit ?? 20) < 1 || (request.limit ?? 20) > 100) throw new Error('分页offset须非负整数，limit须1–100。')
      if (request.requirements) request.requirements = z.array(requirementSchema).parse(request.requirements)
      if (request.choices) request.choices = z.array(choiceSchema).parse(request.choices)
      if (request.targets) request.targets = z.array(targetSchema).parse(request.targets)
      const path = request.plan_path ?? ''
      if (request.method !== 'preview' && !path) throw new Error('read、update和apply需要上次返回的plan_path。')
      const previous = request.method === 'preview' ? undefined : await loadPlan(path)
      if (request.method === 'read') {
        if (previous === undefined) throw new Error('需要已保存的本地制作方案。')
        return view(previous, path, request)
      }
      if (!exec.agent) throw new Error('批量制作需要当前会话，以读取实际选择的视频模型。')
      if (request.method === 'preview' || request.method === 'update') {
        const plan = await preview(request, exec.agent, exec.signal, previous)
        return view(plan, await savePlan(plan), request)
      }
      if (previous === undefined) throw new Error('apply需要已保存的本地制作方案。')
      const plan = previous
      const bound = z.object({ jubian_script_id: z.number().int().positive() }).parse(JSON.parse(await readFile(join(plan.project_dir, 'project_config.json'), 'utf8')))
      if (bound.jubian_script_id !== plan.script_id) throw new Error('项目绑定已变化；重新预览当前项目，不按旧方案写入。')
      if (video.current(exec.agent)?.revision !== plan.model.revision) return { status: 'model_selection_changed', paid_requests: 0,
        plan_path: path, next: '当前会话模型已切换；update按最新模型自动重新分包，再审阅方案。' }
      if (productionHash(await readFile(plan.source_path)) !== plan.source_sha256) return { status: 'source_changed', paid_requests: 0,
        plan_path: path, next: '用户原稿已变化；update读取最新全文，不用旧方案覆盖用户返稿。' }
      const receiptPath = path.replace(/\.json$/u, '.receipts.json')
      return await withFileLock(receiptPath, async () => {
        const receiptSchema = z.record(z.string(), z.object({ storyboard_id: z.number(), snapshot_sha256: z.string() }))
        let receipts: z.infer<typeof receiptSchema> = {}
        try { receipts = receiptSchema.parse(JSON.parse(await readFile(receiptPath, 'utf8'))) }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
        const results: Record<string, unknown>[] = []
        for (const pack of plan.packages) {
          exec.signal.throwIfAborted()
          if (pack.target_candidates.length > 1) {
            results.push({ index: pack.index, name: pack.name, status: 'target_ambiguous', target_candidates: pack.target_candidates,
              paid_requests: 0, next: '当前存在多个同集同名原卡；update用targets选择实际卡ID，其他独立视频包继续。' })
            continue
          }
          const prior = receipts[String(pack.index)]
          if (prior) {
            const current = await productionCard(client, prior.storyboard_id)
            results.push({ index: pack.index, name: pack.name, storyboard_id: prior.storyboard_id,
              status: current.sha256 === prior.snapshot_sha256 ? 'already_saved' : 'current_card_changed',
              verified_readback: current.card, paid_requests: 0 })
            continue
          }
          try {
            const { maxDurationSeconds: _maximum, revision: _revision, ...selectors } = plan.model
            const result = await publishProductionCard(client, ledger, { ...pack, project_dir: plan.project_dir,
              script_id: plan.script_id, script_name: plan.script_name, episode: plan.episode, episode_id: plan.episode_id,
              key: `muse-production-${plan.fingerprint}-${pack.index}`, model: { ...selectors, duration: pack.duration,
                genNum: 1, prompt: pack.prompt }, page_size: config.pageSize, page_limit: config.pageLimit }, exec.signal)
            results.push({ index: pack.index, name: pack.name, ...result })
            if (result.status === 'billing_safety_violation') break
            if (result.status === 'saved' && typeof result.storyboard_id === 'number' && typeof result.snapshot_sha256 === 'string') {
              receipts[String(pack.index)] = { storyboard_id: result.storyboard_id, snapshot_sha256: result.snapshot_sha256 }
              await writeFileAtomic(receiptPath, JSON.stringify(receipts) + '\n', { mode: 0o600, dirMode: 0o700 })
            }
          } catch (error) {
            results.push({ index: pack.index, name: pack.name, status: 'reconcile_required', paid_requests: 0,
              next: '本项失败或结果未知，保留原方案和key回读核对，不换key重建。', error: error instanceof Error ? error.message : 'Publication failed' })
          }
        }
        return { method: 'apply', mode: 'advisory', plan_path: path, paid_requests: 0, total: plan.packages.length,
          processed: results.length, unattempted: plan.packages.length - results.length,
          saved: results.filter(item => item.status === 'saved' || item.status === 'already_saved').length, results,
          next: '逐卡核对真实回读与本镜要求；保存不等于艺术质量通过，也未生成。缺声线沿预览voice_follow_up处理，再按原授权prepare_video。' }
      }) as Record<string, JsonValue>
    },
  })))
}
