/**
 * Every Jubian tool method, as a plain async function over an injected client.
 *
 * Write methods run under the ledger and require the caller's `idempotency_key`:
 * a key that already has a record returns that record instead of sending a
 * second paid request, which is the only honest answer to "did that timeout
 * already charge me?".
 *
 * Read methods never touch the ledger. Three of them are worth naming here
 * because their HTTP verbs lie: `subtasks` is a POST that only reads,
 * `confirm_casting` is a GET that changes provider state, and `prepare_video`
 * writes only a local preview file while reading everything it needs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { JubianClient, JubianLedger, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import {
  MODEL_TASK_TYPES as TASKS, FAILED_STATUSES, SUCCESS_STATUSES, buildImageRequest, buildSubtitleEraseRequest,
  buildVideoUpscaleRequest, downloadMedia, readAssetList, readAssetPage, readEpisodes, readGeneratedImage,
  readImageDisplayPrice, readMaterialList, readModels, readScript, readStoryboard, readSubtaskPage,
  readTaskList, readTaskPage, readSubtitleTaskId, readUpscaleTaskId, needsUpscale, resolveImageModel,
  withGenerationDisabled, withGenerationEnabled,
} from '@deepseek-ai/dsh-jubian-api'
import type { ImageModelSelection, ImageModelSelectors, MediaKind, SubjectSelectionRequest } from '@deepseek-ai/dsh-jubian-api'
import { positiveInteger, prepareVideoMethod, selectAssetsMethod, submitVideoMethod } from './native.ts'
import { createFolderMethod, moveMethod, renameMethod } from './folders.ts'
import { composedAssetName, resolveNaming, taskPrefix } from './naming.ts'
import { ASSET_CATEGORY_TYPES } from './naming.ts'
import type { AssetCategory, Naming } from './naming.ts'
import { uploadReferenceMethod } from './reference.ts'
import type { ReferenceUploadDeps } from './reference.ts'
import { need, requireKey, writeUnderLedger } from './write.ts'

export { bodyHash, writeUnderLedger } from './write.ts'
export type { WriteOutcome } from './write.ts'

/** Arguments as the tool layer receives them, already schema-validated. */
export interface MethodArgs {
  method: string
  /** `jubian_model preview`: exact remote scope and partial model intent. */
  scope?: 'storyboards' | 'episodes' | 'project'
  storyboard_ids?: number[]
  episode_ids?: number[]
  changes?: Record<string, unknown>
  idempotency_key?: string
  task_type?: number
  standard_id?: number
  script_id?: number
  page_num?: number
  page_size?: number
  asset_id?: number
  material_id?: number
  storyboard_id?: number
  task_id?: number
  asset_name?: string
  asset_type?: number
  /** `jubian_asset register`: the existing image URL the new asset will reference. */
  asset_url?: string
  prompt?: string
  references?: string[]
  parent_asset_id?: number
  content_duration_ms?: number
  model_id?: string
  task_name?: string
  first_result_id?: number
  parent_result_id?: number
  video_url?: string
  duration?: number
  video_width?: number
  video_height?: number
  subtitle_box?: { zimuLeft: number; zimuTop: number; zimuWidth: number; zimuHeight: number }
  body?: Record<string, unknown>
  /** `create`: UTF-8 JSON file containing the complete frozen request body. */
  body_path?: string
  media_url?: string
  media_kind?: MediaKind
  output_path?: string
  /** The resolution the caller intends to deliver, e.g. `1080p`; drives the needs_upscale verdict. */
  delivery_resolution?: string
  /** `upload_reference`: the local image file to normalize and upload. */
  image_path?: string
  /** `prepare_video` / `submit_video`: the project directory holding `project_config.json`. */
  project_dir?: string
  /** `submit_video`: the prepared preview file the submission must be bound to. */
  preview_path?: string
  /** `select_assets`: the ordered `material_key`/parent `asset_id` pairs to save. */
  selections?: SubjectSelectionRequest[]
  /**
   * Episode an asset name or a task name is prefixed with: a number (`5` or `05`) or the
   * configured series label. Omitting it leaves every name exactly as the caller wrote it.
   */
  episode?: string
  /** `image_generate`: the category segment {@link composedAssetName} writes; required with `episode`. */
  asset_category?: AssetCategory
  /** `erase_subtitle` / `upscale`: package number inside the episode, as in `EP05-P3`. */
  package_number?: string
  /** `create_folder`: the folder's name, such as `EP05`. */
  folder_name?: string
  /** `create_folder`: parent folder; the category library's root when omitted. */
  parent_id?: number
  /** `create_folder` / `move`: 1 team library, 2 personal library. */
  asset_scope_type?: number
  /** `create_folder` / `move`: 1 character, 2 scene, 3 prop — the same number as `asset_type`. */
  root_category_type?: number
  /** `move`: the material rows to move. */
  material_ids?: number[]
  /** `move`: destination folder, or the category number to move back to the library root. */
  target_folder_id?: number
}

