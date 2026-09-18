/**
 * Every Jubian tool method, as a plain async function over an injected client.
 *
 * Write methods run under the ledger and require the caller's `idempotency_key`:
 * a key that already has a record returns that record instead of sending a
 * second paid request, which is the only honest answer to "did that timeout
 * already charge me?".
 *
 * Read methods never touch the ledger. Two of them are worth naming here
 * because their HTTP verbs lie: `subtasks` is a POST that only reads, and
 * `confirm_casting` is a GET that changes provider state.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { JubianClient, JubianLedger, JubianLedgerMethod, JubianResponse } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import {
  MODEL_TASK_TYPES as TASKS, buildImageRequest, buildSubtitleEraseRequest, buildVideoUpscaleRequest,
  downloadMedia, readAssetList, readAssetPage, readEpisodes, readGeneratedImage, readImageDisplayPrice,
  readMaterialList, readModels, readScript, readStoryboard, readSubtaskPage, readTaskList, readTaskPage,
  readSubtitleTaskId, readUpscaleTaskId, needsUpscale, resolveImageModel, withGenerationDisabled,
  withGenerationEnabled, AUTOMATIC_ERASE_MODEL,
} from '@deepseek-ai/dsh-jubian-api'
import type { MediaKind } from '@deepseek-ai/dsh-jubian-api'

/** Arguments as the tool layer receives them, already schema-validated. */
export interface MethodArgs {
  method: string
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
  media_url?: string
  media_kind?: MediaKind
  output_path?: string
  /** The resolution the caller intends to deliver, e.g. `1080p`; drives the needs_upscale verdict. */
  delivery_resolution?: string
}

/** What one ledger-guarded write produced. */
export interface WriteOutcome {
  replayed: boolean
  outcome: 'accepted' | 'unknown'
  response_sha256: string | null
  data: unknown
}

/** One provider response, as the transport returns it. */
type ClientResponse = JubianResponse

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new JubianError('CONTRACT_CHANGED')
  return value
}

/**
 * Reject a write that carries no usable idempotency key.
 *
 * Every write method calls this before its first network request, including the
 * reads that compile its body: a missing key must fail without spending even a
 * read. The key is never generated here — a generated key would let a retry
 * after an ambiguous outcome bypass the record of the first attempt.
 * @param value - Caller-supplied key.
 */
function requireKey(value: string | undefined): void {
  if (typeof value !== 'string' || !value.trim()) throw new JubianError('CONTRACT_CHANGED')
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
 * Canonical hash of a request body, so the ledger can tell two attempts apart.
 * @param body - The exact body about to be sent, or undefined for a bodyless write.
 * @returns The `sha256:`-prefixed hash of the body's canonical JSON.
 */
export function bodyHash(body: Record<string, unknown> | undefined): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')}`
}

/**
 * Run one write method under the two-phase ledger.
 *
 * The intent line lands before the request leaves; the settle line lands after
 * the response is read. A replayed key returns the recorded outcome and sends
 * nothing at all.
 *
 * `body` is an async thunk on purpose, and it is awaited. Some bodies can only be
 * compiled by reading the provider first — an image request needs its selectors
 * from the live catalogue — and that read must not happen for a key already
 * recorded. Building the body lazily is what makes "replayed" mean zero network
 * requests rather than one, and awaiting it is what lets the quote below observe
 * what that read returned.
 * @param ledger - The write-path ledger.
 * @param idempotencyKey - Caller-supplied key; required, never generated here.
 * @param method - Ledger method name.
 * @param body - Computes the exact body about to be sent, or undefined for a bodyless write.
 * @param send - Performs the single request, receiving the computed body.
 * @param quote - Optional quote snapshot, observed after the body is built.
 * @returns The outcome, whether it was replayed, and any envelope data.
 */
