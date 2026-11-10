/** Device-local DNS preference supplied by the Electron shell. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Saved preference and resolver used by the running application. */
export interface SystemDnsPreference {
  readonly saved: boolean
  readonly active: boolean
}

/** A write may fail after its destination was replaced. */
export type SystemDnsSaveResult = (SystemDnsPreference & { readonly saveFailed?: true }) | { readonly unknown: true }

/** Narrow Desktop bridge for the system DNS preference. */
export interface SystemDnsBridge {
  status(): Promise<SystemDnsPreference>
  set(enabled: boolean): Promise<SystemDnsSaveResult>
}

/** Accepted preference, loading state, and latest save result. */
export interface SystemDnsView {
  readonly preference: SystemDnsPreference | undefined
  readonly loading: boolean
  readonly busy: boolean
  readonly loadFailed: boolean
  readonly unknown: boolean
  readonly notice: 'saved' | 'failed' | 'unknown' | null
  readonly noticeSequence: number
}

/** Owns one preference snapshot and ignores replies after disposal. */
export class SystemDnsSource {
  /** State observed by the settings row and shell toast. */
  readonly store = createSnapshotStore<SystemDnsView>({ preference: undefined, loading: true, busy: false, loadFailed: false,
    unknown: false, notice: null, noticeSequence: 0 })
  private live = true

  /** @param bridge - Main-owned device setting exposed to the product document. */
  constructor(private readonly bridge: SystemDnsBridge) { void this.load() }

  /** Reload the accepted preference after a failed initial read. */
  async load(): Promise<void> {
    if (!this.isLive() || this.store.getSnapshot().busy) return
    this.store.set({ ...this.store.getSnapshot(), loading: true, loadFailed: false })
    try {
      const preference = await this.bridge.status()
      if (this.isLive()) {
        const state = this.store.getSnapshot()
        this.store.set({ ...state, preference, loading: false, unknown: false,
          notice: state.notice === 'unknown' ? null : state.notice })
      }
    } catch (_error) {
      if (this.isLive()) this.store.set({ ...this.store.getSnapshot(), loading: false, loadFailed: true })
    }
  }

  /**
   * Save the preference for the next launch.
   * @param enabled - Preference to save.
   */
  async set(enabled: boolean): Promise<void> {
    const state = this.store.getSnapshot()
    if (!this.isLive() || state.loading || state.busy || state.preference === undefined) return
    this.store.set({ ...state, busy: true })
    try {
      const result = await this.bridge.set(enabled)
      if (!this.isLive()) return
      if ('unknown' in result) this.notice('unknown')
      else this.notice(result.saveFailed === true ? 'failed' : 'saved', { saved: result.saved, active: result.active })
    } catch (_error) {
      this.notice('unknown')
    }
  }

  private notice(notice: 'saved' | 'failed' | 'unknown', preference?: SystemDnsPreference): void {
    if (!this.isLive()) return
    const state = this.store.getSnapshot()
    this.store.set({ ...state, preference, busy: false, notice, unknown: notice === 'unknown',
      noticeSequence: state.noticeSequence + 1 })
  }

  private isLive(): boolean { return this.live }

  /** Dismiss the latest transient save result. */
  dismiss(): void { if (this.isLive()) this.store.set({ ...this.store.getSnapshot(), notice: null }) }

  /** Ignore pending bridge responses. */
  dispose(): void { this.live = false }
}
