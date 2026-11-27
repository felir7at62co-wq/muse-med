/** Dispatch approved MediaKit pilot clips without replaying an ambiguous paid operation. */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { JubianLedger } from '@deepseek-ai/dsh-jubian'
import { JubianError } from '@deepseek-ai/dsh-jubian'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { MuseAccountService, MuseMediaPostprocessInput, MuseMediaPostprocessJobKey,
  MuseMediaPostprocessSubmission, MuseMediaPostprocessStatus } from '@deepseek-ai/dsh-muse-account'
import { z } from 'zod'
import { resumeMediaDownload } from './media-download.ts'
import { bodyHash, recordedWriteBudget, writeUnderLedger } from './write.ts'

/** Host-only MediaKit access. */
export type MediaPostprocessClient = Pick<MuseAccountService,
  'previewMediaPostprocess' | 'submitMediaPostprocess' | 'statusMediaPostprocess' | 'claimMediaPostprocessFallback'>

type PostprocessStage = MuseMediaPostprocessInput['operation']
type Decision = { route: 'jubian' }
  | { route: 'backup'; ledgerKey: string; reason: string | undefined; beforeReserve: () => Promise<void> }
  | { route: 'mediakit'; result: Record<string, unknown> }
const bindingSchema = z.object({ stage: z.enum(['upscale', 'erase_subtitle']), taskId: z.number().int().positive(),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  jobKey: z.string().regex(/^[a-f0-9]{64}$/u).transform(value => brandString<MuseMediaPostprocessJobKey>(value)) })

function bindingPath(ledger: JubianLedger, key: string) {
  return join(ledger.root, 'media-postprocess', createHash('sha256').update(key).digest('hex') + '.json')
}

/**
 * Serialize the primary and legacy paths on their shared caller key, including fallback admission.
 * @param ledger - Shared Desktop project ledger.
 * @param key - Original caller idempotency key.
 * @param run - One complete processing submission or replay.
 * @param signal - Foreground cancellation.
 * @returns The processing result.
 */
export async function withMediaPostprocessLock<T>(ledger: JubianLedger, key: string, run: () => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  await mkdir(join(ledger.root, 'media-postprocess'), { recursive: true, mode: 0o700 })
  return await withFileLock(bindingPath(ledger, key), run, signal === undefined ? undefined : { signal })
}

function mediaKitResult(jobKey: MuseMediaPostprocessJobKey,
  reported: MuseMediaPostprocessSubmission | MuseMediaPostprocessStatus,
  budget: ReturnType<typeof recordedWriteBudget>, replayed: boolean, gateway: MediaPostprocessClient,
  signal?: AbortSignal): Decision {
  if (reported.state === 'rejected') return {
    route: 'backup', ledgerKey: 'muse-mediakit-backup-' + jobKey, reason: reported.code,
    beforeReserve: async () => {
      const claimed = await gateway.claimMediaPostprocessFallback(jobKey, signal)
      if (!claimed) throw new JubianError('CONTRACT_CHANGED',
        '剧变备用提交未获网关许可。请核对原火山任务及剧变任务列表，避免重复提交。')
    },
  }
  return { route: 'mediakit', result: {
    provider: 'volcengine-mediakit', processing_job_key: jobKey, status: reported.state,
    ...('code' in reported && reported.code !== undefined ? { reason: reported.code } : {}),
    replayed, budget,
    next: '用 jubian_media status 查询这笔火山任务，完成后用 download_processed 下载。状态不明或已受理后的失败不自动重提。',
  } }
}

/**
 * Reserve the approved MediaKit estimate in the project budget before dispatch.
 * @param ledger - Project spending ledger shared with the existing Jubian route.
 * @param key - Original caller idempotency key, retained on the legacy route.
 * @param stage - Requested operation.
 * @param taskId - Jubian task identifying the source clip.
 * @param gateway - Current optional account gateway.
 * @param readInput - Read the exact Jubian media used by the corresponding legacy operation.
 * @param signal - Cancellation of foreground work.
 * @param readJubianCredential - Host-only credential resolver for official provider requests.
 * @returns The persisted primary result, or permission to enter the existing separately budgeted backup.
 */
