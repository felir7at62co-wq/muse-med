/** Serialized ownership of the optional presentation's Cordis scope. */
interface PresentationScope { dispose(): Promise<void> }

/** Hot switches wait for the previous scope to unwind before registering another. */
export class PresentationRuntime {
  private scope: PresentationScope | undefined
  private pending: Promise<void> = Promise.resolve()
  private disposed = false

  /** @param mount - Creates only presentation registrations, never Agent execution state. */
  constructor(private readonly mount: () => Promise<PresentationScope>) {}

  /**
   * Apply one accepted switch in request order; failed mounts remain retryable.
   * @param enabled - Whether the presentation should be mounted.
   * @returns Completion after registration or all disposal effects settle.
   */
  setEnabled(enabled: boolean): Promise<void> {
    const update = async (): Promise<void> => {
      if (this.disposed || enabled === (this.scope !== undefined)) return
      if (enabled) this.scope = await this.mount()
      else {
        const previous = this.scope
        this.scope = undefined
        await previous?.dispose()
      }
    }
    this.pending = this.pending.then(update, update)
    return this.pending
  }

  /** Stop accepting switches and release the final scope, including an in-flight mount. */
  async dispose(): Promise<void> {
    this.disposed = true
    try { await this.pending } finally {
      const previous = this.scope
      this.scope = undefined
      await previous?.dispose()
    }
  }
}
