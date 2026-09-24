/**
 * Jubian tools: one plugin row any DSH preset can mount.
 *
 * The tool descriptions carry the facts a model cannot infer from the schema:
 * which methods really cost money, which one changes provider state through a
 * GET verb, and that a timeout never means "safe to retry".
 *
 * Every write method requires the caller's `idempotency_key`. The key is never
 * generated here: a generated key would let a retry after an ambiguous outcome
 * bypass the record of the first attempt, which is the only thing standing
 * between a timeout and a second charge.
 *
 * The row mounts {@link JubianToken} beside the tools. The same credential the
 * tools resolve is the one a person edits in Web Settings, so the page that
 * writes it belongs to the package that consumes it rather than to a generic
 * configuration surface that can write any reference.
 */
import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF, JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod, catalogMethod, mediaMethod, storyboardMethod, videoMethod } from './methods.ts'
import type { ImageMethodOptions, MethodArgs } from './methods.ts'
import { findMethod } from './find.ts'
import type { FindArgs } from './find.ts'
import { seriesBudgetLimit } from './budget-settings.ts'
import { JubianImageRoutes, pinnedImageSelection } from './image.ts'
import type { ImageRouteConfig } from './image.ts'
import { ASSET_CATEGORIES, resolveNaming } from './naming.ts'
import type { Naming } from './naming.ts'
import { organizeMethod } from './organize.ts'
import { modelMethod } from './model-settings.ts'
import { JubianToken } from './token.ts'
import { requireArguments } from './write.ts'
import { resolveWatchConfig, watchArgs, watchJob } from './watch.ts'

export { JubianToken } from './token.ts'
export { JubianImageRoutes, pinnedImageSelection } from './image.ts'
export type { ImageRouteConfig } from './image.ts'

export const name = 'tool-jubian'
export const inject = ['tools', 'credentials']

/** Where the tool row keeps its ledger and which origin it calls. */
export interface Config extends ImageRouteConfig {
  /** Directory holding the write ledger; defaults to `<DSH_HOME>/jubian/ledger`. */
  ledgerRoot?: string
  /** Origin override; defaults to the client's own default base URL. */
  baseUrl?: string
  /** Per-call abort budget in milliseconds. */
  timeoutMs?: number
  /** Watch polling interval in milliseconds; integer 1..60000, default 15000. */
  watchPollIntervalMs?: number
  /** Watch deadline in milliseconds; integer 1..86400000, default 1800000. */
  watchTimeoutMs?: number
  /**
   * Whether the workspace's own pipeline secret file may stand in for a missing
   * credential-store value; defaults to true.
   */
  workspaceSecrets?: boolean
  /**
   * How long `image_generate` waits for the new asset to reach
   * `hsAssetStatus === "Active"` before reporting a timeout, in milliseconds;
   * defaults to 180000, because a measured asset took one to two minutes.
   */
  imageActiveTimeoutMs?: number
  /** Delay between the readback polls above, in milliseconds; defaults to 3000. */
  imageActivePollMs?: number
  /**
   * Separator between the segments of a composed asset name; defaults to `｜`.
   * Applies only to names this row composes from an `episode` argument — a caller
   * that passes no episode keeps its own `asset_name` and `task_name` verbatim.
   */
  nameSeparator?: string
  /**
   * Episode token of an asset that serves the whole series; defaults to `全剧`.
   * A caller passes exactly this value as `episode` to place an asset outside any
   * one episode.
   */
  seriesLabel?: string
  /**
   * Where `jubian_organize` writes its index, relative to the project directory;
   * defaults to `_probe/asset-index.md`.
   */
  assetIndexPath?: string
}

/** The one sentence every write method's description carries. */
const WRITE_NOTE = '写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。'
  + '超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。'

/** The workspace-relative secret file the pipeline skills already use. */
const PIPELINE_ENV = join('.agents', 'secrets', 'pipeline.env')

/**
 * Read the pipeline token from the nearest workspace secret file.
 *
 * The credential store stays the source of truth: this runs only when that store
 * has no usable value, because the pipeline's own client resolves the same file
 * and a session that lost the store entry should not lose its login with it. The
 * value never enters a result, a log or a preview.
 * @param start - Directory to search upward from, normally the launch directory.
 * @returns The token, or an empty string when no file in the chain carries one.
 */
