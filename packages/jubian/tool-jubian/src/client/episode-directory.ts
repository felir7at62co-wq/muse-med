/** Registration-owned episode selection and explicit admission, independent of panel lifetime. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-tool-jubian/remote'
import type { EpisodeDeliveryStatus, EpisodeHistory, EpisodeReadiness, EpisodeReadinessInput, EpisodeStatusInput } from '../types.ts'

/** Actual generated namespace; no alternate browser transport is defined here. */
export type EpisodeClient = ClientRemote['jubianEpisodeDelivery']
/** Reads belong to one connection and selection; their revision never changes admission identity. */
export type EpisodeQueryKind = 'readiness' | 'history' | 'status'
/** Current resource request supplied by explicit actions or a selected original task. */
export interface EpisodeQuery extends EpisodeReadinessInput {
  readonly kind: EpisodeQueryKind
  readonly epoch: number
  readonly revision: number
  readonly digest?: EpisodeStatusInput['digest']
}
/** Interaction facts and historical display values; only current resources grant action permission. */
export interface EpisodeInteraction {
  connected: boolean
  epoch: number
  episodeText: string
  busy: boolean
  checked: boolean
  readinessAddress: string
  historyAddress: string
  statusAddress: string
  target: EpisodeStatusInput | null
  displayedReadiness: EpisodeReadiness | null
  displayedHistory: EpisodeHistory | null
  displayedStatus: EpisodeDeliveryStatus | null
}
/** Shared shell feedback for completed actions only. */
export type EpisodeNotice = 'episodeAccepted' | 'episodeCompleted' | { readonly failed: string }

/** One Settings registration owns the controller and pins its current observations. */
export class EpisodeDirectory {
  /** Selection and query addresses with historical values retained for display. */
  readonly state = createSnapshotStore<EpisodeInteraction>({ connected: false, epoch: 0, episodeText: '1', busy: false, checked: false,
    readinessAddress: '', historyAddress: '', statusAddress: '', target: null,
    displayedReadiness: null, displayedHistory: null, displayedStatus: null })
  private binding: { client: EpisodeClient; pin: (address: string, signal: AbortSignal) => void } | undefined
  private revision = 0
  private selection = 0
  private operation: object | undefined
  private closed = false
  private readonly queries = new Map<EpisodeQueryKind, { address: string; controller: AbortController }>()
  private ready: EpisodeStatusInput | undefined
  private permission: { input: EpisodeStatusInput; status: EpisodeDeliveryStatus } | undefined
  private announced: string | undefined

  /** @param notify - Existing shell notice publisher. */
  constructor(private readonly notify: (notice: EpisodeNotice) => void) {}

  /** Bind one current generated namespace and resource-pin owner.
   * @param client - Actual mounted Remote namespace.
   * @param pin - Resource registry hold for this registration.
   * @returns Retires only this connection, preserving any original lookup target.
   */
  connect(client: EpisodeClient, pin: (address: string, signal: AbortSignal) => void): () => void {
    if (this.closed) return () => {}
    this.releaseQueries()
    const binding = { client, pin }; this.binding = binding; this.operation = undefined
    this.state.update((state) => { state.connected = true; state.epoch++; state.busy = false })
    const target = this.state.getSnapshot().target
    if (target !== null) this.request('status', target)
    return () => {
      if (this.binding !== binding) return
      this.releaseQueries(); this.binding = undefined; this.operation = undefined
      this.state.update((state) => { state.connected = false; state.epoch++; state.busy = false })
    }
  }

  /** Retire old project/episode results without withdrawing any Host admission.
   * @param episodeText - New explicit episode input, or the current input on a project change.
   */
  retireSelection(episodeText = this.state.getSnapshot().episodeText): void {
    if (this.closed) return
    this.selection++; this.operation = undefined; this.announced = undefined; this.releaseQueries()
    this.state.update((state) => { state.episodeText = episodeText; state.target = null; state.busy = false
      state.displayedReadiness = null; state.displayedHistory = null; state.displayedStatus = null })
  }

  /** Explicit expensive input check; typing and Settings mount never invoke it.
   * @param input - Saved project and explicit episode.
   */
  check(input: EpisodeReadinessInput): void {
    if (!this.available()) return
    this.ready = undefined; this.permission = undefined
    this.state.update((state) => { state.checked = false })
    this.request('readiness', input)
  }
  /** Explicit bounded discovery, without selecting a historical task automatically.
   * @param input - Saved project and explicit episode.
   */
  history(input: EpisodeReadinessInput): void { if (this.available()) this.request('history', input) }

  /** Select a displayed history entry, then read its exact current status.
   * @param input - Original project, episode and digest.
   * @param address - History observation from which the user selected the entry.
   */
  selectOriginal(input: EpisodeStatusInput, address: string): void {
    if (!this.available() || !this.current('history', address)) return
    this.ready = undefined; this.permission = undefined
    this.state.update((state) => { state.target = { ...input } })
    this.request('status', input)
  }

  /** Refresh only the selected original/current target; never recheck readiness or resubmit. */
  refresh(): void {
    if (!this.available()) return
    const input = this.state.getSnapshot().target ?? this.ready
    if (input !== undefined) { this.permission = undefined; this.request('status', input) }
  }

