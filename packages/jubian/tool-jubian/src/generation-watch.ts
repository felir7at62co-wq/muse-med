/** Host-owned read-only continuation of native video generation. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { JubianError, type JubianClient, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { reconcileRecordedVideo } from './native.ts'
import { observeWatchTask, type WatchConfig } from './watch.ts'
import { createGenerationWatchNotice, type GenerationNoticeDelivery } from './generation-watch-delivery.ts'
import type { GenerationWatchGroupOrigin, GenerationWatchNotice, GenerationWatchPack, GenerationWatchRun, GenerationWatchStore } from './generation-watch-store.ts'

type PackIntent = Pick<GenerationWatchPack, 'key' | 'previewPath'>

interface GenerationWatchOptions extends WatchConfig {
  store: GenerationWatchStore
  client: JubianClient
  ledger: JubianLedger
  deliver: (sessionId: SessionId, notice: GenerationWatchNotice, signal: AbortSignal,
    groupOrigin?: GenerationWatchGroupOrigin, groupReceiptId?: string) => Promise<GenerationNoticeDelivery>
  withoutInitiator: (operation: () => Promise<void>) => Promise<void>
  warn: (message: string, error: unknown) => void
}

function taskId(value: unknown): number | undefined {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

function receiptRows(report: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(report.results)) return [report]
  return report.results.filter((row): row is Record<string, unknown> =>
    row !== null && typeof row === 'object' && !Array.isArray(row))
}

function noticeText(run: GenerationWatchRun): string {
  const packs = run.packs.map(pack => ({ idempotency_key: pack.key, task_id: pack.taskId,
    status: pack.outcome?.status, detail: pack.outcome?.detail,
    subtask_ids: pack.outcome?.outputs?.map(output => output.subtask_id) }))
  return '剧变分包后台查询已结束。请沿本集已有制作范围继续处理，无需等待用户再发继续。'
    + ' succeeded 仅证明远端任务及子结果已核实。用 jubian_video subtasks 核对，再用 jubian_media download resume=true 下载实际产物并审片。'
    + ' failed/unverified 只做原 key 对账，不重提付费。仅在本集所有应有分包核实后才进入整集合成。'
    + `\n${JSON.stringify(packs)}`
}

function recoveryText(original: GenerationWatchNotice): string {
  return '上次处理本集时宿主中断。先核对本会话已记录的下载、审片、时间线、渲染和草稿回执及现存文件，再从首个未核实步骤继续。'
    + '核对原任务与子结果身份、文件字节和本集来源。下载使用 jubian_media download resume=true，匹配原目标路径与 URL。'
    + '用原参数和工作输出路径重跑 drama_render render resume=true，读取本次返回的 output；同一请求的有效成片会先复验再复用。'
    + '渲染成品缺来源记录或核对不符时保留旧文件，另存候选并复验。'
    + '核对本集完整包清单后才能交付，继续沿原 key 只读对账，禁止重复提交付费生成。\n' + original.text
}

/** Restores enrolled batches and resumes them without waiting for a user message. */
export class GenerationWatchRuntime {
  private readonly dispatching = new Map<string, readonly string[]>()
  private readonly advancing = new Set<string>()
  private readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private processing: Promise<void> | undefined

  /** @param options - Storage, existing read transport, timing, and durable session delivery. */
  constructor(private readonly options: GenerationWatchOptions) {}

  /** Arm polling for both newly submitted and restored runs. */
  start(): void {
    this.arm(0)
  }

  /** Abort active reads and wait for storage or notification already in progress. */
  async close(): Promise<void> {
    this.controller.abort()
    clearTimeout(this.timer)
    await this.processing
  }