export async function writeUnderLedger(
  ledger: JubianLedger,
  idempotencyKey: string | undefined,
  method: JubianLedgerMethod,
  body: () => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined,
  send: (body: Record<string, unknown> | undefined) => Promise<{
    transport: { http_status: number | null; application_code: number | null }
    response_sha256: string | null
    data: unknown
  }>,
  quote?: () => { amount?: string; standardId?: number; observedAt?: string } | undefined,
): Promise<WriteOutcome> {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new JubianError('CONTRACT_CHANGED')
  }
  const existing = await ledger.find(idempotencyKey)
  if (existing !== undefined) {
    return { replayed: true, outcome: existing.outcome ?? 'unknown', response_sha256: existing.response_sha256, data: null }
  }
  // Awaited on purpose: a body may be compiled from a provider read, and the
  // quote below observes what that read returned.
  const payload = await body()
  const quoted = quote?.()
  await ledger.begin({ idempotencyKey, method, requestSha256: bodyHash(payload),
    ...(quoted?.amount === undefined ? {} : { quotedAmount: quoted.amount }),
    ...(quoted?.standardId === undefined ? {} : { quoteStandardId: quoted.standardId }),
    ...(quoted?.observedAt === undefined ? {} : { quoteObservedAt: quoted.observedAt }) })
  try {
    const response = await send(payload)
    const code = response.transport.application_code
    const http = response.transport.http_status
    const outcome = http !== null && http >= 200 && http < 300 && (code === 0 || code === 200) ? 'accepted' : 'unknown'
    await ledger.settle(idempotencyKey, { httpStatus: http, applicationCode: code,
      responseSha256: response.response_sha256, outcome })
    return { replayed: false, outcome, response_sha256: response.response_sha256, data: response.data }
  } catch (error) {
    // The provider may have applied the change; only readback can resolve this.
    await ledger.settle(idempotencyKey, { httpStatus: null, applicationCode: null, responseSha256: null, outcome: 'unknown' })
    throw error
  }
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
 * `jubian_asset` — asset and material reads plus the state-changing casting confirmation.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger, used only by `confirm_casting`.
 * @param args - Dispatched on `method`.
 * @returns The requested asset view, keyed by the `method` that asked for it.
 */
