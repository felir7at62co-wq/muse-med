/** Recovery reads and explicit decisions, isolated from retired connections and project selections. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ApprovedClipDeliveryInput, VideoRecoveryAdoptionInput, VideoRecoveryConfigurationInput,
  VideoRecoveryReview, VideoRecoveryReviewInput, VideoRecoveryStatus,
} from '../types.ts'

/** Authenticated calls captured by the registration's current connection scope. */
export interface RecoveryClient {
  status(this: void): Promise<RemoteResult<VideoRecoveryStatus>>
  configure(this: void, input: VideoRecoveryConfigurationInput): Promise<RemoteResult<VideoRecoveryStatus>>
  review(this: void, input: VideoRecoveryReviewInput): Promise<RemoteResult<VideoRecoveryReview>>
  adopt(this: void, input: VideoRecoveryAdoptionInput): Promise<RemoteResult<VideoRecoveryReview>>
  deliverApprovedMp4(this: void, input: ApprovedClipDeliveryInput): Promise<RemoteResult<VideoRecoveryReview>>
}

/** Human action whose exact report identity remains displayed in the dialog. */
export type RecoveryAction = 'approve' | 'reject' | 'reopen' | 'adopt'

/** A dialog owns one report version; another report cannot receive its completion. */
export interface RecoveryDialog {
  id: number
  action: RecoveryAction
  report: VideoRecoveryReview
}

/** Observable accepted reports and interaction state; disconnection retains the last accepted reports. */
export interface RecoveryState {
  connected: boolean
  seen: boolean
  loading: boolean
  busy: boolean
  pickerAvailable: boolean
  projectDir: string
  status: VideoRecoveryStatus | null
  queryError: string | null
  fieldError: boolean
  dialog: RecoveryDialog | null
}

/** Shell-owned transient operation outcome. */
export type RecoveryNotice = { sequence: number } & (
  | { kind: 'configured' | RecoveryAction | 'delivered' | null; reason: null }
  | { kind: 'failed'; reason: string }
)

function valueOf<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message || result.error.code)
  return result.value
}

/** One settings registration's requests, last accepted data and shell notices. */
export class RecoveryDirectory {
  /** Facts read through the renderer's generated useRecoveryState hook. */
  readonly state = createSnapshotStore<RecoveryState>({ connected: false, seen: false, loading: false, busy: false,
    pickerAvailable: false, projectDir: '', status: null, queryError: null, fieldError: false, dialog: null })
  /** Transient notices have a shell lifetime, independent of the Settings panel. */
  readonly notice = createSnapshotStore<RecoveryNotice>({ sequence: 0, kind: null, reason: null })
  private binding: { token: object; client: RecoveryClient } | undefined
  private picker: { token: object; pick: () => Promise<string | null> } | undefined
  private epoch = 0
  private selection = 0
  private dialogId = 0
  private operation: object | undefined
  private closed = false

  /**
   * Install a connection's callbacks and refresh its saved selection.
   * @param client - Narrow calls bound to the current Remote namespace.
   * @returns a disposer that retires only this connection's callbacks.
   */
  connect(client: RecoveryClient): () => void {
    if (this.closed) return () => {}
    const token = {}
    this.epoch++
    this.binding = { token, client }
    this.operation = undefined
    this.state.update((state) => { state.connected = true; state.busy = false; state.loading = false })
    void this.refresh()
    return () => {
      if (this.binding?.token !== token) return
      this.epoch++
      this.binding = undefined
      this.operation = undefined
      this.state.update((state) => { state.connected = false; state.busy = false; state.loading = false; state.dialog = null })
    }
  }

  /**
   * Offer the existing authorized native chooser without retaining a retired picker scope.
   * @param pick - Chooser supplied by its capability owner.
   * @returns removes this chooser and invalidates its outstanding completion.
   */
  offerPicker(pick: () => Promise<string | null>): () => void {
    if (this.closed) return () => {}
    const token = {}
    this.picker = { token, pick }
    this.state.update((state) => { state.pickerAvailable = true })
    return () => {
      if (this.picker?.token !== token) return
      this.picker = undefined
      this.state.update((state) => { state.pickerAvailable = false })
    }
  }

  /** Retire asynchronous completions without rolling back Host commits already made. */
  dispose(): void {
    this.closed = true
    this.epoch++
    this.binding = undefined
    this.picker = undefined
    this.operation = undefined
  }

  /**
   * Change the draft project without replacing its last accepted reports.
   * @param path - Draft project selection.
   */
  setProjectDir(path: string): void {
    if (this.closed) return
    this.selection++
    this.operation = undefined
    this.state.update((state) => { state.projectDir = path; state.fieldError = false
      state.busy = false; state.loading = false; state.dialog = null })
  }

  /** Refresh accepted reports while retaining them on a failed query. */
  refresh(): Promise<void> {
    return this.run('query', async (client, active) => {
      const status = valueOf(await client.status())
      if (!active()) return
      this.accept(status, this.state.getSnapshot().status === null)
    })
  }

  /**
   * Save the recovery switch and the project selected when enabling it.
   * @param enabled - Requested recovery switch.
   */
  configure(enabled: boolean): Promise<void> {
    if (this.closed) return Promise.resolve()
    const projectDir = this.state.getSnapshot().projectDir.trim()
    if (enabled && !projectDir) {
      this.state.update((state) => { state.fieldError = true })
      return Promise.resolve()
    }
    return this.run('configured', async (client, active) => {
      const status = valueOf(await client.configure(enabled ? { enabled, projectDir } : { enabled }))
      if (active()) this.accept(status, true)
    })
  }

