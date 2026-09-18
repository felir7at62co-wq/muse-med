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
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JUBIAN_TOKEN_REF, JubianClient, JubianLedger } from '@deepseek-ai/dsh-jubian'
import { assetMethod, catalogMethod, mediaMethod, storyboardMethod, videoMethod } from './methods.ts'
import type { MethodArgs } from './methods.ts'

export const name = 'tool-jubian'
export const inject = ['tools', 'credentials']

export interface Config {
  /** Directory holding the write ledger; defaults to `<DSH_HOME>/jubian/ledger`. */
  ledgerRoot?: string
  baseUrl?: string
  timeoutMs?: number
}

/** The one sentence every write method's description carries. */
const WRITE_NOTE = '写方法必须提供 idempotency_key：同一个 key 不会重复发送，重复调用会返回既有记录（replayed=true）。'
  + '超时或结果未知时不要换 key 重试——先用同一个 key 再调一次。'

/** Arguments shared by more than one tool; each tool lists only what it accepts. */
const ARGS = {
  idempotency_key: { type: 'string', description: `写方法必填；读方法忽略。${WRITE_NOTE}` },
  task_type: { type: 'number', description: 'models 必填：1=视频，2=图片，10=去字幕。' },
  standard_id: { type: 'number', description: 'rate 必填：计价标准 ID。' },
  script_id: { type: 'number', description: '剧变项目 ID（scriptId）。' },
  page_num: { type: 'number', description: '页码，默认 1。' },
  page_size: { type: 'number', description: '每页条数，默认 20，上限 1000。' },
  asset_id: { type: 'number', description: 'get / generated_image 必填：主体资产 ID。' },
  material_id: { type: 'number', description: 'confirm_casting 必填：生成材质 ID（不是父资产、不是任务 ID）。' },
  storyboard_id: { type: 'number', description: '分镜 ID。' },
  task_id: { type: 'number', description: 'task / subtasks 必填：视频任务 ID。' },
  asset_name: { type: 'string', description: 'image_generate 必填：资产名。' },
  asset_type: { type: 'number', description: 'image_generate 必填：平台资产类型数字，当前只有 1（角色）有证据。' },
  prompt: { type: 'string', description: 'image_generate 必填：图片提示词。' },
  references: { type: 'array', items: { type: 'string' },
    description: 'image_generate 可选：有序参考图 HTTPS URL，顺序即生成顺序。' },
  parent_asset_id: { type: 'number', description: 'image_generate 可选：给了就是重生成（PUT），不给是新建（POST）。' },
  content_duration_ms: { type: 'number', description: 'generate 必填：本包内容时长，4000–14000 的整千毫秒。' },
  model_id: { type: 'string', description: 'erase_subtitle 必填：quzimuToB（区域性，需 subtitle_box）或 '
    + 'ark-erase-video-subtitle-pro（自动，不接受 subtitle_box）。' },
  task_name: { type: 'string', description: 'erase_subtitle 必填：任务名。' },
  first_result_id: { type: 'number', description: 'erase_subtitle 必填：源视频 firstResultId。' },
  parent_result_id: { type: 'number', description: 'erase_subtitle 必填：源视频 parentResultId。' },
  video_url: { type: 'string', description: 'erase_subtitle 必填：源视频 HTTPS URL。' },
  duration: { type: 'number', description: 'erase_subtitle 必填：源视频秒数。' },
  video_width: { type: 'number', description: 'erase_subtitle 必填：画面宽度。' },
  video_height: { type: 'number', description: 'erase_subtitle 必填：画面高度。' },
  subtitle_box: { type: 'object', additionalProperties: true,
    description: 'erase_subtitle 区域性擦除必填：{zimuLeft,zimuTop,zimuWidth,zimuHeight}，'
      + '取自 subtasks 返回的 subtitle_box。' },
  body: { type: 'object', additionalProperties: true,
    description: 'create 必填：完整的远端请求体（本插件不做体编译）。' },
  media_url: { type: 'string', description: 'media 必填：剧变 CDN 上的媒体 URL（来自其他方法的返回值）。' },
  media_kind: { type: 'string', enum: ['image', 'video'], description: 'media 必填：要下载的是图片还是视频。' },
  output_path: { type: 'string', description: 'media 必填：落盘的本地绝对路径。' },
  delivery_resolution: { type: 'string',
    description: 'subtasks 可选但强烈建议：本次要交付的分辨率，如 1080p。给定后每行都会得到 '
      + 'needs_upscale：低于该分辨率的结果为 true，表示必须先转高清才能使用；无法判断时为 null。' },
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
 * @param run - The domain method, given the validated argument bag.
 * @returns An execute function for `defineTool`.
 */
function guarded(
  run: (args: MethodArgs) => Promise<Record<string, unknown>>,
): (args: unknown) => Promise<ToolValue> {
  return async (args: unknown) => await run(args as MethodArgs) as ToolValue
}

/**
 * Install the four Jubian tools.
 * @param ctx - Host context carrying `tools` and `credentials`.
 * @param config - Optional ledger location, origin and timeout overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const ledger = new JubianLedger({ root: config.ledgerRoot ?? join(home, 'jubian', 'ledger') })
  const client = new JubianClient({
    credential: async () => (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? '',
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
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
    execute: guarded(args => catalogMethod(client, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_asset',
    description: '剧变（Jubian）主体设定与资产的查询、确认出演与删除。get/list/materials/generated_image 只读。'
      + '**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用。'
      + '它同样需要 idempotency_key，且不要重试。'
      + '**remove 会不可恢复地删除一个父资产**（`DELETE /aigc/asset/removeAsset/{id}`，带 scriptId 与 isParent=1）：'
      + '资产与其媒体版本会被移除，引用它的镜头匹配与已生成视频不会因此重建。'
      + '**如果只是想取消"正式选用"，不要用 remove** —— 那是一个不同的动作。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['get', 'list', 'materials', 'generated_image', 'confirm_casting', 'remove'],
        description: 'get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；'
          + 'generated_image=该资产的生成图 URL；confirm_casting=确认出演（有副作用）；'
          + 'remove=删除一个父资产（不可恢复）。' },
      script_id: ARGS.script_id, asset_id: ARGS.asset_id, material_id: ARGS.material_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size, idempotency_key: ARGS.idempotency_key,
    },
    output: OUTPUT,
    execute: guarded(args => assetMethod(client, ledger, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_storyboard',
    description: '剧变（Jubian）分镜查询与提交。get/create/save 免费（save 强制 isGenerate=0）。'
      + '**generate、erase_subtitle 与 upscale 会真实计费且不可撤销**。'
      + 'generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，'
      + '且它必须与该分镜已保存的时长一致，否则会在发请求前失败。'
      + '**erase_subtitle 只需 task_id 与画面尺寸**：源身份从父任务与子结果读，'
      + '擦除矩形按提供方的默认比例从画面尺寸推导，不需要也不应该由调用方画框。'
      + '它与转高清一样是异步的，提交后不要干等——先做别的，之后用 subtasks 回读判断。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true, enum: ['get', 'create', 'save', 'generate', 'erase_subtitle'],
        description: 'get=读分镜（含 model_config 与素材键）；create=用调用方给定的请求体新建；'
          + 'save=存为不生成；generate=提交生成（计费）；erase_subtitle=去字幕（计费、异步）。' },
      storyboard_id: ARGS.storyboard_id, content_duration_ms: ARGS.content_duration_ms,
      task_id: ARGS.task_id, script_id: ARGS.script_id,
      model_id: ARGS.model_id, task_name: ARGS.task_name,
      video_width: ARGS.video_width, video_height: ARGS.video_height, subtitle_box: ARGS.subtitle_box,
      body: ARGS.body, idempotency_key: ARGS.idempotency_key,
    },
    output: OUTPUT,
    execute: guarded(args => storyboardMethod(client, ledger, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_video',
    description: '剧变（Jubian）视频任务查询与图片生成。task/tasks/subtasks 只读'
      + '（subtasks 用 POST 承载查询体，仍然只读；它返回成片 videoUrl 与字幕像素框）。'
      + '**image_generate 会真实计费且不可撤销**：生成或重生成一张主体资产图；'
      + '给了 parent_asset_id 就是重生成（PUT），否则新建（POST）。'
      + '**upscale 会真实计费（SeedVR2 视频高清，1 元/条）**：把低于交付分辨率的成片转成 1080p。'
      + '它是异步的，实测要十几分钟，提交后立刻返回、绝不等待——先做别的，'
      + '之后用 subtasks 回读 hd_count / last_task_type / resolution 判断是否转好。'
      + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true, enum: ['task', 'tasks', 'subtasks', 'image_generate', 'upscale'],
        description: 'task=单个任务（含 cost 观测）；tasks=项目任务分页；'
          + 'subtasks=任务的子结果（成片 URL、字幕框、阶段、分辨率与 needs_upscale）；'
          + 'image_generate=生成图片（计费）；upscale=转高清（计费、异步）。' },
      task_id: ARGS.task_id, script_id: ARGS.script_id, page_num: ARGS.page_num,
      delivery_resolution: ARGS.delivery_resolution,
      asset_name: ARGS.asset_name, asset_type: ARGS.asset_type, prompt: ARGS.prompt,
      references: ARGS.references, parent_asset_id: ARGS.parent_asset_id,
      task_name: ARGS.task_name,
      idempotency_key: ARGS.idempotency_key,
    },
    output: OUTPUT,
    execute: guarded(args => videoMethod(client, ledger, args)),
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
    execute: guarded(args => mediaMethod(args)),
  }))
}