/** One provider response, as the transport returns it. */
type ClientResponse = JubianResponse

/**
 * Everything the paid image path takes from outside the transport.
 *
 * `selection` pins which of several `gpt-image-2` catalogue rows this deployment
 * buys from. The readback fields bound the wait for the asset's image to exist,
 * and the clock and sleep are injectable so the timeout path is testable without
 * spending three minutes of wall clock.
 */
export interface ImageMethodOptions {
  /** The `gpt-image-2` catalogue row this deployment pinned. */
  selection?: ImageModelSelection
  /** Total budget for reaching `hsAssetStatus === 'Active'`, in milliseconds. */
  activeTimeoutMs?: number
  /** Delay between readback polls, in milliseconds. */
  pollIntervalMs?: number
  /** Clock used for the readback budget. */
  now?: () => number
  /** Sleep between readback polls. */
  sleep?: (ms: number) => Promise<void>
}

/** The seams a method needs besides the provider transport, injectable for tests. */
export interface MethodDeps {
  /** Local reference upload: transport, re-encode, clock and `ffmpeg` path. */
  reference?: ReferenceUploadDeps
  /** Paid image generation: the pinned catalogue row and the post-write readback budget. */
  image?: ImageMethodOptions
  /** Naming choices; defaults to the convention's own defaults when omitted. */
  naming?: Naming
}

/** Provider statuses that mean a task is still moving and a retry would race it. */
const ACTIVE_STATUSES = ['submit', 'submitted', 'pending', 'queued', 'running', 'processing']

/** Default readback budget: a measured image asset reaches `Active` in one to two minutes. */
const IMAGE_ACTIVE_TIMEOUT_MS = 180_000

/** Default readback poll interval. */
const IMAGE_ACTIVE_POLL_MS = 3_000

/**
 * What one `image_generate` readback concluded.
 *
 * The four non-`active` states are distinct facts, and none of them means "the
 * image is there": `failed` saw a terminal asset status, `timeout` ran out of
 * budget, `replayed` sent nothing at all, and `unverified` could not even name
 * the asset to read.
 */
type ImageAssetStatus = 'active' | 'failed' | 'timeout' | 'replayed' | 'unverified'

/** One post-write readback, as the tool result carries it. */
interface ImageReadback {
  status: ImageAssetStatus
  material_id: number | null
  image_url: string | null
  observed_status: string | null
  waited_ms: number
  error: string | null
}

/** One readback with nothing read and one reason why. */
function unread(status: 'replayed' | 'unverified', error: string): ImageReadback {
  return { status, material_id: null, image_url: null, observed_status: null, waited_ms: 0, error }
}

/**
 * The one instruction that matches what the readback actually established.
 * @param readback - The readback outcome.
 * @returns Caller-facing guidance naming the only safe next action.
 */
function imageNext(readback: ImageReadback): string {
  switch (readback.status) {
    case 'active':
      return '资产已 Active：material_id 是可用于 confirm_casting 的生成材质 ID，image_url 是这张生成图。'
        + '此时再落盘或审核，才不会拿到一个空资产。'
    case 'failed':
      return '资产已被提供方判为失败，不会再有生成图；重新生成要换一个新的 idempotency_key，'
        + '同一个 key 不会再次发送。'
    case 'timeout':
      return '受理已计费（outcome=accepted）但回读超时：不要换 key 重投，'
        + '用 jubian_asset get 读 parent_asset_id 的状态，Active 之后再用 generated_image 取图。'
    case 'replayed':
      return '本次是重放：没有发送任何请求。资产身份请用 jubian_asset list/get 回读。'
    case 'unverified':
      return '没有确认资产与生成图：先回读 jubian_asset list 核对，确认前不要落盘，也不要换 key 重投。'
  }
}

/**
 * Wait for the accepted asset to become `Active`, then read its generated image.
 *
 * `POST /aigc/asset` is asynchronous: the response carries the new asset id, and
 * the asset has no image until the provider's own pipeline finishes. Returning at
 * acceptance would hand the caller an asset that reads back empty, so this polls
 * the free asset read until `hsAssetStatus` is `Active` and then reads the one
 * endpoint that carries both the material id and the image URL.
 * @param client - Jubian transport.
 * @param assetId - The asset id the accepted response carried, or null when it carried none.
 * @param options - Readback budget, poll interval, clock and sleep.
 * @returns The readback outcome; a timed-out readback is reported, never thrown, because the
 *   paid write was already accepted and the ledger already records it.
 */