  /** Whether an observation still belongs to the current request.
   * @param kind - Query owner.
   * @param address - Exact registered observation address.
   * @returns False for disconnected, replaced or retired observations.
   */
  current(kind: EpisodeQueryKind, address: string): boolean {
    return !this.closed && this.binding !== undefined && this.queries.get(kind)?.address === address
  }

  /** Retain accepted readiness for display and prepare only its current exact target.
   * @param address - Exact readiness observation.
   * @param value - Actual Host readiness facts.
   */
  acceptReadiness(address: string, value: EpisodeReadiness): void {
    if (!this.current('readiness', address)) return
    this.state.update((state) => { state.displayedReadiness = value; state.checked = value.ready && value.digest !== null })
    this.ready = value.ready && value.digest !== null
      ? { projectDir: value.projectDir, episode: value.episode, digest: value.digest } : undefined
    const target = this.state.getSnapshot().target
    if (this.ready !== undefined && (target === null || this.same(target, this.ready))) this.request('status', target ?? this.ready)
  }

  /** Retain history for display across query failure, never as current resume permission.
   * @param address - Exact bounded-history observation.
   * @param value - Actual validated Host history.
   */
  acceptHistory(address: string, value: EpisodeHistory): void {
    if (this.current('history', address)) this.state.update((state) => { state.displayedHistory = value })
  }

  /** Accept only the original status requested after the latest submission/refresh.
   * @param address - Exact current status observation.
   * @param value - Actual Host state and explicit resume permission.
   */
  acceptStatus(address: string, value: EpisodeDeliveryStatus): void {
    if (!this.current('status', address)) return
    this.state.update((state) => { state.displayedStatus = value })
    const input = { projectDir: value.projectDir, episode: value.episode, digest: value.digest }
    this.permission = { input, status: value }
    const target = this.state.getSnapshot().target
    if (target === null || !this.same(input, target) || value.state !== 'completed' || value.output === undefined) return
    const key = JSON.stringify([input, value.attempt, value.execution])
    if (this.announced === key) return
    this.announced = key; this.notify('episodeCompleted')
  }

  /** Submit once, or explicitly resume the same observed original task.
   * @param resume - True only for a user-selected Resume action backed by current Host permission.
   */
  async admit(resume = false): Promise<void> {
    if (!this.available()) return
    const permission = this.permission, selected = this.state.getSnapshot().target
    const input = selected ?? this.ready
    if (input === undefined || permission === undefined || !this.same(input, permission.input)
      || (resume ? !permission.status.canResume : this.ready === undefined || !this.same(input, this.ready)
        || permission.status.state !== 'not-admitted')) return
    const binding = this.binding
    if (binding === undefined) return
    const operation = {}, selection = this.selection
    this.operation = operation; this.permission = undefined; this.ready = undefined
    this.releaseQuery('status')
    this.state.update((state) => { state.target = { ...input }; state.busy = true; state.checked = false; state.statusAddress = '' })
    const active = (): boolean => !this.closed && this.binding === binding && this.selection === selection && this.operation === operation
    try {
      const result = await binding.client.admitEpisode({ ...input, ...(resume ? { resume: true as const } : {}) })
      if (!active()) return
      if (result.ok) this.notify('episodeAccepted')
      else this.notify({ failed: result.error.message || result.error.code })
    } catch (error) {
      if (active()) this.notify({ failed: error instanceof Error ? error.message : String(error) })
    } finally {
      if (active()) {
        this.operation = undefined; this.state.update((state) => { state.busy = false })
        // Only a newly opened post-response status can grant the next explicit Resume.
        this.request('status', input)
      }
    }
  }

  /** Release observations; this never cancels an already admitted Host job. */
  dispose(): void { this.closed = true; this.releaseQueries(); this.binding = undefined; this.operation = undefined }

  private available(): boolean { return !this.closed && this.binding !== undefined && this.operation === undefined }
  private same(left: EpisodeStatusInput, right: EpisodeStatusInput): boolean {
    return left.projectDir === right.projectDir && left.episode === right.episode && left.digest === right.digest
  }
  private request(kind: EpisodeQueryKind, input: EpisodeReadinessInput & Partial<Pick<EpisodeStatusInput, 'digest'>>): void {
    const binding = this.binding
    if (binding === undefined) return
    if (kind === 'status') this.permission = undefined
    this.releaseQuery(kind)
    const query: EpisodeQuery = { ...input, kind, epoch: this.state.getSnapshot().epoch, revision: ++this.revision }
    const address = 'dsh-resource://jubian-episode-' + kind + '/' + encodeURIComponent(JSON.stringify(query))
    const controller = new AbortController(); this.queries.set(kind, { address, controller })
    this.state.update((state) => { state[`${kind}Address`] = address })
    binding.pin(address, controller.signal)
  }
  private releaseQuery(kind: EpisodeQueryKind): void { this.queries.get(kind)?.controller.abort(); this.queries.delete(kind) }
  private releaseQueries(): void {
    for (const query of this.queries.values()) query.controller.abort()
    this.queries.clear(); this.ready = undefined; this.permission = undefined
    this.state.update((state) => { state.readinessAddress = ''; state.historyAddress = ''; state.statusAddress = ''; state.checked = false })
  }
}
