/** One session's composer state, backed by the Host's committed selection stream. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

import type { SessionVideoSelection, VideoModelOption } from '../video-session-types.ts'

/** Remote methods consumed by the session-scoped picker. */
export interface VideoSelectionClient {
  catalogue(): Promise<RemoteResult<VideoModelOption[]>>
  select(session: SessionId, key: string, revision: number): Promise<RemoteResult<SessionVideoSelection>>
  watch(session: SessionId, signal: AbortSignal): AsyncIterable<SessionVideoSelection | null>
}

/** Observable facts rendered by the video selector. */
export interface VideoDirectoryState {
  current: SessionVideoSelection | null
  options: readonly VideoModelOption[]
  loading: boolean
  selecting: boolean
  error: string | null
}
/** Shared composer controller; its owning session scope disposes the stream. */
export class VideoDirectory {
  /** Live picker facts shared by composer instances of this session. */
  readonly store = createSnapshotStore<VideoDirectoryState>({ current: null, options: [], loading: false, selecting: false, error: null })
  private readonly controller = new AbortController()
  private task: Promise<void> | undefined
  private catalogueTask: Promise<void> | undefined
  constructor(private readonly remote: VideoSelectionClient, private readonly sessionId: SessionId) {}
  /** Start the durable selection stream once. */
  open(): void { if (!this.controller.signal.aborted) this.task ??= this.follow().finally(() => { this.task = undefined }) }
  /** Abort the selection stream and await it and any outstanding catalogue read. */
  async dispose(): Promise<void> { this.controller.abort(); await Promise.all([this.task, this.catalogueTask]) }
  /** Refresh specifications while retaining the visible catalogue; overlapping reads share one request. */
  load(): Promise<void> {
    if (this.disposed()) return Promise.resolve()
    this.open()
    return this.catalogueTask ??= this.refresh().finally(() => { this.catalogueTask = undefined })
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
      this.store.update((state) => { state.current = result.value; state.selecting = false })
    } catch (error) {
      if (this.disposed()) return
      this.store.update((state) => { state.selecting = false; state.error = error instanceof Error ? error.message : String(error) })
    }
  }
  private disposed(): boolean { return this.controller.signal.aborted }
  private async follow(): Promise<void> {
    try {
      for await (const result of this.remote.watch(this.sessionId, this.controller.signal)) {
        if (this.disposed()) return
        this.store.update((state) => { state.current = result; state.error = null })
      }
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.store.update((state) => { state.error = error instanceof Error ? error.message : String(error) })
      }
    }
  }
}
