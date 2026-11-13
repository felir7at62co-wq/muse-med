/** Host-owned read-only continuation of native video generation. */
import { createHash } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerationSessionBinding } from './generation-binding.ts'
import { JubianError, type JubianClient, type JubianLedger } from '@deepseek-ai/dsh-jubian'
import { reconcileRecordedVideo } from './native.ts'
import { observeWatchTask, type WatchConfig } from './watch.ts'
import { createGenerationWatchNotice, type GenerationNoticeDelivery } from './generation-watch-delivery.ts'
import { GenerationWatchOwnershipConflict, type GenerationWatchGroupOrigin, type GenerationWatchNotice,
  type GenerationWatchPack, type GenerationWatchRun, type GenerationWatchStore } from './generation-watch-store.ts'

type PackIntent = Pick<GenerationWatchPack, 'key' | 'previewPath'>

interface GenerationWatchOptions extends WatchConfig {
  store: GenerationWatchStore
  client: JubianClient
  ledger: JubianLedger
  deliver: (sessionId: SessionId, notice: GenerationWatchNotice, signal: AbortSignal,
    groupOrigin?: GenerationWatchGroupOrigin, groupReceiptId?: string, run?: GenerationWatchRun) => Promise<GenerationNoticeDelivery>
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
  private readonly operations = new Set<Promise<unknown>>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private processing: Promise<void> | undefined
  private shutdown: Promise<void> | undefined

  /** @param options - Storage, existing read transport, timing, and durable session delivery. */
  constructor(private readonly options: GenerationWatchOptions) {}

  /** Arm polling for both newly submitted and restored runs. */
  start(): void {
    this.arm(0)
  }

  /** Abort active reads and wait for storage or notification already in progress. */
  close(): Promise<void> {
    this.controller.abort()
    clearTimeout(this.timer)
    this.shutdown ??= Promise.allSettled([...this.operations, ...(this.processing === undefined ? [] : [this.processing])])
      .then(() => {})
    return this.shutdown
  }