  /** Invoke the currently authorized chooser; stale chooser results cannot replace a newer selection. */
  chooseProject(): Promise<void> {
    const picker = this.picker
    if (picker === undefined) return Promise.resolve()
    return this.run('picker', async (_client, active) => {
      const path = await picker.pick()
      if (active() && this.picker === picker && path !== null) this.setProjectDir(path)
    })
  }

  /**
   * Show a decision against the report currently rendered.
   * @param action - Explicit decision or local import.
   * @param report - Exact original key and digest shown to the user.
   */
  open(action: RecoveryAction, report: VideoRecoveryReview): void {
    if (!this.currentReport(report) || this.state.getSnapshot().busy || !this.binding) return
    this.state.update((state) => { state.dialog = { id: ++this.dialogId, action, report } })
  }

  /** Close the current dialog; a completed Host decision still updates accepted reports. */
  closeDialog(): void {
    if (!this.closed) this.state.update((state) => { state.dialog = null })
  }

  /**
   * Submit the displayed dialog's explicit fields.
   * @param id - Dialog identity captured by the rendered form.
   * @param text - Rejection/reopening reason or project-relative import path.
   */
  confirm(id: number, text: string): Promise<void> {
    const dialog = this.state.getSnapshot().dialog
    if (dialog?.id !== id) return Promise.resolve()
    const status = this.currentReport(dialog.report)
    if (status === undefined) return Promise.resolve()
    return this.run(dialog.action, async (client, active) => {
      const target = { idempotencyKey: dialog.report.idempotencyKey, digest: dialog.report.digest }
      const result = dialog.action === 'adopt'
        ? await client.adopt({ ...target, path: text.trim() })
        : await client.review({ ...target, action: dialog.action,
          ...(dialog.action === 'reject' || dialog.action === 'reopen' ? { reason: text.trim() } : {}) })
      const report = valueOf(result)
      if (!active()) return
      this.acceptReport(status, dialog.report, report)
      this.state.update((state) => { if (state.dialog?.id === id) state.dialog = null })
    })
  }

  /**
   * Deliver the exact approved report chosen by the user.
   * @param report - Approved report and digest currently shown.
   */
  deliver(report: VideoRecoveryReview): Promise<void> {
    const status = this.currentReport(report)
    if (status === undefined) return Promise.resolve()
    return this.run('delivered', async (client, active) => {
      const saved = valueOf(await client.deliverApprovedMp4({ idempotencyKey: report.idempotencyKey, digest: report.digest }))
      if (active()) this.acceptReport(status, report, saved)
    })
  }

  /**
   * Dismiss the toast only when its own displayed sequence finishes.
   * @param sequence - Sequence of the completed toast.
   */
  dismissNotice(sequence: number): void {
    if (this.closed) return
    this.notice.update((notice) => { if (notice.sequence === sequence) { notice.kind = null; notice.reason = null } })
  }

  private currentReport(report: VideoRecoveryReview): VideoRecoveryStatus | undefined {
    const status = this.state.getSnapshot().status
    return status?.reports.some(row => row.idempotencyKey === report.idempotencyKey
      && row.digest === report.digest) === true ? status : undefined
  }

  private accept(status: VideoRecoveryStatus, select: boolean): void {
    this.state.update((state) => {
      state.status = status; state.seen = true; state.queryError = null
      if (select) state.projectDir = status.projectDir ?? ''
    })
  }

  private acceptReport(status: VideoRecoveryStatus, previous: VideoRecoveryReview, saved: VideoRecoveryReview): void {
    this.state.update((state) => {
      state.status = { ...status, reports: status.reports.map(row => row.idempotencyKey === previous.idempotencyKey
        && row.digest === previous.digest ? saved : row) }
    })
  }

  private async run(kind: Exclude<RecoveryNotice['kind'], null | 'failed'> | 'query' | 'picker',
    call: (client: RecoveryClient, active: () => boolean) => Promise<void>): Promise<void> {
    const binding = this.binding
    if (this.closed || binding === undefined || this.operation !== undefined) return
    const operation = {}, epoch = this.epoch, selection = this.selection
    this.operation = operation
    const active = (): boolean => !this.closed && this.binding === binding && this.epoch === epoch
      && this.selection === selection && this.operation === operation
    this.state.update((state) => {
      state.busy = true; state.loading = kind === 'query'
      if (kind === 'query') state.queryError = null
    })
    try {
      await call(binding.client, active)
      if (active() && kind !== 'query' && kind !== 'picker') this.notify({ kind, reason: null })
    } catch (error) {
      if (!active()) return
      if (kind === 'query') this.state.update((state) => { state.queryError = error instanceof Error ? error.message : String(error) })
      else this.notify({ kind: 'failed', reason: error instanceof Error ? error.message : String(error) })
    } finally {
      if (active()) {
        this.operation = undefined
        this.state.update((state) => { state.busy = false; state.loading = false })
      }
    }
  }

  private notify(notice: { kind: 'configured' | RecoveryAction | 'delivered'; reason: null } | { kind: 'failed'; reason: string }): void {
    this.notice.set({ sequence: this.notice.getSnapshot().sequence + 1, ...notice })
  }
}