export async function routeMediaPostprocess(ledger: JubianLedger, key: string, stage: PostprocessStage, taskId: number,
  gateway: MediaPostprocessClient | undefined, readInput: () => Promise<MuseMediaPostprocessInput>,
  signal?: AbortSignal, readJubianCredential?: () => Promise<string | undefined>): Promise<Decision> {
  const primaryKey = 'muse-mediakit-' + createHash('sha256').update(key).digest('hex')
  if (await ledger.find(key)) return { route: 'jubian' }
  const prior = await ledger.find(primaryKey)
  if (prior !== undefined) {
    if (gateway === undefined) throw new JubianError('CONTRACT_CHANGED',
      '火山原提交尚未核对，请查询原处理任务。换渠道或换 key 可能重复扣费。')
    const binding = await readFile(bindingPath(ledger, key), 'utf8')
      .then(text => bindingSchema.parse(JSON.parse(text)))
      .catch((_error: unknown) => undefined)
    if (binding === undefined || binding.stage !== stage || binding.taskId !== taskId) {
      throw new JubianError('CONTRACT_CHANGED', '无法核对该 key 的原火山任务。请保留原 key 与任务编号。')
    }
    const decision = mediaKitResult(binding.jobKey, await gateway.statusMediaPostprocess(binding.jobKey, signal),
      recordedWriteBudget(prior), true, gateway, signal)
    if (decision.route === 'backup' && await ledger.find(decision.ledgerKey) === undefined
      && bodyHash({ ...await readInput() }) !== binding.requestDigest) {
      throw new JubianError('CONTRACT_CHANGED', '原视频地址或规格已变化，不能用此前的火山拒收记录发起剧变处理。')
    }
    return decision
  }
  if (gateway === undefined) return { route: 'jubian' }
  const input = await readInput()
  const jubianToken = await readJubianCredential?.()
  signal?.throwIfAborted()
  let preview
  try {
    preview = await gateway.previewMediaPostprocess(input, signal, jubianToken)
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof HarnessError) {
      if (error.code === 'MEDIAKIT_ACCOUNT_CHANGED') throw error
      if (error.code === 'MEDIAKIT_SOURCE_UNVERIFIED') {
        throw new HarnessError('火山预检未能验证剧变源视频，请核对当前账号及原任务。', error.code)
      }
      if (error.code === 'MEDIAKIT_EXISTING_PROCESSING') {
        throw new HarnessError('此源视频已有一笔火山处理，请使用原任务编号查询。', error.code)
      }
    }
    throw new JubianError('NETWORK_ERROR', '火山接入预检不可用，继续前请确认原处理状态。')
  }
  if (preview.state !== 'ready') return { route: 'jubian' }

  const request = { ...input, jobKey: preview.jobKey }
  let submitted: MuseMediaPostprocessSubmission = { state: 'unknown' }
  const receipt = await writeUnderLedger(ledger, primaryKey, stage === 'upscale' ? 'video_upscale' : 'erase_subtitle',
    () => request, async () => {
      await writeFileAtomic(bindingPath(ledger, key),
        JSON.stringify({ stage, taskId, jobKey: preview.jobKey, requestDigest: bodyHash({ ...input }) }) + '\n', { mode: 0o600 })
      submitted = await gateway.submitMediaPostprocess(preview.defaultRouting === true
        ? { ...request, quoteAmount: preview.amount } : request, signal, jubianToken)
      return {
        transport: { http_status: 200, application_code: submitted.state === 'accepted' ? 200 : null },
        response_sha256: null, data: null,
      }
    }, () => ({ amount: preview.amount, unit: preview.unit, scriptId: input.scriptId }),
    { scriptId: input.scriptId, verifyReplayBody: true, beforeReserve: () => { signal?.throwIfAborted() } })
  const reported = receipt.replayed ? await gateway.statusMediaPostprocess(preview.jobKey, signal) : submitted
  return mediaKitResult(preview.jobKey, reported, receipt.budget, receipt.replayed, gateway, signal)
}

/**
 * Inspect an account-owned post-processing result and optionally save it privately in the workspace.
 * @param gateway - Current authenticated Host-only MediaKit client.
 * @param jobKey - Key returned by the original processing call.
 * @param outputPath - Requested local output for a finished job.
 * @param signal - Cancellation of query or download.
 * @returns Status and verified local file metadata. Signed provider URLs stay private to the Host.
 */
export async function readMediaPostprocess(gateway: MediaPostprocessClient | undefined, jobKey: string,
  outputPath?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (gateway === undefined) throw new JubianError('CONTRACT_CHANGED', '火山任务查询需要 Muse 账号网关。')
  if (!/^[a-f0-9]{64}$/u.test(jobKey)) throw new JubianError('INVALID_ARGUMENT', 'processing_job_key')
  const status = await gateway.statusMediaPostprocess(brandString<MuseMediaPostprocessJobKey>(jobKey), signal)
  const result = { provider: 'volcengine-mediakit', processing_job_key: jobKey, status: status.state,
    ...('code' in status && status.code !== undefined ? { reason: status.code } : {}) }
  if (status.state !== 'completed' || outputPath === undefined) return result
  const saved = await resumeMediaDownload(status.videoUrl, 'video', resolve(outputPath), signal, [status.downloadOrigin])
  return { ...result, ...saved }
}
