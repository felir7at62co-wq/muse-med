/** One session's composer state, backed by the Host's durable selection projection. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

import { videoSelectionSchema, type SessionVideoSelection, type VideoModelOption, type VideoModelDefault } from '../video-session-types.ts'

/** Remote methods consumed by the session-scoped picker. */
export interface VideoSelectionClient {
  defaults(): Promise<RemoteResult<VideoModelDefault | null>>
  catalogue(): Promise<RemoteResult<VideoModelOption[]>>
  select(session: SessionId, key: string, revision: number): Promise<RemoteResult<SessionVideoSelection>>
}

/** Observable facts rendered by the video selector. */
export interface VideoDirectoryState {
  current: SessionVideoSelection | null
  /** Configured initial display, used only after the durable projection confirms there is no saved selection. */
  defaultModel: VideoModelDefault | null
  options: readonly VideoModelOption[]
  loading: boolean
  selecting: boolean
  error: string | null
}
/** Shared composer controller; its owning session scope disposes the projection subscription. */
export class VideoDirectory {
  /** Live picker facts shared by composer instances of this session. */
  readonly store = createSnapshotStore<VideoDirectoryState>({
    current: null, defaultModel: null, options: [], loading: false, selecting: false, error: null,
  })
  private readonly controller = new AbortController()
  private catalogueTask: Promise<void> | undefined
  private defaultsTask: Promise<void> | undefined
  private defaultsLoaded = false
  private configuredDefault: VideoModelDefault | null = null
  private selectionLoaded = false
  private readonly unsubscribe: () => void
  constructor(private readonly remote: VideoSelectionClient, private readonly sessionId: SessionId,
    selection: ObservableSnapshot<unknown>) {
    const update = (): void => {
      const value = selection.getSnapshot()
      if (value === undefined) return
      const current = videoSelectionSchema.parse(value)
      this.acceptSelection(current)
    }
    this.unsubscribe = selection.subscribe(update)
    update()
  }
  /** Unsubscribe from the projection and await outstanding catalogue and default reads. */
  async dispose(): Promise<void> {
    this.controller.abort(); this.unsubscribe()
    await Promise.all([this.catalogueTask, this.defaultsTask])
  }
  /** Refresh specifications while retaining the visible catalogue; overlapping reads share one request. */
  load(): Promise<void> {
    if (this.disposed()) return Promise.resolve()
    if (!this.defaultsLoaded) this.defaultsTask ??= this.loadDefaults().finally(() => { this.defaultsTask = undefined })
    this.catalogueTask ??= this.refresh().finally(() => { this.catalogueTask = undefined })
    return Promise.all([this.defaultsTask, this.catalogueTask]).then(() => undefined)
  }
  private async loadDefaults(): Promise<void> {
    try {
      const result = await this.remote.defaults()
      if (!result.ok) throw new Error(result.error.message)
      if (this.disposed()) return
      this.defaultsLoaded = true
      this.configuredDefault = result.value
      this.store.update((state) => { state.defaultModel = this.selectionLoaded && state.current === null ? result.value : null })
    } catch (error) {
      if (this.disposed()) return
      this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
    }
  }
  private async refresh(): Promise<void> {
    this.store.update((state) => { state.loading = true; state.error = null })
    try {
      const result = await this.remote.catalogue()
      if (!result.ok) throw new Error(result.error.message)
      if (this.disposed()) return
      this.store.update((state) => { state.options = result.value; state.loading = false })
    } catch (error) {
      if (this.disposed()) return
      this.store.update((state) => { state.loading = false; state.error = error instanceof Error ? error.message : String(error) })
    }
  }
  /**
   * Submit the exact menu option against the revision currently displayed.
   * @param key - Live catalogue option key.
   */
  async select(key: string): Promise<void> {
    if (this.disposed()) return
    const revision = this.store.getSnapshot().current?.revision ?? 0
    this.store.update((state) => { state.selecting = true; state.error = null })
    try {
      const result = await this.remote.select(this.sessionId, key, revision)
      if (!result.ok) throw new Error(result.error.message)
      if (this.disposed()) return
      this.acceptSelection(result.value)
      this.store.update((state) => { state.selecting = false; state.error = null })
    } catch (error) {
      if (this.disposed()) return
      this.store.update((state) => { state.selecting = false; state.error = error instanceof Error ? error.message : String(error) })
    }
  }
  private disposed(): boolean { return this.controller.signal.aborted }
  private acceptSelection(current: SessionVideoSelection | null): void {
    this.selectionLoaded = true
    this.store.update((state) => {
      if (state.current !== null && (current === null || current.revision < state.current.revision)) return
      state.current = current
      state.defaultModel = current === null ? this.configuredDefault : null
    })
  }
}
