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
import { requireArguments } from './write.ts'

export const name = 'tool-jubian'
export const inject = ['tools', 'credentials']

/** Where the tool row keeps its ledger and which origin it calls. */
export interface Config {
  /** Directory holding the write ledger; defaults to `<DSH_HOME>/jubian/ledger`. */
  ledgerRoot?: string
  /** Origin override; defaults to the client's own default base URL. */
  baseUrl?: string
  /** Per-call abort budget in milliseconds. */
  timeoutMs?: number
  /**
   * Whether the workspace's own pipeline secret file may stand in for a missing
   * credential-store value; defaults to true.
   */
  workspaceSecrets?: boolean
  /**
   * Which `platformId` of the `taskType=2` catalogue `image_generate` buys from,
   * such as `KU_AI`. The account catalogue can list one model id once per
   * platform at different prices, and this plugin never picks one for you: with
   * several rows and no configured platform or standard, the call fails and
   * names every candidate.
   */
  imagePlatformId?: string
  /**
   * Which catalogue row (`standardId`, the row's own `id`) `image_generate` buys
   * from, such as `66`. Either this or `imagePlatformId` is enough to pin one row.
   */
  imageStandardId?: number
  /**
   * How long `image_generate` waits for the new asset to reach
   * `hsAssetStatus === "Active"` before reporting a timeout, in milliseconds;
   * defaults to 180000, because a measured asset took one to two minutes.
   */
  imageActiveTimeoutMs?: number
  /** Delay between the readback polls above, in milliseconds; defaults to 3000. */
  imageActivePollMs?: number
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
  asset_name: { type: 'string', description: 'image_generate 必填：资产名。' },
  asset_type: { type: 'number', description: 'image_generate 必填：平台资产类型数字，当前只有 1（角色）有证据。' },
  prompt: { type: 'string', description: 'image_generate 必填：图片提示词。' },
  references: { type: 'array', items: { type: 'string' },
    description: 'image_generate 可选：有序参考图 HTTPS URL，顺序即生成顺序。' },
  parent_asset_id: { type: 'number', description: 'image_generate 可选：给了就是重生成（PUT），不给是新建（POST）。' },
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
    description: 'create 必填：完整的远端请求体（本插件不做体编译）。' },
  media_url: { type: 'string', description: 'media 必填：剧变 CDN 上的媒体 URL（来自其他方法的返回值）。' },
  media_kind: { type: 'string', enum: ['image', 'video'], description: 'media 必填：要下载的是图片还是视频。' },
  output_path: { type: 'string', description: 'media 必填：落盘的本地绝对路径。' },
  delivery_resolution: { type: 'string',
    description: 'subtasks 可选但强烈建议：本次要交付的分辨率，如 1080p。给定后每行都会得到 '
      + 'needs_upscale：低于该分辨率的结果为 true，表示必须先转高清才能使用；无法判断时为 null。' },
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
 * @param run - The domain method, given the validated argument bag.
 * @returns An execute function for `defineTool`.
 */
function guarded(
  tool: string,
  run: (args: MethodArgs) => Promise<Record<string, unknown>>,
): (args: unknown) => Promise<ToolValue> {
  return async (args: unknown) => {
    const dispatched = args as MethodArgs
    requireArguments(tool, dispatched as unknown as { method?: string } & Record<string, unknown>)
    return await run(dispatched) as ToolValue
  }
}