export async function workspacePipelineToken(start: string): Promise<string> {
  let directory = resolve(start)
  for (let hop = 0; hop < 12; hop += 1) {
    try {
      const text = await readFile(join(directory, PIPELINE_ENV), 'utf8')
      const values = new Map<string, string>()
      for (const line of text.split('\n')) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        const name = match?.[1]
        if (name === undefined) continue
        values.set(name, (match?.[2] ?? '').replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
      }
      const token = values.get('JUBIANAI_ADMIN_TOKEN') ?? values.get('JUBIANAI_TOKEN')
      return token ?? ''
    } catch { /* keep walking up */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return ''
}

/** Arguments shared by more than one tool; each tool lists only what it accepts. */
const ARGS = {
  idempotency_key: { type: 'string', description: `写方法必填；读方法忽略。${WRITE_NOTE}` },
  task_type: { type: 'number', description: 'models 必填：1=视频，2=图片，10=去字幕。' },
  standard_id: { type: 'number', description: 'rate 必填：计价标准 ID。' },
  script_id: { type: 'number', description: '剧变项目 ID（scriptId）。erase_subtitle 与 upscale 从任务行读取它，'
    + '不必单独提供；其余方法按上面的必填说明传入。' },
  page_num: { type: 'number', description: '页码，默认 1。' },
  page_size: { type: 'number', description: '每页条数，默认 20，上限 1000。' },
  asset_id: { type: 'number', description: 'get / generated_image 必填：主体资产 ID。' },
  material_id: { type: 'number', description: 'confirm_casting 必填：生成材质 ID（不是父资产、不是任务 ID）。' },
  storyboard_id: { type: 'number', description: '分镜 ID。' },
  task_id: { type: 'number', description: 'task / subtasks 必填：视频任务 ID。' },
  asset_name: { type: 'string',
    description: 'image_generate 必填、rename 必填：资产名。'
      + '给了 episode 时这里只写资产自己的名字（如 `红包`），插件按规范补齐前缀与类别段；'
      + '不给 episode 时原样发送。rename 发送的就是最终的完整名称。' },
  asset_type: { type: 'number', enum: [1, 2, 3],
    description: 'image_generate 的资产类别号：1=角色，2=场景，3=道具。'
      + '给了 asset_category 时可以不传（插件按类别推导）；两个都给时必须一致。'
      + '场景与道具必须传 2/3——一律传 1 会把它们建进控制台的角色库。' },
  prompt: { type: 'string', description: 'image_generate 必填：图片提示词。' },
  references: { type: 'array', items: { type: 'string' },
    description: 'image_generate 可选：有序参考图 HTTPS URL，顺序即生成顺序。' },
  parent_asset_id: { type: 'number', description: 'image_generate 可选：给了就是重生成（PUT），不给是新建（POST）。' },
  asset_url: { type: 'string',
    description: 'register 必填：这条新资产要引用的图片 HTTPS 地址（通常是原资产的 materialUrl）。'
      + 'register 按它新建资产，不生成新图。' },
  content_duration_ms: { type: 'number', description: 'generate 必填：本包内容时长，4000–14000 的整千毫秒。' },
  model_id: { type: 'string', description: 'erase_subtitle 必填：quzimuToB（羽点，区域性）或 '
    + 'ark-erase-video-subtitle-pro（自动）。插件不设默认值——省略即在发请求前报错，'
    + '不会替你挑一个模型。' },
  task_name: { type: 'string', description: 'erase_subtitle 可选：任务名，省略时按「<源任务名>-去字幕」生成。' },
  first_result_id: { type: 'number', description: 'erase_subtitle 必填：源视频 firstResultId。' },
  parent_result_id: { type: 'number', description: 'erase_subtitle 必填：源视频 parentResultId。' },
  video_url: { type: 'string', description: 'erase_subtitle 必填：源视频 HTTPS URL。' },
  duration: { type: 'number', description: 'erase_subtitle 必填：源视频秒数。' },
  video_width: { type: 'number', description: 'erase_subtitle 必填：画面宽度。' },
  video_height: { type: 'number', description: 'erase_subtitle 必填：画面高度。' },
  subtitle_box: { type: 'object', additionalProperties: true,
    description: 'erase_subtitle 可选：{zimuLeft,zimuTop,zimuWidth,zimuHeight}。'
      + '省略时按画面尺寸推导提供方默认比例——通常不要传，工作台的预览坐标无法由调用方复现。' },
  body: { type: 'object', additionalProperties: true,
    description: 'create 二选一：完整的远端请求体（本插件不做体编译）。' },
  body_path: { type: 'string',
    description: 'create 二选一：包含完整冻结请求体的本地 UTF-8 JSON 文件路径。' },
  media_url: { type: 'string', description: 'media 必填：剧变 CDN 上的媒体 URL（来自其他方法的返回值）。' },
  media_kind: { type: 'string', enum: ['image', 'video'], description: 'media 必填：要下载的是图片还是视频。' },
  output_path: { type: 'string', description: 'media 必填：落盘的本地绝对路径。' },
  delivery_resolution: { type: 'string',
    description: 'subtasks 可选但强烈建议：本次要交付的分辨率，如 1080p。给定后每行都会得到 '
      + 'needs_upscale：低于该分辨率的结果为 true，否则为 false，无法判断时为 null。'
      + 'true 仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务。' },
  image_path: { type: 'string',
    description: 'upload_reference 必填：本地参考图路径（jpg/jpeg/png/webp）。' },
  project_dir: { type: 'string',
    description: 'prepare_video 必填、submit_video 可选：项目目录，必须含 project_config.json，'
      + '且其 jubian_script_id 必须等于实时 scriptId。' },
  preview_path: { type: 'string',
    description: 'submit_video 必填：prepare_video 返回的 preview_path，不要猜测或手写文件名。' },
  selections: { type: 'array',
    items: { type: 'object', additionalProperties: false, properties: {
      material_key: { type: 'string', required: true,
        description: '提示词里 @[名称](key) 的 key。' },
      asset_id: { type: 'number', required: true,
        description: '主体设定行的父资产 ID（materials 返回的 asset_id）。' },
    } },
    description: 'select_assets 必填：有序的 (material_key, 父 asset_id) 列表，'
      + '顺序必须与提示词里的 key 顺序完全一致。' },
  episode: { type: 'string',
    description: '可选：集号（`5` 与 `05` 都规范成 `EP05`）或配置的跨集母版标记（默认「全剧」）。'
      + '给了它，资产名会按规范组合成 `EP05｜角色｜陆沉舟`，处理任务名会加上 `EP05-P3-` 这样的可排序前缀；'
      + '不给就完全按调用方原样使用 asset_name / task_name。' },
  asset_category: { type: 'string', enum: [...ASSET_CATEGORIES],
    description: '资产类别。与 episode 同时给出时决定资产名里的类别段，'
      + '并决定 image_generate 的 assetType（角色=1、场景=2、道具=3）——'
      + '场景与道具必须传对应类别，否则资产会落进控制台的角色库。' },
  package_number: { type: 'string',
    description: 'erase_subtitle / upscale 可选：本集内的包号，配合 episode 生成 `EP05-P3` 前缀。' },
  folder_name: { type: 'string', description: 'create_folder 必填：文件夹名，例如 `EP05`。' },
  parent_id: { type: 'number',
    description: 'create_folder 可选：父文件夹 ID；省略则建在该类别库的根下'
      + '（根自己的 ID 就是 root_category_type 的数字）。' },
  asset_scope_type: { type: 'number', enum: [1, 2],
    description: 'create_folder / move 必填：1=团队资产，2=个人资产。资产在哪个库就在哪个库建夹与移动。' },
  root_category_type: { type: 'number', enum: [1, 2, 3],
    description: 'create_folder / move 必填：1=角色库，2=场景库，3=道具库。'
      + 'move 只用它在本地读文件夹树做前置校验，请求体仍与前端一致（不发这个字段）。' },
  material_ids: { type: 'array', items: { type: 'number' },
    description: 'move 必填：要移动的材质行 ID（素材列表里每行的 id，不是父 asset_id）。' },
  target_folder_id: { type: 'number',
    description: 'move 必填：目标文件夹 ID；要放回库根目录就传该库的 root_category_type 数字。' },
} as const

/** One canonical value, as the tool registry requires it to be losslessly JSON. */
type ToolValue = Record<string, JsonValue>

/** One shared output contract: a canonical JSON object rendered as pretty text. */
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: Record<string, unknown>): ContentBlock[] =>
    [{ type: 'text', text: JSON.stringify(value, null, 2) }],
} as const