  /**
   * Save the original intent before the normal paid tool path can send any PUT.
   * @param sessionId - Owning production session.
   * @param packs - Frozen previews and original idempotency keys.
   * @param groupOrigin - Optional original room assignment captured by the group Host.
   * @returns Run id and whether this invocation owns its initial dispatch.
   */
  async enroll(sessionId: SessionId, packs: readonly PackIntent[],
    groupOrigin?: GenerationWatchGroupOrigin): Promise<{ id: string; initial: boolean; groupExchangeId?: string }> {
    this.controller.signal.throwIfAborted()
    const keys = packs.map(pack => pack.key).sort()
    let id = createHash('sha256').update(JSON.stringify([sessionId, keys])).digest('hex')
    if ([...this.dispatching.values()].some(active => active.some(key => keys.includes(key)))) {
      throw new Error('A matching generation dispatch is already in progress. Wait for its original receipt.')
    }
    this.dispatching.set(id, keys)
    try {
      let prior = await this.options.store.load(id)
      while (prior?.notice && prior.notice.deliveredAt !== undefined && prior.packs.every(pack => pack.taskId === undefined)
        && !await this.allRecorded(keys)) {
        // A rejected preflight can be explicitly corrected and retried by the caller.
        // Keep the prior receipt and give the new tool invocation a new watch.
        this.dispatching.delete(id)
        id = createHash('sha256').update(`${id}:${prior.notice.id}`).digest('hex')
        this.dispatching.set(id, keys)
        prior = await this.options.store.load(id)
      }
      if (prior?.notice || this.advancing.has(id)) {
        if (!await this.allRecorded(keys)) {
          throw new Error('Generation observation has an unsettled checkpoint for this request. Reconcile the original request first.')
        }
        this.dispatching.delete(id)
        return { id, initial: false }
      }
      const overlapping = (await this.activeRuns()).find(run => run.id !== id
        && run.packs.some(pack => keys.includes(pack.key)))
      if (overlapping) {
        if (!await this.allRecorded(keys)) throw new Error('A different generation watch owns part of this request.')
        this.dispatching.delete(id)
        return { id: overlapping.id, initial: false }
      }
      const createdAt = Date.now()
      const stored = await this.options.store.create({ id, sessionId, createdAt,
        ...(groupOrigin === undefined ? {} : { groupOrigin }),
        deadlineAt: createdAt + this.options.watchTimeoutMs, packs: packs.map(pack => ({ ...pack })) })
      const ownsGroupResult = groupOrigin !== undefined && stored.notice?.deliveredAt === undefined
        && JSON.stringify(stored.groupOrigin) === JSON.stringify(groupOrigin)
      return { id, initial: true, ...(ownsGroupResult ? { groupExchangeId: groupOrigin.exchangeId } : {}) }
    } catch (error) {
      this.dispatching.delete(id)
      throw error
    }
  }

  private async allRecorded(keys: readonly string[]): Promise<boolean> {
    const entries = await Promise.all(keys.map(key => this.options.ledger.find(key)))
    return entries.every(entry => entry?.method === 'storyboard_native_submit')
  }

  private activeRuns(): Promise<GenerationWatchRun[]> {
    return this.options.store.listActive((id, error) => this.options.warn(`Generation watch ${id} cannot be read`, error))
  }

  /**
   * Record exact task identities while preserving an original intent if readback is missing.
   * @param id - Watch run for the initial tool invocation.
   * @param report - Normal submission result, when the tool returned one.
   */
  async finishDispatch(id: string, report?: Record<string, unknown>): Promise<void> {
    try {
      const run = await this.options.store.load(id)
      if (!run) throw new Error('Original generation intent is missing')
      const rows = report ? receiptRows(report) : []
      const packs = run.packs.map((pack) => {
        const row = rows.find(value => value.idempotency_key === pack.key)
          ?? (run.packs.length === 1 && rows[0]?.idempotency_key === undefined ? rows[0] : undefined)
        const id = row?.status === 'submitted' || row?.status === 'already_submitted' ? taskId(row.task_id) : undefined
        return id === undefined ? pack : { ...pack, taskId: id }
      })
      await this.options.store.put({ ...run, packs })
    } catch (error) {
      this.options.warn('Saving generation readback failed. The original intent remains available for read-only recovery.', error)
    } finally {
      this.dispatching.delete(id)
      this.arm(0)
    }
  }