async function awaitGeneratedImage(client: JubianClient, assetId: number | null,
  options: ImageMethodOptions): Promise<ImageReadback> {
  if (assetId === null) {
    return unread('unverified', '受理响应没有给出可回读的资产 ID，无法确认生成图；'
      + '用 jubian_asset list 按 asset_name 找到该资产后再读 generated_image。')
  }
  const now = options.now ?? ((): number => Date.now())
  const sleep = options.sleep
    ?? ((ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const budget = options.activeTimeoutMs ?? IMAGE_ACTIVE_TIMEOUT_MS
  const interval = options.pollIntervalMs ?? IMAGE_ACTIVE_POLL_MS
  const started = now()
  let observed: string | null = null
  let lastError: string | null = null
  for (;;) {
    const asset = readAssetPage((await client.request({ method: 'GET', path: `/aigc/asset/${assetId}` })).data)
    observed = asset.status
    if (observed !== null && observed.trim().toLowerCase() === 'active') {
      try {
        const image = readGeneratedImage((await client.request({ method: 'GET',
          path: `/aigc/material/getGeneratedImageByAssetId?assetId=${assetId}` })).data)
        return { status: 'active', material_id: image.material_id, image_url: image.url,
          observed_status: observed, waited_ms: now() - started, error: null }
      } catch (error) {
        // The image row can lag the status it belongs to by one poll; any other
        // failure is a real one and is reported rather than slept over.
        if (!(error instanceof JubianError) || error.code !== 'CONTRACT_CHANGED') throw error
        lastError = error.message
      }
    } else if (observed !== null
      && (FAILED_STATUSES as readonly string[]).includes(observed.trim().toLowerCase())) {
      return { status: 'failed', material_id: null, image_url: null, observed_status: observed,
        waited_ms: now() - started, error: `资产状态为 ${observed}，不会再有生成图。` }
    }
    const elapsed = now() - started
    if (elapsed + interval > budget) {
      return { status: 'timeout', material_id: null, image_url: null, observed_status: observed,
        waited_ms: elapsed,
        error: `回读超时：资产在 ${budget}ms 内没有变为 Active`
          + `（最后观察到的状态：${observed ?? '未提供'}${lastError === null ? '' : `；生成图读取失败：${lastError}`}）。`
          + '受理已被计费，不要换 key 重投。' }
    }
    await sleep(interval)
  }
}

/**
 * Compose the sortable prefix a processing stage puts in front of the source
 * task's own name.
 * @param args - The dispatched arguments, read for `episode` and `package_number`.
 * @param naming - Resolved naming choices, or undefined for their defaults.
 * @returns `EP05-P3-`, or an empty string when the caller named no episode.
 */
function stagePrefix(args: MethodArgs, naming: Naming | undefined): string {
  if (args.episode === undefined) return ''
  return `${taskPrefix(args.episode, args.package_number, naming ?? resolveNaming())}-`
}

function page(args: MethodArgs): string {
  const num = args.page_num ?? 1
  const size = args.page_size ?? 20
  if (!Number.isSafeInteger(num) || num < 1 || !Number.isSafeInteger(size) || size < 1 || size > 1000) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  return `pageNum=${num}&pageSize=${size}`
}

/**
 * `jubian_catalog` — catalogue, screenplay and episode reads.
 * @param client - Jubian transport.
 * @param args - Dispatched on `method`.
 * @returns The requested slice, keyed by the `method` that asked for it.
 */
export async function catalogMethod(client: JubianClient, args: MethodArgs): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'models': {
      const taskType = need(args.task_type)
      if (![TASKS.video, TASKS.image, TASKS.subtitleErasure].includes(taskType as 1 | 2 | 10)) {
        throw new JubianError('CONTRACT_CHANGED')
      }
      const result = await client.request({ method: 'GET', path: `/model/charge/getSelectList?taskType=${taskType}` })
      return { models: readModels(result.data) }
    }
    case 'rate': {
      const standardId = need(args.standard_id)
      const result = await client.request({ method: 'GET', path: `/model/charge/${standardId}` })
      return { rate: result.data }
    }
    case 'script': {
      const result = await client.request({ method: 'GET', path: `/aigc/script/${need(args.script_id)}` })
      return { script: readScript(result.data) }
    }
    case 'episodes': {
      const scriptId = need(args.script_id)
      const result = await client.request({
        method: 'GET', path: `/aigc/episode/list?scriptId=${scriptId}&${page(args)}` })
      return { episodes: readEpisodes(result.data) }
    }
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * Every asset the provider lists for one project, as identity plus declared category.
 * @param client - Jubian transport.
 * @param scriptId - The project to list.
 * @returns One entry per listed asset.
 */
async function listedAssets(client: JubianClient, scriptId: number):
Promise<{ asset_id: number; asset_type: number | null }[]> {
  const result = await client.request({ method: 'GET',
    path: `/aigc/asset/list?scriptId=${scriptId}&pageNum=1&pageSize=1000` })
  return readAssetList(result.data).rows.map(row => ({ asset_id: row.asset_id, asset_type: row.asset_type }))
}

/**
 * `jubian_asset` — asset and material reads, the state-changing casting
 * confirmation, the irreversible removal, the explicit-category registration
 * and the local reference upload.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger, used only by the two state-changing methods.
 * @param args - Dispatched on `method`.
 * @param deps - Optional seams for the local reference upload.
 * @returns The requested asset view, keyed by the `method` that asked for it.
 */
export async function assetMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs, deps: MethodDeps = {}): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'get': {
      const result = await client.request({ method: 'GET', path: `/aigc/asset/${need(args.asset_id)}` })
      return { asset: readAssetPage(result.data) }
    }
    case 'list': {
      const scriptId = need(args.script_id)
      const result = await client.request({ method: 'GET', path: `/aigc/asset/list?scriptId=${scriptId}&${page(args)}` })
      return { assets: readAssetList(result.data) }
    }
    case 'materials': {
      const scriptId = need(args.script_id)
      const result = await client.request({
        method: 'GET', path: `/aigc/material/list?scriptId=${scriptId}&isUsed=1&pageNum=1&pageSize=1000` })
      return { materials: readMaterialList(result.data) }
    }
    case 'generated_image': {
      const assetId = need(args.asset_id)
      const result = await client.request({
        method: 'GET', path: `/aigc/material/getGeneratedImageByAssetId?assetId=${assetId}` })
      return { image: readGeneratedImage(result.data) }
    }
    case 'confirm_casting': {
      requireKey(args.idempotency_key)
      const materialId = need(args.material_id)
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'confirm_casting', () => undefined,
        () => client.request({ method: 'GET', path: `/aigc/material/confirm/${materialId}` }))
      return { ...result }
    }
    case 'remove': {
      requireKey(args.idempotency_key)
      const assetId = need(args.asset_id)
      const scriptId = need(args.script_id)
      // Captured from the workbench: a DELETE with no body, and two query
      // parameters the contract does not mention. `isParent=1` scopes the removal
      // to the parent asset, which is what removing a subject-setting entry is.
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'asset_remove', () => undefined,
        () => client.request({ method: 'DELETE',
          path: `/aigc/asset/removeAsset/${assetId}?scriptId=${scriptId}&isParent=1` }))
      return { ...result,
        next: '删除不可恢复：该父资产及其媒体版本已被移除，引用它的镜头匹配与已生成视频不会因此重建。'
          + '如果只是想取消"正式选用"，那不该调用它。' }
    }
    case 'register': {
      requireKey(args.idempotency_key)
      const scriptId = need(args.script_id)
      const assetName = need(args.asset_name)
      const assetType = need(args.asset_type)
      const assetUrl = need(args.asset_url)
      if (assetType !== 1 && assetType !== 2 && assetType !== 3) {
        throw new JubianError('INVALID_ARGUMENT', 'asset_type 必须是 1（角色）、2（场景）或 3（道具）')
      }
      // The provider's own upload-register branch: an existing image URL plus
      // `isLocal`, and deliberately no modelConfig and no isGenerate, which is
      // what keeps this off the paid generation path. The captured request and
      // its reasoning are in the project's `_probe/asset-category-fix-plan.md`.
      const before = await listedAssets(client, scriptId)
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'asset_register',
        () => ({ scriptId, assetName, assetType, isLocal: 1, url: assetUrl }),
        payload => client.request({ method: 'POST', path: '/aigc/asset', body: need(payload) }))
      if (result.replayed) {
        return { ...result, created_asset_id: null, new_asset_ids: [],
          next: '同一个 idempotency_key 已经登记过，没有重发。用 jubian_asset list 按名字核对那条资产的类别。' }
      }
      // Identity comes from the list rather than the response body: the capture
      // records the request, not a response shape to depend on.
      const created = (await listedAssets(client, scriptId))
        .filter(asset => !before.some(seen => seen.asset_id === asset.asset_id) && asset.asset_type === assetType)
      return { ...result,
        created_asset_id: created.length === 1 ? created[0]?.asset_id ?? null : null,
        new_asset_ids: created.map(asset => asset.asset_id),
        next: created.length === 1
          ? '新资产已登记：它引用你给的图片地址，没有触发生成。费用与状态以账户账单为准，不要仅凭本结果断言免费。'
            + '让它进入主体设定还需要一步确认（jubian_asset confirm_casting 要的是生成材质 ID）。'
          : '登记请求已受理，但列表里无法唯一确定新资产：用 jubian_asset list 按名字人工核对类别。' }
    }
    case 'upload_reference':
      // Free and task-free, but it does write one object into the provider's
      // bucket: the URL it returns is the only shape `gpt-image-2` accepts.
      return await uploadReferenceMethod({ image_path: args.image_path }, deps.reference)
    case 'create_folder':
      return await createFolderMethod(client, ledger, args)
    case 'move':
      return await moveMethod(client, ledger, args)
    case 'rename':
      return await renameMethod(client, ledger, args, deps)
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_video` — video task reads, the paid image generation and the upscale.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger, used by every state-changing method here.
 * @param args - Dispatched on `method`.
 * @param deps - Optional seams for the paid image path: the pinned catalogue row and the readback budget.
 * @returns The requested video view, keyed by the `method` that asked for it.
 */
export async function videoMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs, deps: MethodDeps = {}): Promise<Record<string, unknown>> {
  switch (args.method) {
    case 'unresolved': {
      // Local only, no network: what a restart must reconcile before anything else
      // is sent. An open record is an intent that never settled or a provider answer
      // that was not success, and neither may be resolved by sending again.
      const records = await ledger.unresolved(args.script_id)
      return {
        unresolved: records.map(record => ({
          record_id: record.record_id,
          idempotency_key: record.idempotency_key,
          method: record.method,
          script_id: record.script_id,
          at: record.at,
          outcome: record.outcome ?? 'unsettled',
        })),
        next: records.length === 0
          ? '账本里没有未完成的写入：没有需要重新对账的收费调用。'
          : `有 ${String(records.length)} 笔写入没有确定结果。对账方式按 method 区分：`
            + 'storyboard_native_submit 用同一个 idempotency_key 再调一次 submit_video（只重新对账，不会再发 PUT）；'
            + 'storyboard_generate 用 jubian_storyboard get 回读该分镜的 isGenerate；'
            + 'image_generate 用 jubian_asset list/get 回读资产；'
            + 'erase_subtitle 与 video_upscale 用 jubian_video subtasks 回读该任务。'
            + '**任何情况下都不要换 key 重发**：没有远端证据就保持未知。',
      }
    }
    case 'task': {
      const result = await client.request({ method: 'GET', path: `/admin/aigc/video/task/${need(args.task_id)}` })
      return { task: readTaskPage(result.data) }
    }
    case 'tasks': {
      const scriptId = need(args.script_id)
      const num = args.page_num ?? 1
      const result = await client.request({
        method: 'GET', path: `/admin/aigc/video/task/list?scriptId=${scriptId}&taskType=1&pageNum=${num}` })
      return { tasks: readTaskList(result.data) }
    }
    case 'subtasks': {
      // A POST that only reads: the query body carries the parent task id.
      const result = await client.request({ method: 'POST', path: '/admin/aigc/video/task/sub/list',
        body: { aigcVideoTaskId: need(args.task_id) } })
      const page = readSubtaskPage(result.data)
      // Resolution comparison is a hint, not authorization for paid processing.
      const target = args.delivery_resolution
      return {
        subtasks: { ...page, rows: page.rows.map(row => ({ ...row,
          needs_upscale: target === undefined ? null : needsUpscale(row, target),
          delivery_resolution: target ?? null })) },
        guidance: (target === undefined
          ? '未指定 delivery_resolution：无法判断哪些结果低于交付分辨率。'
          : `交付分辨率 ${target}。`)
          + 'needs_upscale=true 仅提示实际分辨率低于交付尺寸，不是内容不可用判定，也不构成付费义务。'
          + 'SD2.5 默认使用原片，不自动提交或等待高清；任何模型都不能仅因 needs_upscale=true 自动付费。'
          + '仅在用户明确要求或授权具体高清处理时调用 upscale（包括 SD2.5）。'
          + '普通导出尺寸与真实源分辨率须分别如实报告；本地缩放不等于恢复源画质。'
          + '已授权提交的去字幕与转高清都是异步任务，提交后先做别的，稍后再查。',
      }
    }
    case 'image_generate': {
      requireKey(args.idempotency_key)
      const selection = deps.image?.selection ?? {}
      const naming = deps.naming ?? resolveNaming()
      // The category decides both the name's middle segment and the library the
      // asset lands in. `asset_type` stays accepted for callers that predate the
      // category, but the two must agree: an asset whose name says 场景 and whose
      // type says 角色 is the exact defect this pairing removes.
      const assetCategory = args.asset_category
      const derivedType = assetCategory === undefined ? undefined : ASSET_CATEGORY_TYPES[assetCategory]
      if (assetCategory !== undefined && args.asset_type !== undefined
        && args.asset_type !== derivedType) {
        throw new JubianError('INVALID_ARGUMENT',
          `asset_type=${args.asset_type} 与 asset_category=${assetCategory}（应为 ${derivedType}）不一致`)
      }
      const assetType = derivedType ?? need(args.asset_type, 'asset_type 或 asset_category')
      // A caller that names the episode gets the convention's own asset name;
      // one that does not gets its `asset_name` byte for byte, so an existing
      // call keeps meaning exactly what it meant.
      const assetName = args.episode === undefined
        ? need(args.asset_name)
        : composedAssetName(args.episode, need(assetCategory, 'asset_category'), need(args.asset_name), naming)
      // The catalogue read lives behind a thunk: a replayed key must not even
      // read the provider, let alone write to it. It is fetched at most once and
      // reused by the body, the selectors and the quote.
      let cached: ClientResponse | undefined
      const catalogue = async (): Promise<unknown> => {
        cached ??= await client.request({
          method: 'GET', path: `/model/charge/getSelectList?taskType=${TASKS.image}` })
        return cached.data
      }
      let selectors: ImageModelSelectors | undefined
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'image_generate',
        async () => {
          const rows = await catalogue()
          selectors = resolveImageModel(rows, selection)
          return buildImageRequest({ scriptId: need(args.script_id), assetName,
            assetType, prompt: need(args.prompt), references: args.references ?? [],
            ...(args.parent_asset_id === undefined ? {} : { parentAssetId: args.parent_asset_id }) }, rows, selection)
        },
        body => client.request({ method: args.parent_asset_id === undefined ? 'POST' : 'PUT',
          path: '/aigc/asset', body: need(body) }),
        () => {
          const price = readImageDisplayPrice(cached?.data, selection)
          return { ...(price.status === 'available' ? { amount: String(price.unit_price) } : {}),
            observedAt: new Date().toISOString() }
        }, { scriptId: need(args.script_id) })
      const assetId = result.data === null || result.data === undefined || !Number.isSafeInteger(Number(result.data))
        ? null : Number(result.data)
      const readback = result.replayed
        ? unread('replayed', '这个 idempotency_key 已有记录：本次没有发送请求，也没有回读资产。'
          + '用 jubian_asset get/list 读取该资产，再用 generated_image 确认生成图。')
        : result.outcome === 'accepted'
          ? await awaitGeneratedImage(client, assetId, deps.image ?? {})
          : unread('unverified', '受理结果不是 accepted，无法确认资产是否真的创建；'
            + '先回读 jubian_asset list，不要换 key 重投。')
      return { replayed: result.replayed, outcome: result.outcome, response_sha256: result.response_sha256,
        parent_asset_id: assetId,
        resolution: selectors?.resolution ?? '',
        // Which catalogue row was actually bought from, echoed so a price can never
        // be attributed to the wrong platform.
        model_selection: selectors === undefined ? null
          : { standard_id: selectors.standardId, platform_id: selectors.platformId },
        asset_status: readback.status, material_id: readback.material_id, image_url: readback.image_url,
        observed_asset_status: readback.observed_status, waited_ms: readback.waited_ms,
        readback_error: readback.error,
        next: imageNext(readback) }
    }
    case 'upscale': {
      requireKey(args.idempotency_key)
      const taskId = need(args.task_id)
      // The project is only known after the task row is read, so the body records it
      // for the budget gate; the quote thunk below runs after the body and hands it on.
      let projectId: number | undefined
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'video_upscale',
        async () => {
          // The upscale body needs identities the provider splits across two
          // reads: the parent task carries the episode, the child result carries
          // the source identities and duration.
          const task = readTaskPage((await client.request({
            method: 'GET', path: `/admin/aigc/video/task/${taskId}` })).data)
          const page = readSubtaskPage((await client.request({ method: 'POST',
            path: '/admin/aigc/video/task/sub/list', body: { aigcVideoTaskId: taskId } })).data)
          const source = page.rows.find(row => row.video_url !== null) ?? page.rows[0]
          if (source === undefined) throw new JubianError('CONTRACT_CHANGED')
          const baseUrl = source.base_video_url ?? source.video_url
          if (baseUrl === null) throw new JubianError('CONTRACT_CHANGED')
          if (source.duration_seconds === null) throw new JubianError('CONTRACT_CHANGED')
          projectId = need(task.script_id ?? args.script_id, 'script_id')
          return buildVideoUpscaleRequest({
            scriptId: projectId,
            episodeId: need(task.episode_id ?? undefined),
            episodeCount: task.episode_count ?? 1,
            firstResultId: need(source.first_result_id ?? source.subtask_id),
            parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
            duration: source.duration_seconds,
            videoUrl: baseUrl,
            taskName: args.task_name
              ?? `${stagePrefix(args, deps.naming)}${task.task_name ?? `task-${taskId}`}-高清转换`,
          })
        },
        sent => client.request({ method: 'POST', path: '/aigc/storyboard/hdConversion', body: need(sent) }),
        () => (projectId === undefined ? undefined : { scriptId: projectId }))
      // Upscaling is asynchronous and was measured taking minutes, so this
      // returns the submission rather than waiting for the result.
      return { ...result, accepted_task_id: result.data === undefined ? null : readUpscaleTaskId({ data: result.data }),
        next: '转高清是异步任务，会持续数分钟到十几分钟。不要在这里等待——先做别的，'
          + '之后再用 subtasks 回读该任务的 hd_count / last_task_type / resolution 判断是否转好。' }
    }
    case 'retry': {
      requireKey(args.idempotency_key)
      const taskId = need(args.task_id)
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'video_task_retry',
        async () => {
          // The retry service can change a child result's state before it answers
          // (`NoClassDefFoundError` after a successful re-submit), so the gate is
          // read first and from complete evidence: a retry is only sent for a
          // fully terminal failure that produced no file and no real cost.
          const task = readTaskPage((await client.request({
            method: 'GET', path: `/admin/aigc/video/task/${taskId}` })).data)
          const page = readSubtaskPage((await client.request({ method: 'POST',
            path: '/admin/aigc/video/task/sub/list', body: { aigcVideoTaskId: taskId } })).data)
          const status = (task.status ?? '').trim().toLowerCase()
          const terminalFailure = (FAILED_STATUSES as readonly string[]).includes(status)
          const settledChild = page.rows.some(row => row.video_url !== null
            || [...SUCCESS_STATUSES, ...ACTIVE_STATUSES].includes((row.status ?? '').trim().toLowerCase()))
          const charged = task.real_cost !== null && task.real_cost !== '0' && task.real_cost !== '0.0'
          if (!terminalFailure || settledChild || charged) throw new JubianError('CONTRACT_CHANGED')
          return undefined
        },
        () => client.request({ method: 'POST', path: `/admin/aigc/video/task/retry/${taskId}` }))
      return { ...result,
        next: '重试是服务端状态变更：只在父子任务都已终止失败、没有结果 URL、也没有真实费用时才会发出。'
          + '重试响应异常时不要盲目重提——先回读父任务与生成子素材：子素材已有成功 URL 就按成功处理，'
          + '子素材仍在活动就继续等待，不删除、不创建替代任务。' }
    }
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_storyboard` — storyboard reads, the free saves, the paid generation,
 * the erasure and the storyboard-native video channel.
 *
 * `save` and `generate` both work by reading the provider's own snapshot and
 * changing exactly one field, so every field the provider owns survives the
 * round trip and a caller never composes a full storyboard body.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - Dispatched on `method`.
 * @param deps - Optional seams; the naming convention drives the `erase_subtitle` task name.
 * @returns The requested storyboard view, keyed by the `method` that asked for it.
 */