export async function assetMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs): Promise<Record<string, unknown>> {
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
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_video` — video task reads plus the paid image generation.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger, used only by `image_generate`.
 * @param args - Dispatched on `method`.
 * @returns The requested video view, keyed by the `method` that asked for it.
 */
export async function videoMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs): Promise<Record<string, unknown>> {
  switch (args.method) {
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
      // A caller states the resolution it intends to deliver; every result below
      // it is flagged as requiring the upscale stage before use, so a lower
      // resolution can never be delivered silently.
      const target = args.delivery_resolution
      return {
        subtasks: { ...page, rows: page.rows.map(row => ({ ...row,
          needs_upscale: target === undefined ? null : needsUpscale(row, target),
          delivery_resolution: target ?? null })) },
        guidance: target === undefined
          ? '未指定 delivery_resolution：无法判断哪些结果低于交付分辨率。'
            + '给出交付分辨率后，needs_upscale=true 的结果必须先转高清才能使用。'
          : `交付分辨率 ${target}。needs_upscale=true 的结果低于交付分辨率，必须先转高清`
            + '（SeedVR2 视频高清，taskType=20）才能使用；低于交付分辨率的文件不能靠改扩展名或本地转码顶替。'
            + '另：去字幕与转高清都是异步任务，提交后不要干等——先做别的，稍后再查。',
      }
    }
    case 'image_generate': {
      requireKey(args.idempotency_key)
      // The catalogue read lives behind a thunk: a replayed key must not even
      // read the provider, let alone write to it. It is fetched at most once and
      // reused by the body, the selectors and the quote.
      let cached: ClientResponse | undefined
      const catalogue = async (): Promise<unknown> => {
        cached ??= await client.request({
          method: 'GET', path: `/model/charge/getSelectList?taskType=${TASKS.image}` })
        return cached.data
      }
      let resolution = ''
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'image_generate',
        async () => {
          const rows = await catalogue()
          return buildImageRequest({ scriptId: need(args.script_id), assetName: need(args.asset_name),
            assetType: need(args.asset_type), prompt: need(args.prompt), references: args.references ?? [],
            ...(args.parent_asset_id === undefined ? {} : { parentAssetId: args.parent_asset_id }) }, rows)
        },
        async (body) => {
          const rows = await catalogue()
          resolution = resolveImageModel(rows).resolution
          return client.request({ method: args.parent_asset_id === undefined ? 'POST' : 'PUT',
            path: '/aigc/asset', body: need(body) })
        },
        () => {
          const price = readImageDisplayPrice(cached?.data)
          return { ...(price.status === 'available' ? { amount: String(price.unit_price) } : {}),
            observedAt: new Date().toISOString() }
        })
      return { replayed: result.replayed, outcome: result.outcome, response_sha256: result.response_sha256,
        parent_asset_id: result.data === null || result.data === undefined ? null : Number(result.data),
        resolution }
    }
    case 'upscale': {
      requireKey(args.idempotency_key)
      const taskId = need(args.task_id)
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
          return buildVideoUpscaleRequest({
            scriptId: need(args.script_id),
            episodeId: need(task.episode_id ?? undefined),
            episodeCount: task.episode_count ?? 1,
            firstResultId: need(source.first_result_id ?? source.subtask_id),
            parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
            duration: source.duration_seconds,
            videoUrl: baseUrl,
            taskName: args.task_name ?? `${task.task_name ?? `task-${taskId}`}-高清转换`,
          })
        },
        sent => client.request({ method: 'POST', path: '/aigc/storyboard/upscale', body: need(sent) }))
      // Upscaling is asynchronous and was measured taking minutes, so this
      // returns the submission rather than waiting for the result.
      return { ...result, accepted_task_id: result.data === undefined ? null : readUpscaleTaskId({ data: result.data }),
        next: '转高清是异步任务，会持续数分钟到十几分钟。不要在这里等待——先做别的，'
          + '之后再用 subtasks 回读该任务的 hd_count / last_task_type / resolution 判断是否转好。' }
    }
    default:
      throw new JubianError('CONTRACT_CHANGED')
  }
}

/**
 * `jubian_storyboard` — storyboard reads, the free saves, the paid generation and the erasure.
 *
 * `save` and `generate` both work by reading the provider's own snapshot and
 * changing exactly one field, so every field the provider owns survives the
 * round trip and a caller never composes a full storyboard body.
 * @param client - Jubian transport.
 * @param ledger - Write-path ledger.
 * @param args - Dispatched on `method`.
 * @returns The requested storyboard view, keyed by the `method` that asked for it.
 */
export async function storyboardMethod(client: JubianClient, ledger: JubianLedger,
  args: MethodArgs): Promise<Record<string, unknown>> {
  const storyboardId = (): number => need(args.storyboard_id)
  switch (args.method) {
    case 'get': {
      const result = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId()}` })
      return { storyboard: readStoryboard(result.data, storyboardId()) }
    }
    case 'create': {
      requireKey(args.idempotency_key)
      const body = need(args.body)
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'storyboard_create', () => body,
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
      const result = await writeUnderLedger(ledger, args.idempotency_key, 'storyboard_generate',
        () => undefined,
        async () => {
          const current = await client.request({ method: 'GET', path: `/aigc/storyboard/${storyboardId()}` })
          return client.request({ method: 'PUT', path: '/aigc/storyboard',
            body: withGenerationEnabled(current.data, need(args.content_duration_ms)) })
        })
      return { ...result }
    }
    case 'erase_subtitle': {
      requireKey(args.idempotency_key)
      const taskId = need(args.task_id)
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
          return buildSubtitleEraseRequest(args.model_id ?? AUTOMATIC_ERASE_MODEL, {
            scriptId: need(args.script_id),
            episodeId: need(task.episode_id ?? undefined),
            episodeCount: task.episode_count ?? 1,
            taskName: args.task_name ?? `${task.task_name ?? `task-${taskId}`}-去字幕`,
            firstResultId: need(source.first_result_id ?? source.subtask_id),
            parentResultId: source.parent_result_id ?? source.first_result_id ?? source.subtask_id,
            videoUrl: baseUrl,
            duration: source.duration_seconds,
            videoWidth: need(args.video_width),
            videoHeight: need(args.video_height),
            ...(args.subtitle_box === undefined ? {} : { subtitleBox: args.subtitle_box }),
          })
        },
        sent => client.request({ method: 'POST', path: '/aigc/storyboard/subtitleEraser', body: need(sent) }))
      return { ...result, accepted_task_id: readSubtitleTaskId({ code: 200, data: result.data }),
        next: '去字幕是异步任务。不要在这里等待——先做别的，之后用 subtasks 回读 last_task_type=10 判断是否完成。' }
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