/**
 * Adapt one domain method to the tool registry.
 *
 * The registry types arguments from the authored parameter spec and requires a
 * losslessly-JSON return value, while these methods take one wide argument bag
 * and may carry provider values the transport kept as `unknown`. Both casts are
 * at this single seam rather than at every call site; the runtime shape is the
 * same either way.
 *
 * The required-argument check runs here, before dispatch, so a call missing an
 * argument its method cannot run without fails without a request, a ledger line
 * or any provider state change.
 * @param tool - Registered tool name, which keys {@link REQUIRED_ARGUMENTS}.
 * @param run - The domain method, given the argument bag its own signature declares.
 * @returns An execute function for `defineTool`.
 */
function guarded<A = MethodArgs>(
  tool: string,
  run: (args: A) => Promise<Record<string, unknown>>,
): (args: unknown) => Promise<ToolValue> {
  return async (args: unknown) => {
    requireArguments(tool, args as { method?: string } & Record<string, unknown>)
    return await run(args as A) as ToolValue
  }
}

/**
 * Install the Jubian tools and the two Remote namespaces they expose.
 * @param ctx - Host context carrying `tools` and `credentials`.
 * @param config - Optional ledger location, origin, timeout and image-route values.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const watchConfig = resolveWatchConfig(config)
  ctx.plugin(JubianToken)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  // Resolved once, here, so a blank separator or series label fails the mount
  // rather than composing a name no reader can split.
  const naming: Naming = resolveNaming(
    { ...(config.nameSeparator === undefined ? {} : { separator: config.nameSeparator }),
      ...(config.seriesLabel === undefined ? {} : { seriesLabel: config.seriesLabel }) })
  const ledger = new JubianLedger({ root: config.ledgerRoot ?? join(home, 'jubian', 'ledger'),
    defaultLimitCents: () => seriesBudgetLimit(ctx) })
  const client = new JubianClient({
    credential: async () => {
      const stored = (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? ''
      if (stored.trim()) return stored
      return config.workspaceSecrets === false ? '' : await workspacePipelineToken(process.cwd())
    },
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })
  // The rows a Settings page may pick between. It shares the transport above, so
  // the token that authorizes the read stays in this process.
  ctx.plugin(JubianImageRoutes, { client })
  // Which row the paid image route buys from, and how long its readback may take:
  // deployment-varying values, so they live in config and in the settings document
  // rather than in a constant. Both are read per call, because the settings page
  // can repin the route while this row stays loaded; an unpinned catalogue leaves
  // `resolveImageModel` to accept it only while it offers exactly one
  // `gpt-image-2` row.
  const image = (): ImageMethodOptions => ({
    selection: pinnedImageSelection(ctx, config),
    ...(config.imageActiveTimeoutMs === undefined ? {} : { activeTimeoutMs: config.imageActiveTimeoutMs }),
    ...(config.imageActivePollMs === undefined ? {} : { pollIntervalMs: config.imageActivePollMs }),
  })

  ctx.tools.register(defineTool({
    name: 'jubian_catalog',
    description: '剧变（Jubian）目录与项目只读查询：账户模型目录与报价、剧本、分集。全部只读，不产生费用。',
    parameters: {
      method: { type: 'string', required: true, enum: ['models', 'rate', 'script', 'episodes'],
        description: 'models=账户模型目录；rate=单个计价标准；script=剧本身份；episodes=分集列表。' },
      task_type: ARGS.task_type, standard_id: ARGS.standard_id, script_id: ARGS.script_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size,
    },
    output: OUTPUT,
    execute: guarded('jubian_catalog', args => catalogMethod(client, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_find',
    description: '按名字查找剧变（Jubian）剧本。只读、免费，不需要 idempotency_key，也不改变任何远端状态。'
      + '两个 scope：mine=你自己名下的画布项目（`GET /aigc/script/list`）；'
      + 'pool=可认领的剧本池（`GET /script/center/pool/list`）。'
      + 'name 先去掉首尾空白、把内部连续空白并成一个空格、忽略大小写，再同时匹配 '
      + 'scriptName 与 manuscriptName 的子串——没有拼音、别名或模糊匹配，差一个字就是没找到。'
      + 'page_size 只限制单次请求的条数，不是扫描上限：工具会一直翻页，直到读完 total、'
      + '某一页为空，或达到 scan_page_limit（页数上限，返回值里有）。'
      + 'complete=false 表示这次没有覆盖 total（或用了页数上限），不要读成"就这些"；'
      + 'scanned_pages 是实际请求的页数。'
      + 'returned 是本次返回的匹配数，truncated=true 表示匹配列表被输出上限截断（扫描本身可能已完整）。'
      + '每条匹配给出 script_id、script_name、manuscript_name、episode_count、status 与 script_style；'
      + 'scope=pool 时另有 can_claim、claim_leader_name、claim_member_name，但没有 script_style——'
      + '这个字段只有 mine 的行被实测到。'
      + '省略 name 就是列出该 scope 的第一页（page_size 条），不是错误。'
      + 'status 只对 pool 有效，会原样作为查询参数转发；给 mine 传 status 会被拒绝，不会静默忽略。'
      + 'production_type 与 share_target_type 只对 mine 有效，同样原样转发为 productionType 与 '
      + 'shareTargetType；控制台打开「漫剧视频」时发的就是 productionType=0 + shareTargetType=1，'
      + '要列漫剧项目就传这两个值。两个取值都是提供方自己的编码，本工具不解释、不校验、也不设默认值，'
      + '省略就不出现在查询串里；给 pool 传会被拒绝。'
      + '它不写账本、不检查预算、不重试。响应读不懂时直接报 CONTRACT_CHANGED，'
      + '绝不把读不懂的响应当成"没找到"——漏本和没本必须能区分。',
    parameters: {
      scope: { type: 'string', required: true, enum: ['mine', 'pool'],
        description: 'mine=自己名下的画布项目；pool=可认领的剧本池。必填，两者只能选一个。' },
      name: { type: 'string',
        description: '可选：要查的名字片段，同时匹配 scriptName 与 manuscriptName 的子串。'
          + '先去掉首尾空白、内部连续空白并成一个空格、忽略大小写；不支持拼音、别名与模糊匹配。'
          + '省略就是列出该 scope 的第一页。空白字符串会被拒绝。' },
      page_num: { type: 'number',
        description: '可选：从第几页开始扫描，默认 1。它会同时决定 completeness 的起点：'
          + '第 2 页起要读完的仍是 total 里剩下的部分。' },
      page_size: { type: 'number',
        description: '可选：单次请求的条数，默认 20，上限 1000。它只限制一次请求，不限制整次扫描——'
          + '扫描会翻页读到 total 或达到 scan_page_limit。结果太大时用它调小每次请求。' },
      status: { type: 'string',
        description: '可选，仅 scope=pool：按池子状态过滤，原样转发（例如 returned、claimed、'
          + 'pending_leader_claim）。状态名由提供方定义，本工具不解释也不校验。' },
      production_type: { type: 'number',
        description: '可选，仅 scope=mine：按提供方自己的 productionType 编码过滤，原样转发为查询参数 '
          + 'productionType。控制台打开「漫剧视频」时发的是 productionType=0，所以要列漫剧项目就传 0；'
          + '这个编码由提供方定义，本工具不解释也不校验取值，省略就不出现在查询串里。' },
      share_target_type: { type: 'number',
        description: '可选，仅 scope=mine：按提供方自己的 shareTargetType 编码过滤，原样转发为查询参数 '
          + 'shareTargetType。控制台打开「漫剧视频」时发的是 shareTargetType=1，所以要列漫剧项目就传 1；'
          + '这个编码由提供方定义，本工具不解释也不校验取值，省略就不出现在查询串里。' },
    },
    output: OUTPUT,
    execute: guarded<FindArgs>('jubian_find', args => findMethod(client, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_asset',
    description: '剧变（Jubian）主体设定与资产的查询、确认出演与删除。get/list/materials/generated_image 只读。'
      + '**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用。'
      + '它同样需要 idempotency_key，且不要重试。'
      + '**remove 会不可恢复地删除一个父资产**（`DELETE /aigc/asset/removeAsset/{id}`，带 scriptId 与 isParent=1）：'
      + '资产与其媒体版本会被移除，引用它的镜头匹配与已生成视频不会因此重建。'
      + '**如果只是想取消"正式选用"，不要用 remove** —— 那是一个不同的动作。'
      + '**create_folder / move / rename 会改变控制台里的组织方式**（都在 `/aigc/*` 上真实写入）：'
      + 'create_folder 建一个类别库里的文件夹，同名同级已存在时直接报告、不发请求；'
      + 'move 把材质行移进文件夹，目标文件夹不在该库里时同样只报告；'
      + 'rename 改资产的显示名称。三者都需要 idempotency_key，都不改图片、不改 id、不换类别。'
      + '**批量改名或搬家前必须先取得用户明确同意**：这些是用户已经在控制台里看到的名字和位置。'
      + '**upload_reference 免费**：把本地参考图（jpg/jpeg/png/webp）按剧变前端自身的上传配置送到它的对象存储，'
      + '返回 HTTPS material_url —— gpt-image-2 的参考图只接受 URL。两条边必须是 16 的倍数：已合规的文件原样上传，'
      + '不合规时调用本机 ffmpeg 重编码（可用 DSH_JUBIAN_FFMPEG/FFMPEG_PATH 指定二进制）；'
      + '本机找不到 ffmpeg 时返回 alignment_required 并给出应有的尺寸，绝不上传不合规的图片。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['get', 'list', 'materials', 'generated_image', 'confirm_casting', 'register', 'remove', 'upload_reference',
          'create_folder', 'move', 'rename'],
        description: 'get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；'
          + 'generated_image=该资产的生成图 URL；confirm_casting=确认出演（有副作用）；'
          + 'register=按指定类别新建一条资产，只引用已有图片、不生成新图（有副作用）；'
          + 'remove=删除一个父资产（不可恢复）；upload_reference=上传本地参考图并取回 material_url（免费）；'
          + 'create_folder=在某个类别库里建文件夹；move=把资产移动进文件夹；rename=给资产改名。' },
      script_id: ARGS.script_id, asset_id: ARGS.asset_id, material_id: ARGS.material_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size, idempotency_key: ARGS.idempotency_key,
      image_path: ARGS.image_path,
      folder_name: ARGS.folder_name, parent_id: ARGS.parent_id,
      asset_scope_type: ARGS.asset_scope_type, root_category_type: ARGS.root_category_type,
      material_ids: ARGS.material_ids, target_folder_id: ARGS.target_folder_id,
      asset_name: ARGS.asset_name, episode: ARGS.episode, asset_category: ARGS.asset_category,
      asset_type: ARGS.asset_type, asset_url: ARGS.asset_url,
    },
    output: OUTPUT,
    execute: guarded('jubian_asset', args => assetMethod(client, ledger, args, { naming })),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_organize',
    description: '只读、免费的资产组织视图：把剧变项目按「集数 → 类别」列出'
      + '（每集用到哪些角色/场景/道具，各自的 asset_id、material_id 与状态），'
      + '并做两份审计——不符合 `EP{两位集数}｜{类别}｜{名称}` 规范的远端名称，'
      + '以及 assetType 与自身名字或清单声明不一致的资产（历史遗留的类别错放）。'
      + '同时读出个人资产库里每个类别的文件夹树。'
      + '**它只读：不重命名、不移动、不改动任何远端资产**，结果同时写一份本地索引文件。'
      + '要改，用 jubian_asset 的 create_folder / move / rename，且批量操作前先取得用户同意。',
    parameters: {
      method: { type: 'string', required: true, enum: ['index'],
        description: 'index=按集数与类别输出组织视图，并写本地索引文件。' },
      script_id: { ...ARGS.script_id, required: true }, project_dir: { ...ARGS.project_dir, required: true },
    },
    output: OUTPUT,
    execute: guarded('jubian_organize', args => organizeMethod(client, args, {
      naming,
      ...(config.assetIndexPath === undefined ? {} : { indexPath: config.assetIndexPath }),
    })),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_model',
    description: '免费配置现有分镜的视频模型与分辨率。preview 只读实时目录和分镜，按明确范围写本地冻结计划，'
      + '返回每项 before/after 与 fingerprint；不 PUT、不生成。scope=storyboards 使用远端 storyboard_ids，'
      + 'episodes 使用远端 episode_ids（不是集号），project 仅包含当前项目已有分镜。'
      + 'apply 必须先取得用户对范围和配置的同意，使用 preview_path 与 idempotency_key=fingerprint。'
      + '写前校验全部目标、成员和目录，每项再即时回读；只改 modelConfig 模型字段，所有 PUT 强制 isGenerate=0，'
      + '保留提示词、资产身份和顺序、非模型设置，回读核验。未提供的设置保留，不会默认切换模型；'
      + '更换模型未指定 platformId 时要求目录唯一匹配，否则拒绝。项目未来默认值和已生成媒体不变。'
      + '错误或超时立即停止剩余项并逐项报告；同一计划不会重发或续写，先回读对账，不要换 key 盲目重试。',
    parameters: {
      method: { type: 'string', required: true, enum: ['preview', 'apply'],
        description: 'preview=只读预览并落冻结计划；apply=应用用户批准的计划（免费，不生成）。' },
      project_dir: { type: 'string', required: true, description: '含 project_config.json 的项目目录。' },
      script_id: { type: 'number', required: true, description: '必须与 project_config.json 及所有目标一致的远端项目 ID。' },
      scope: { type: 'string', enum: ['storyboards', 'episodes', 'project'], description: 'preview 必填：已有分镜的明确范围。' },
      storyboard_ids: { type: 'array', items: { type: 'number' }, description: 'storyboards 范围必填：精确远端分镜 ID，不能重复。' },
      episode_ids: { type: 'array', items: { type: 'number' }, description: 'episodes 范围必填：精确远端 episodeId，不是显示集号。' },
      changes: { type: 'object', additionalProperties: false, description: 'preview 必填：至少一项。未指定字段保留，目录中不支持或不唯一时拒绝。',
        properties: {
          modelId: { type: 'string', description: '账户视频目录中的精确模型 ID，不接受别名或默认替换。' },
          platformId: { type: 'string', description: '明确指定的平台；换模型时省略则要求唯一匹配。' },
          ratio: { type: 'string', description: '目录支持的比例，例如 9:16。' },
          resolution: { type: 'string', description: '目录支持的分辨率，例如 720p、1080p。' },
          genType: { type: 'number', description: '目录支持的生成类型。' },
          duration: { type: 'number', description: '模型允许的整数秒数，包含末尾自然收束。' },
          genNum: { type: 'number', description: '目录支持的生成数量。' },
        } },
      preview_path: { type: 'string', description: 'apply 必填：preview 返回的冻结计划路径。' },
      idempotency_key: { type: 'string', description: 'apply 必填：必须等于计划 fingerprint；同计划永不重发。' },
    },
    output: OUTPUT,
    execute: guarded('jubian_model', args => modelMethod(client, ledger, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_storyboard',
    description: '剧变（Jubian）分镜查询与提交。get/create/save 免费（create/save 强制 isGenerate=0）。'
      + '**generate、erase_subtitle 与 submit_video 会真实计费且不可撤销**。'
      + 'generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，'
      + '且它必须与该分镜已保存的时长一致，否则会在发请求前失败。'
      + '**主体视频的唯一正常通道是 select_assets(isGenerate=0) → prepare_video → submit_video**：'
      + 'select_assets 把选定资产写进分镜，永远强制 isGenerate=0（免费），PUT 后回读身份/URL/名称/顺序；'
      + 'prepare_video 只读实时分镜、主体设定与模型目录，保留已存 modelId/比例/分辨率/时长，'
      + '按精确模型 ID 解析当前目录；不支持、匹配不唯一或超过该模型时长上限时拒绝，不自动换模型，'
      + '在 <project_dir>/video_tasks/ 原子写一份 *.storyboard-native.prepared.json，不 PUT、不创建任务、不收费；'
      + 'submit_video 的 idempotency_key 必须等于该 preview 自带的 fingerprint，'
      + 'PUT 前做远端任务全量双快照对账，确认无冲突后最多执行一次 PUT /aigc/storyboard（isGenerate=1），'
      + '随后第二次快照回读每个子项的 assetId/materialName/imageUrl 与顺序；'
      + '身份缺失是终态 subject_identity_lost，超时/5xx/连接中断/缺 task ID 只进入对账状态，绝不自动二次 PUT。'
      + '**禁止 direct POST /admin/aigc/video/task/create**（任务 335470 因此丢失主体身份）；'
      + 'storyboard PUT 创建的 335343 保留了全部七项身份。'
      + '**erase_subtitle 必填 task_id、model_id 与画面尺寸**（script_id 从任务行读取）：'
      + '源身份从父任务与子结果读，擦除矩形按提供方的默认比例从画面尺寸推导，'
      + '不需要也不应该由调用方画框。model_id 没有默认值，'
      + '省略会在发任何请求之前报 INVALID_ARGUMENT，不会静默替你挑一个模型。'
      + '它与转高清一样是异步的，提交后不要干等——先做别的，之后用 subtasks 回读判断。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['get', 'create', 'save', 'generate', 'select_assets', 'prepare_video', 'submit_video', 'erase_subtitle'],
        description: 'get=读分镜（含 model_config 与素材键）；create=用调用方给定的请求体新建；'
          + 'save=存为不生成；generate=提交生成（计费）；'
          + 'select_assets=写入选定资产（免费，强制 isGenerate=0）；'
          + 'prepare_video=只读准备并落 preview（免费）；submit_video=按 preview 提交一次（计费、异步）；'
          + 'erase_subtitle=去字幕（计费、异步）。' },
      storyboard_id: ARGS.storyboard_id, content_duration_ms: ARGS.content_duration_ms,
      task_id: ARGS.task_id, script_id: ARGS.script_id,
      model_id: ARGS.model_id, task_name: ARGS.task_name,
      episode: ARGS.episode, package_number: ARGS.package_number,
      video_width: ARGS.video_width, video_height: ARGS.video_height, subtitle_box: ARGS.subtitle_box,
      body: ARGS.body, body_path: ARGS.body_path, idempotency_key: ARGS.idempotency_key,
      selections: ARGS.selections, project_dir: ARGS.project_dir, preview_path: ARGS.preview_path,
    },
    output: OUTPUT,
    execute: guarded('jubian_storyboard', args => storyboardMethod(client, ledger, args, { naming })),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_video',
    description: '剧变（Jubian）视频任务查询与图片生成。task/tasks/subtasks 只读'
      + '（subtasks 用 POST 承载查询体，仍然只读；它返回成片 videoUrl 与字幕像素框）。'
      + '**image_generate 会真实计费且不可撤销**：生成或重生成一张主体资产图；'
      + '给了 parent_asset_id 就是重生成（PUT），否则新建（POST）。'
      + '它只在同一个 idempotency_key 下发送一次，并在受理后回读该资产直到 hsAssetStatus 变为 Active，'
      + '然后返回 material_id（confirm_casting 需要它）与 image_url。'
      + '返回里的 asset_status 说明回读结论：active 才是拿到图（此时才可落盘/审核）；'
      + 'timeout 表示受理已计费但资产尚未 Active，不要换 key 重投，稍后用 jubian_asset get/generated_image 续读；'
      + 'failed 表示提供方判失败；unverified 表示没能确认资产，先回读 jubian_asset list。'
      + '账户目录里 gpt-image-2 可能有多行（不同平台、不同单价）；'
      + '插件不替你挑平台：没有锁定行而目录多于一行时，请求体构造阶段就会报错并列出全部候选行'
      + '（platformId、standardId、单价）。锁定行由人在 Web 设置的「短剧 → 资产图生成通道」里选，'
      + '或由部署在插件配置里给 imagePlatformId/imageStandardId；遇到这个报错时把候选念给用户，'
      + '请他在设置里选一行，不要自己挑。'
      + '**upscale 会真实计费（SeedVR2 视频高清，1 元/条）**：把成片转成 1080p。'
      + 'SD2.5 默认使用原片，不自动提交或等待高清；任何模型都不能仅因 needs_upscale=true 自动付费。'
      + '仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）。'
      + '普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。'
      + '它是异步的，实测要十几分钟，提交后立刻返回、绝不等待——先做别的，'
      + '之后用 subtasks 回读 hd_count / last_task_type / resolution 判断是否转好。'
      + '**retry 是服务端状态变更**：只在父子任务全部终止失败、没有结果 URL、也没有真实费用时才会发出；'
      + '重试响应异常时不要盲目重提，先回读父任务与生成子素材。'
      + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['task', 'tasks', 'subtasks', 'unresolved', 'image_generate', 'upscale', 'retry'],
        description: 'task=单个任务（含 cost 观测）；tasks=项目任务分页；'
          + 'subtasks=任务的子结果（成片 URL、字幕框、阶段、分辨率与 needs_upscale）；'
          + 'unresolved=只读本地账本，列出没有确定结果的写入（进程重启后先做这一步，按返回的 next 逐笔对账，不要换 key 重发）；'
          + 'image_generate=生成图片（计费）；upscale=转高清（计费、异步）；retry=重试终止失败且未计费的任务。' },
      task_id: ARGS.task_id, script_id: ARGS.script_id, page_num: ARGS.page_num,
      delivery_resolution: ARGS.delivery_resolution,
      asset_name: ARGS.asset_name, asset_type: ARGS.asset_type, prompt: ARGS.prompt,
      references: ARGS.references, parent_asset_id: ARGS.parent_asset_id,
      episode: ARGS.episode, asset_category: ARGS.asset_category, package_number: ARGS.package_number,
      task_name: ARGS.task_name,
      idempotency_key: ARGS.idempotency_key,
    },
    output: OUTPUT,
    execute: guarded('jubian_video', args => videoMethod(client, ledger, args, { image: image(), naming })),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_watch',
    description: '只读后台观察已受理的剧变操作，立即返回 job_id；task_id 必须是本次生成/转高清/去字幕操作的任务 ID，'
      + '不是源视频任务 ID。只读同一任务及其完整子结果，严格核对身份、阶段和成功状态；旧 URL 或 hdCount 不代表本次完成。'
      + '完成后由 jobs 通知，用 job_output 取结果；job_kill 只停观察，不取消提供方操作。进程重启不恢复，超时失败不重投收费请求。'
      + '提供方完成不等于视觉审核通过：结果仍需抽帧、音频和交付分辨率检查。',
    parameters: {
      task_id: { type: 'integer', required: true,
        description: '已受理的本次操作任务 ID（正安全整数），不是源任务 ID。' },
      stage: { type: 'string', required: true, enum: ['generate', 'upscale', 'erase_subtitle'],
        description: '本次操作的阶段，必须与任务类型及全部输出一致。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        job_id: { type: 'string', required: true }, task_id: { type: 'integer', required: true },
        stage: { type: 'string', enum: ['generate', 'upscale', 'erase_subtitle'], required: true },
        status: { type: 'string', enum: ['running'], required: true },
      } },
      render: OUTPUT.render,
    },
    // `async` is required by the tool contract, which types `execute` as returning a
    // promise; this body itself only starts a job and returns its id.
    execute: async (args, exec) => {
      const input = watchArgs(args)
      const jobs = ctx.get('jobs')
      if (!jobs) throw new Error('jubian_watch requires a jobs provider and job controller; other Jubian tools remain available')
      if (!exec.agent) throw new Error('jubian_watch requires an owning Agent for completion delivery')
      const job_id = jobs.start({ kind: 'jubian', owner: exec.agent,
        label: `Jubian ${input.stage} operation ${input.task_id}`,
        run: () => watchJob(client, input, watchConfig) })
      return { job_id, ...input, status: 'running' as const }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_media',
    description: '把剧变（Jubian）CDN 上的媒体下载到本地文件，返回本地路径、字节数与 sha256。'
      + '不产生费用、不需要凭证（该 CDN 是公开的）。'
      + '下载后请用你自己的看图工具（如 read_image）或抽帧工具读取该路径——'
      + '本工具不会把图片或视频内容放进返回值。',
    parameters: {
      method: { type: 'string', required: true, enum: ['download'],
        description: 'download=从 media_url 下载到 output_path。' },
      media_url: { ...ARGS.media_url, required: true },
      media_kind: { ...ARGS.media_kind, required: true },
      output_path: { ...ARGS.output_path, required: true },
    },
    output: OUTPUT,
    execute: guarded('jubian_media', args => mediaMethod(args)),
  }))
}