export async function storyboardMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs, deps: MethodDeps = {}): Promise<Record<string, unknown>> {
  const storyboardId = (): number => need(args.storyboard_id)
  switch (args.method) {
    case 'get': {
      const result = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId()}` })
      return { storyboard: readStoryboard(result.data, storyboardId()) }
    }
    case 'create': {
      requireKey(args.idempotency_key)
      if (args.body !== undefined && args.body_path !== undefined) throw new JubianError('INVALID_ARGUMENT')
      let body = args.body
      if (args.body_path !== undefined) {
        let parsed: unknown
        try { parsed = JSON.parse(await readFile(resolve(args.body_path), 'utf8')) as unknown }
        catch { throw new JubianError('INVALID_ARGUMENT') }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JubianError('INVALID_ARGUMENT')
        body = parsed as Record<string, unknown>
      }
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'storyboard_create', () => ({ ...need(body), isGenerate: 0 }),
        sent => client.request({ method: 'POST', path: '/aigc/storyboard', body: need(sent) }))
      return { ...result }
    }
    case 'save': {
      requireKey(args.idempotency_key)
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'storyboard_save',
        () => undefined,
        async () => {
          const current = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId()}` })
          return client.request({ method: 'PUT', path: '/aigc/storyboard',
            body: withGenerationDisabled(current.data) })
        })
      return { ...result }
    }
    case 'generate': {
      requireKey(args.idempotency_key)
      // The body reads the project before the budget check; the send step may
      // reach the paid PUT only after the project's authorization passes.
      let projectId: number | undefined
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'storyboard_generate',
        async () => {
          const current = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId()}` })
          projectId = positiveInteger((current.data as { scriptId?: unknown } | null)?.scriptId)
          return withGenerationEnabled(current.data, need(args.content_duration_ms))
        },
        body => client.request({ method: 'PUT', path: '/aigc/storyboard', body: need(body) }),
        () => (projectId === undefined ? undefined : { scriptId: projectId }))
      return { ...result }
    }
    case 'select_assets': {
      requireKey(args.idempotency_key)
      return await selectAssetsMethod(client, ledger, { storyboard_id: args.storyboard_id,
        selections: args.selections, idempotency_key: args.idempotency_key })
    }
    case 'prepare_video':
      // Free and read-only on the provider: the only write is the local preview.
      return await prepareVideoMethod(client, { storyboard_id: args.storyboard_id,
        project_dir: args.project_dir, content_duration_ms: args.content_duration_ms })
    case 'submit_video': {
      requireKey(args.idempotency_key)
      return await submitVideoMethod(client, ledger, { preview_path: args.preview_path,
        project_dir: args.project_dir, storyboard_id: args.storyboard_id,
        idempotency_key: args.idempotency_key })
    }
    case 'erase_subtitle': {
      requireKey(args.idempotency_key)
      const taskId = need(args.task_id)
      // Read from the task row by the body below; the quote thunk passes it to the
      // budget gate, which cannot ask for a project the caller never states.
      let projectId: number | undefined
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'erase_subtitle',
        async () => {
          // Identities come from the provider, split across two reads. The
          // rectangle is derived from the source frame rather than drawn by the
          // caller: the workbench scales its preview canvas into video
          // coordinates in a way no caller can reproduce.
          const task = readTaskPage((await client.request({
            method: 'GET', path: `/admin/aigc/video/task/${taskId}` })).data)
          const page = readSubtaskPage((await client.request({ method: 'POST',
            path: '/admin/aigc/video/task/sub/list', body: { aigcVideoTaskId: taskId } })).data)
          const source = page.rows.find(row => row.video_url !== null) ?? page.rows[0]
          if (source === undefined) throw new JubianError('CONTRACT_CHANGED')
          const baseUrl = source.base_video_url ?? source.video_url
          if (baseUrl === null) throw new JubianError('CONTRACT_CHANGED')
          if (source.duration_seconds === null) throw new JubianError('CONTRACT_CHANGED')
          projectId = need(task.script_id ?? args.script_id, 'script_id')
          return buildSubtitleEraseRequest(need(args.model_id, 'model_id'), {
            scriptId: projectId,
            episodeId: need(task.episode_id ?? undefined),
            episodeCount: task.episode_count ?? 1,
            taskName: args.task_name
              ?? `${stagePrefix(args, deps.naming)}${task.task_name ?? `task-${taskId}`}-去字幕`,
            firstResultId: need(source.first_result_id ?? source.subtask_id),
            parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
            videoUrl: baseUrl,
            duration: source.duration_seconds,
            videoWidth: need(args.video_width),
            videoHeight: need(args.video_height),
            ...(args.subtitle_box === undefined ? {} : { subtitleBox: args.subtitle_box }),
          })
        },
        sent => client.request({ method: 'POST', path: '/aigc/storyboard/subtitleEraser', body: need(sent) }),
        () => (projectId === undefined ? undefined : { scriptId: projectId }))
      return { ...result, accepted_task_id: readSubtitleTaskId({ code: 200, data: result.data }),
        next: '去字幕是异步任务。不要在这里等待——先做别的，之后用 subtasks 回读；只有 subtitle_erased=true 且 video_url 有值才表示当前文件已有成功的去字幕记录。' }
    }
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_media` — download provider media bytes to a local file for inspection.
 *
 * The bytes never enter a tool result: a result carrying tens of megabytes of
 * base64 would poison every later request's context. This method writes the file
 * and returns its path, size and digest, and a caller then reads that path with
 * its own image or frame-extraction tool.
 *
 * The write goes through Node's filesystem rather than the harness `fs` service,
 * which exposes only `writeText` and has no binary write. Jubian's CDN needs no
 * credential, so this sends none.
 * @param args - `media_url`, `media_kind` and `output_path` are required.
 * @returns The written file's path, kind, media type, byte length and digest.
 */
export async function mediaMethod(args: MethodArgs): Promise<Record<string, unknown>> {
  const kind = need(args.media_kind)
  const downloaded = await downloadMedia(need(args.media_url), { kind })
  const target = resolve(need(args.output_path))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, downloaded.bytes)
  return { path: target, kind: downloaded.kind, media_type: downloaded.media_type,
    bytes: downloaded.bytes.byteLength, sha256: downloaded.sha256 }
}