/**
 * Install the four Jubian tools.
 * @param ctx - Host context carrying `tools` and `credentials`.
 * @param config - Optional ledger location, origin, timeout and image-row overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const ledger = new JubianLedger({ root: config.ledgerRoot ?? join(home, 'jubian', 'ledger') })
  const client = new JubianClient({
    credential: async () => {
      const stored = (await ctx.credentials.resolve(credentialRef(JUBIAN_TOKEN_REF)))?.value ?? ''
      if (stored.trim()) return stored
      return config.workspaceSecrets === false ? '' : await workspacePipelineToken(process.cwd())
    },
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })
  // Deployment-varying choices live here, not in a constant: which platform the
  // paid image route buys from, and how long its readback may take. An omitted
  // platform and standard leaves `resolveImageModel` to accept the catalogue
  // only while it offers exactly one `gpt-image-2` row.
  const image: ImageMethodOptions = {
    selection: {
      ...(config.imagePlatformId === undefined ? {} : { platformId: config.imagePlatformId }),
      ...(config.imageStandardId === undefined ? {} : { standardId: config.imageStandardId }),
    },
    ...(config.imageActiveTimeoutMs === undefined ? {} : { activeTimeoutMs: config.imageActiveTimeoutMs }),
    ...(config.imageActivePollMs === undefined ? {} : { pollIntervalMs: config.imageActivePollMs }),
  }

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
    name: 'jubian_asset',
    description: '剧变（Jubian）主体设定与资产的查询、确认出演与删除。get/list/materials/generated_image 只读。'
      + '**confirm_casting 有副作用**：它用 GET 动词改变了远端状态，会使该材质被本次制作采用。'
      + '它同样需要 idempotency_key，且不要重试。'
      + '**remove 会不可恢复地删除一个父资产**（`DELETE /aigc/asset/removeAsset/{id}`，带 scriptId 与 isParent=1）：'
      + '资产与其媒体版本会被移除，引用它的镜头匹配与已生成视频不会因此重建。'
      + '**如果只是想取消"正式选用"，不要用 remove** —— 那是一个不同的动作。'
      + '**upload_reference 免费**：把本地参考图（jpg/jpeg/png/webp）按剧变前端自身的上传配置送到它的对象存储，'
      + '返回 HTTPS material_url —— gpt-image-2 的参考图只接受 URL。两条边必须是 16 的倍数：已合规的文件原样上传，'
      + '不合规时调用本机 ffmpeg 重编码（可用 DSH_JUBIAN_FFMPEG/FFMPEG_PATH 指定二进制）；'
      + '本机找不到 ffmpeg 时返回 alignment_required 并给出应有的尺寸，绝不上传不合规的图片。' + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['get', 'list', 'materials', 'generated_image', 'confirm_casting', 'remove', 'upload_reference'],
        description: 'get=单个资产（含 is_local/status）；list=项目资产分页；materials=主体设定材质；'
          + 'generated_image=该资产的生成图 URL；confirm_casting=确认出演（有副作用）；'
          + 'remove=删除一个父资产（不可恢复）；upload_reference=上传本地参考图并取回 material_url（免费）。' },
      script_id: ARGS.script_id, asset_id: ARGS.asset_id, material_id: ARGS.material_id,
      page_num: ARGS.page_num, page_size: ARGS.page_size, idempotency_key: ARGS.idempotency_key,
      image_path: ARGS.image_path,
    },
    output: OUTPUT,
    execute: guarded('jubian_asset', args => assetMethod(client, ledger, args)),
  }))

  ctx.tools.register(defineTool({
    name: 'jubian_storyboard',
    description: '剧变（Jubian）分镜查询与提交。get/create/save 免费（save 强制 isGenerate=0）。'
      + '**generate、erase_subtitle 与 submit_video 会真实计费且不可撤销**。'
      + 'generate 先读当前分镜快照再把 isGenerate 置 1 提交，因此必须同时给出 content_duration_ms，'
      + '且它必须与该分镜已保存的时长一致，否则会在发请求前失败。'
      + '**主体视频的唯一正常通道是 select_assets(isGenerate=0) → prepare_video → submit_video**：'
      + 'select_assets 把选定资产写进分镜，永远强制 isGenerate=0（免费），PUT 后回读身份/URL/名称/顺序；'
      + 'prepare_video 只读实时分镜、主体设定与非 Mini Seedance 模型，'
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
      video_width: ARGS.video_width, video_height: ARGS.video_height, subtitle_box: ARGS.subtitle_box,
      body: ARGS.body, idempotency_key: ARGS.idempotency_key,
      selections: ARGS.selections, project_dir: ARGS.project_dir, preview_path: ARGS.preview_path,
    },
    output: OUTPUT,
    execute: guarded('jubian_storyboard', args => storyboardMethod(client, ledger, args)),
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
      + '插件不替你挑平台：未在配置里指定 imagePlatformId/imageStandardId 且目录多于一行时，'
      + '请求体构造阶段就会报错并列出全部候选行（platformId、standardId、单价）。'
      + '**upscale 会真实计费（SeedVR2 视频高清，1 元/条）**：把低于交付分辨率的成片转成 1080p。'
      + '它是异步的，实测要十几分钟，提交后立刻返回、绝不等待——先做别的，'
      + '之后用 subtasks 回读 hd_count / last_task_type / resolution 判断是否转好。'
      + '**retry 是服务端状态变更**：只在父子任务全部终止失败、没有结果 URL、也没有真实费用时才会发出；'
      + '重试响应异常时不要盲目重提，先回读父任务与生成子素材。'
      + WRITE_NOTE,
    parameters: {
      method: { type: 'string', required: true,
        enum: ['task', 'tasks', 'subtasks', 'image_generate', 'upscale', 'retry'],
        description: 'task=单个任务（含 cost 观测）；tasks=项目任务分页；'
          + 'subtasks=任务的子结果（成片 URL、字幕框、阶段、分辨率与 needs_upscale）；'
          + 'image_generate=生成图片（计费）；upscale=转高清（计费、异步）；retry=重试终止失败且未计费的任务。' },
      task_id: ARGS.task_id, script_id: ARGS.script_id, page_num: ARGS.page_num,
      delivery_resolution: ARGS.delivery_resolution,
      asset_name: ARGS.asset_name, asset_type: ARGS.asset_type, prompt: ARGS.prompt,
      references: ARGS.references, parent_asset_id: ARGS.parent_asset_id,
      task_name: ARGS.task_name,
      idempotency_key: ARGS.idempotency_key,
    },
    output: OUTPUT,
    execute: guarded('jubian_video', args => videoMethod(client, ledger, args, { image })),
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