  private own<T>(operation: () => Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) return Promise.reject(new Error('Generation watch has closed'))
    const current = Promise.resolve().then(operation)
    this.operations.add(current)
    void current.then(() => { this.operations.delete(current) }, () => { this.operations.delete(current) })
    return current
  }

  /**
   * Save the original intent before the normal paid tool path can send any PUT.
   * @param sessionId - Owning production session.
   * @param packs - Frozen previews and original idempotency keys.
   * @param groupOrigin - Optional original room assignment captured by the group Host.
   * @param binding - Host-attested original Session, model and workspace identity for new submissions.
   * @returns Run id and whether this invocation owns its initial dispatch.
   */
  enroll(sessionId: SessionId, packs: readonly PackIntent[],
    groupOrigin?: GenerationWatchGroupOrigin, binding?: GenerationSessionBinding):
  Promise<{ id: string; initial: boolean; groupExchangeId?: string }> {
    return this.own(() => this.enrollOwned(sessionId, packs, groupOrigin, binding))
  }

  private async enrollOwned(sessionId: SessionId, packs: readonly PackIntent[],
    groupOrigin?: GenerationWatchGroupOrigin, binding?: GenerationSessionBinding):
  Promise<{ id: string; initial: boolean; groupExchangeId?: string }> {
    this.controller.signal.throwIfAborted()
    if (groupOrigin !== undefined) throw new Error('Archived Bot group ownership requires manual review')
    const keys = packs.map(pack => pack.key).sort()
    let id = createHash('sha256').update(JSON.stringify([sessionId, keys])).digest('hex')
    if ([...this.dispatching.values()].some(active => active.some(key => keys.includes(key)))) {
      throw new Error('A matching generation dispatch is already in progress. Wait for its original receipt.')
    }
    this.dispatching.set(id, keys)
    try {
      let predecessor: string | undefined
      let prior = await this.options.store.load(id)
      while (prior !== undefined && prior.packs.every(pack => pack.taskId === undefined)
        && await this.noneRecorded(keys) && await this.options.store.hasNoSend(prior.id)) {
        // A rejected preflight can be explicitly corrected and retried by the caller.
        // Keep the prior receipt and give the new tool invocation a new watch.
        predecessor = id
        this.dispatching.delete(id)
        id = createHash('sha256').update(`${id}:unsent-successor`).digest('hex')
        this.dispatching.set(id, keys)
        prior = await this.options.store.load(id)
      }
      if (prior?.reviewRequired === true) throw new Error('Generation watch ownership requires manual review')
      if (prior?.notice || this.advancing.has(id)) {
        if (prior !== undefined) await this.options.store.claimOwnership(prior, this.controller.signal)
        if (!await this.allRecorded(keys)) {
          throw new Error('Generation observation has an unsettled checkpoint for this request. Reconcile the original request first.')
        }
        this.dispatching.delete(id)
        return { id, initial: false }
      }
      let overlapping: GenerationWatchRun | undefined
      for (const active of await this.activeRuns()) {
        if (active.id !== id && active.id !== predecessor && active.packs.some(pack => keys.includes(pack.key))
          && !await this.options.store.isRetired(active.id)) { overlapping = active; break }
      }
      if (overlapping) {
        if (overlapping.sessionId !== sessionId) throw new GenerationWatchOwnershipConflict()
        await this.options.store.claimOwnership(overlapping, this.controller.signal)
        if (!await this.allRecorded(keys)) throw new Error('A different generation watch owns part of this request.')
        this.dispatching.delete(id)
        return { id: overlapping.id, initial: false }
      }
      const createdAt = Date.now()
      const candidate = { id, sessionId, createdAt,
        ...(binding === undefined ? {} : { binding }),
        deadlineAt: createdAt + this.options.watchTimeoutMs, packs: packs.map(pack => ({ ...pack })) }
      const initial = predecessor === undefined
        ? await this.options.store.claimAndCreate(candidate, this.controller.signal)
        : await this.options.store.withRecoveryLease(predecessor, this.controller.signal, this.options.watchTimeoutMs,
          async () => await this.options.store.retryUnsent(predecessor, candidate, this.controller.signal))
      this.controller.signal.throwIfAborted()
      if (!initial) {
        if (!await this.allRecorded(keys)) {
          throw new Error('Generation observation has an unsettled checkpoint for this request. Reconcile the original request first.')
        }
        this.dispatching.delete(id)
      }
      return { id: candidate.id, initial }
    } catch (error) {
      this.dispatching.delete(id)
      throw error
    }
  }

  private async noneRecorded(keys: readonly string[]): Promise<boolean> {
    return (await Promise.all(keys.map(key => this.options.ledger.find(key)))).every(entry => entry === undefined)
  }

  private async allRecorded(keys: readonly string[]): Promise<boolean> {
    const entries = await Promise.all(keys.map(key => this.options.ledger.find(key)))
    return entries.every(entry => entry?.method === 'storyboard_native_submit')
  }

  private activeRuns(): Promise<GenerationWatchRun[]> {
    return this.options.store.listActive((id, error) => { this.options.warn(`Generation watch ${id} cannot be read`, error) })
  }

  /**
   * Run the initial native submission with a durable fence before each paid request.
   * A completed invocation without a fence or ledger intent may be corrected later.
   * @param id - Run granted to this invocation by enroll().
   * @param operation - Native submission; it must await beforeSend immediately before each PUT.
   * @returns The native submission result.
   */
  executeDispatch(id: string,
    operation: (beforeSend: (key: string) => Promise<void>) => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    return this.own(async () => {
      try {
        return await this.options.store.withRecoveryLease(id, this.controller.signal,
          this.options.watchTimeoutMs, async () => {
            const keys = this.dispatching.get(id)
            if (keys === undefined) throw new Error('Generation dispatch is not owned by this invocation')
            const dispatchState = { fenced: false }
            const failures: unknown[] = []
            let report: Record<string, unknown> | undefined
            try {
              report = await operation(async (key) => {
                if (!keys.includes(key)) throw new GenerationWatchOwnershipConflict()
                dispatchState.fenced = true
                await this.options.store.markDispatchStarted(id, key)
              })
            } catch (error) { failures.push(error) }
            try {
              const records = await Promise.all(keys.map(key => this.options.ledger.find(key)))
              if (!dispatchState.fenced && records.every(record => record === undefined)) {
                await this.options.store.recordNoSend(id)
                const run = await this.options.store.load(id)
                if (run === undefined) throw new GenerationWatchOwnershipConflict()
                const packs = run.packs.map(pack => ({ ...pack, outcome: { status: 'unverified' as const,
                  detail: 'Preflight finished before any paid video request was sent' } }))
                await this.options.store.put({ ...run, packs })
              }
            } catch (error) { failures.push(error) }
            try { await this.options.store.finishInitialDispatch(id) }
            catch (error) { failures.push(error) }
            await this.finishDispatchOwned(id, report, true)
            if (failures.length === 1) throw failures[0]
            if (failures.length > 1) throw new AggregateError(failures, 'Generation dispatch and checkpoint failed')
            return report as Record<string, unknown>
          })
      } finally {
        this.dispatching.delete(id)
        this.arm(0)
      }
    })
  }

  /**
   * Record exact task identities while preserving an original intent if readback is missing.
   * @param id - Watch run for the initial tool invocation.
   * @param report - Normal submission result, when the tool returned one.
   */
  finishDispatch(id: string, report?: Record<string, unknown>): Promise<void> {
    return this.own(() => this.finishDispatchOwned(id, report))
  }

  private async finishDispatchOwned(id: string, report?: Record<string, unknown>, leaseHeld = false): Promise<void> {
    try {
      const update = async () => {
        const run = await this.options.store.load(id)
        if (!run) throw new Error('Original generation intent is missing')
        const rows = report ? receiptRows(report) : []
        const packs = run.packs.map((pack) => {
          const row = rows.find(value => value.idempotency_key === pack.key)
            ?? (run.packs.length === 1 && rows[0]?.idempotency_key === undefined ? rows[0] : undefined)
          const id = row?.status === 'submitted' || row?.status === 'already_submitted' ? taskId(row.task_id) : undefined
          return id === undefined ? pack : { ...pack, taskId: id }
        })
        this.controller.signal.throwIfAborted()
        await this.options.store.put({ ...run, packs })
        await this.options.store.finishInitialDispatch(id)
      }
      if (leaseHeld) await update()
      else await this.options.store.withRecoveryLease(id, this.controller.signal, this.options.watchTimeoutMs, update)
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
      const admittedAt = Date.now()
      if (this.dispatching.has(run.id) || (run.nextPollAt ?? 0) > admittedAt) continue
      this.advancing.add(run.id)
      try {
        await this.options.store.withRecoveryLease(run.id, this.controller.signal, this.options.watchTimeoutMs, async () => {
          const current = await this.options.store.load(run.id)
          if (current === undefined || current.notice?.deliveredAt !== undefined || current.reviewRequired === true
            || this.dispatching.has(current.id) || (current.nextPollAt ?? 0) > admittedAt) return
          if (current.groupOrigin !== undefined) {
            await this.options.store.put({ ...current, reviewRequired: true })
            this.options.warn(`Generation watch ${current.id} belongs to an archived group; retain it for review`, undefined)
            return
          }
          if (!await this.options.store.mayObserve(current.id)) return
          try { await this.options.store.claimOwnership(current, this.controller.signal) }
          catch (error) {
            if (!(error instanceof GenerationWatchOwnershipConflict)) throw error
            await this.options.store.put({ ...current, reviewRequired: true })
            this.options.warn(`Generation watch ${current.id} has ambiguous ownership; retain it for review`, error)
            return
          }
          await this.advance(current)
        })
      }
      catch (error) {
        const { signal } = this.controller
        if (!signal.aborted) this.options.warn(`Generation watch ${run.id} remains pending`, error)
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
        this.controller.signal, current.groupOrigin, undefined, current)
      if (outcome === 'pending') return
      if (outcome === 'interrupted' && current.recoveryNotice === undefined) {
        await this.options.store.put({ ...current, recoveryNotice: createGenerationWatchNotice(recoveryText(current.notice)) })
        return
      }
      const recoveryExhausted = outcome === 'interrupted'
      const reviewRequired = recoveryExhausted || outcome === 'needs-review' || outcome === 'unknown'
      if (reviewRequired) {
        this.options.warn(`Generation watch ${run.id} did not complete its continuation; episode delivery requires review`, undefined)
        await this.options.store.put({ ...current, reviewRequired: true,
          ...(recoveryExhausted ? { recoveryExhausted: true as const,
            notice: { ...current.notice, deliveredAt: Date.now() } } : {}) })
        return
      }
      await this.options.store.put({ ...current, notice: { ...current.notice, deliveredAt: Date.now() } })
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
      if (counts.get(pack.taskId) !== 1) {
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