  private arm(delay: number): void {
    if (this.controller.signal.aborted || this.processing) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.processing = Promise.resolve().then(() => this.options.withoutInitiator(async () => this.tick())).catch((error: unknown) => {
        this.options.warn('Reading pending generation watches failed', error)
      }).finally(() => {
        this.processing = undefined
        this.arm(this.options.watchPollIntervalMs)
      })
    }, delay)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    for (const run of await this.activeRuns()) {
      if (this.controller.signal.aborted) return
      if (this.dispatching.has(run.id) || (run.nextPollAt ?? 0) > Date.now()) continue
      this.advancing.add(run.id)
      try { await this.advance(run) }
      catch (error) {
        if (!this.controller.signal.aborted) this.options.warn(`Generation watch ${run.id} remains pending`, error)
      } finally { this.advancing.delete(run.id) }
    }
  }

  private async advance(run: GenerationWatchRun): Promise<void> {
    let current = run
    if (!current.notice) {
      const packs = await this.readPacks(current)
      this.controller.signal.throwIfAborted()
      current = { ...current, packs, nextPollAt: Math.min(current.deadlineAt, Date.now() + this.options.watchPollIntervalMs) }
      if (packs.every(pack => pack.outcome !== undefined)) {
        current.notice = createGenerationWatchNotice(noticeText(current))
      }
      if (JSON.stringify(current) !== JSON.stringify(run)) await this.options.store.put(current)
    }
    if (current.notice) {
      this.controller.signal.throwIfAborted()
      const outcome = await this.options.deliver(current.sessionId, current.recoveryNotice ?? current.notice,
        this.controller.signal, current.groupOrigin, current.groupOrigin === undefined ? undefined : current.notice.id)
      if (outcome === 'pending') return
      if (outcome === 'interrupted' && current.recoveryNotice === undefined) {
        await this.options.store.put({ ...current, recoveryNotice: createGenerationWatchNotice(recoveryText(current.notice)) })
        return
      }
      const recoveryExhausted = outcome === 'interrupted'
      const reviewRequired = recoveryExhausted || outcome === 'needs-review'
      if (reviewRequired) this.options.warn(`Generation watch ${run.id} did not complete its continuation; episode delivery requires review`, undefined)
      await this.options.store.put({ ...current, notice: { ...current.notice, deliveredAt: Date.now() },
        ...(recoveryExhausted ? { recoveryExhausted: true as const } : {}),
        ...(reviewRequired ? { reviewRequired: true as const } : {}) })
    }
  }

  private async readPacks(run: GenerationWatchRun): Promise<GenerationWatchPack[]> {
    const { client, ledger } = this.options
    const remaining = run.deadlineAt - Date.now()
    const signal = AbortSignal.any([this.controller.signal,
      AbortSignal.timeout(remaining > 0 ? remaining : this.options.watchPollIntervalMs)])
    const packs: GenerationWatchPack[] = []
    for (const pack of run.packs) {
      if (signal.aborted || pack.taskId !== undefined || pack.outcome) { packs.push({ ...pack }); continue }
      try {
        const result = await reconcileRecordedVideo(client, ledger, {
          preview_path: pack.previewPath, idempotency_key: pack.key,
        }, signal)
        const id = result?.status === 'submitted' ? taskId(result.task_id) : undefined
        packs.push(id === undefined ? { ...pack } : { ...pack, taskId: id })
      } catch (error) {
        packs.push({ ...pack })
        this.reportReadFailure(run.id, signal, error)
      }
    }
    const counts = new Map<number, number>()
    for (const pack of packs) {
      if (pack.taskId !== undefined) counts.set(pack.taskId, (counts.get(pack.taskId) ?? 0) + 1)
    }
    for (const pack of packs) {
      if (pack.taskId === undefined) continue
      if ((counts.get(pack.taskId) ?? 0) > 1) {
        pack.outcome = { status: 'unverified', detail: 'The same provider task was matched to multiple frozen packs.' }
        continue
      }
      if (pack.outcome || signal.aborted) continue
      try {
        const result = await observeWatchTask(client, { task_id: pack.taskId, stage: 'generate' }, signal)
        if (result) pack.outcome = result.status === 'failed' ? result : {
          ...result, detail: 'Provider task and all child outputs verified. Local media review is still pending.',
        }
      } catch (error) { this.reportReadFailure(run.id, signal, error) }
    }
    return remaining > 0 ? packs : packs.map(pack => pack.outcome ? pack : {
      ...pack, outcome: { status: 'unverified', detail: 'Read-only observation expired before identity or output was verified.' },
    })
  }

  private reportReadFailure(id: string, signal: AbortSignal, error: unknown): void {
    if (!signal.aborted && !(error instanceof JubianError && ['NETWORK_ERROR', 'CONTRACT_CHANGED'].includes(error.code))) {
      this.options.warn(`Generation watch ${id} could not verify a provider read`, error)
    }
  }
}
