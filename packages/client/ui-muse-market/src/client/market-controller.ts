/** Request currency for the market presentation; all business results still come from Host operations. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketActions, MarketIdentity } from './market-actions.ts'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'

/** Current verified private capability and its revocation generation. */
export interface MarketAccess {
  readonly revision: number
  readonly inventoryRevision?: number
  readonly identity?: MarketIdentity
}

/** Refuse publishing a late private result into another access generation. */
export class MarketAccessChanged extends Error {
  /** Public refusal reason for a superseded or disposed request. */
  readonly code = 'muse-market/access-changed'
  constructor() { super('Market account access changed') }
}

/** Own request lifetime separately from the mounted page and its creator draft store. */
export class MarketController {
  private state: MarketAccess = { revision: 0 }
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private identityRequest = 0
  private denied = false
  /** Renderer-bound private access facts; snapshots stay stable until they change. */
  readonly access: HostObservable<MarketAccess> = {
    getSnapshot: () => this.state,
    subscribe: (listener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }
  /** Real Host operations with lifetime and private-result currency checks. */
  readonly operations: MarketActions

  /** Create one registration-owned request controller.
   * @param actual - Real generated Remote operation adapters.
   */
  constructor(actual: MarketActions) {
    const local = async <T>(call: () => Promise<T>): Promise<T> => {
      if (!this.isLive()) throw new MarketAccessChanged()
      const result = await call()
      if (!this.isLive()) throw new MarketAccessChanged()
      return result
    }
    const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
      const revision = this.state.revision
      if (!this.isLive()) throw new MarketAccessChanged()
      try {
        const result = await read()
        if (!this.isCurrentAccess(revision)) throw new MarketAccessChanged()
        return result
      } catch (error) {
        if (this.isCurrentAccess(revision) && authorityUnavailable(error) && !this.denied) {
          this.denied = true
          this.publish({ revision: this.state.revision + 1 })
        }
        throw error
      }
    }
    this.operations = {
      sources: () => local(() => actual.sources()), prepare: (metadata, source) => local(() => actual.prepare(metadata, source)),
      installed: () => local(() => actual.installed()), importPackage: bytes => local(() => actual.importPackage(bytes)),
      exportPackage: id => local(() => actual.exportPackage(id)), removePackage: id => local(() => actual.removePackage(id)),
      defaults: () => local(() => actual.defaults()), setDefault: request => local(() => actual.setDefault(request)),
      binding: request => local(() => actual.binding(request)),
      catalog: (q, mine) => guarded(() => actual.catalog(q, mine)),
      getPublication: id => guarded(() => actual.getPublication(id)),
      installPublication: (id, sha) => guarded(() => actual.installPublication(id, sha)),
      publishDraft: (id, publisher, key) => guarded(() => actual.publishDraft(id, publisher, key)),
      review: (id, revision, action, note) => guarded(() => actual.review(id, revision, action, note)),
      identity: async () => {
        const sequence = ++this.identityRequest
        const identity = await guarded(() => actual.identity())
        if (sequence !== this.identityRequest) throw new MarketAccessChanged()
        if (this.state.identity !== undefined && !deepEqualJson(this.state.identity, identity)) {
          this.publish({ revision: this.state.revision + 1 })
        }
        this.denied = false
        this.publish({ ...this.state, identity })
        return identity
      },
    }
  }

  /** Revoke private controls immediately; a later identity read must verify them again. */
  invalidateAccess(): void {
    if (this.disposed) return
    this.denied = false; ++this.identityRequest
    this.publish({ revision: this.state.revision + 1 })
  }

  /** Check a private action's captured access generation before publishing a result.
   * @param revision - Generation captured when the user chose the action.
   * @returns Whether its original authority is still current and this controller is live.
   */
  isCurrentAccess(revision: number): boolean { return !this.disposed && revision === this.state.revision }

  /** Request a fresh local inventory without revoking current cloud authority. */
  invalidateInventory(): void {
    if (!this.disposed) this.publish({ ...this.state, inventoryRevision: (this.state.inventoryRevision ?? 0) + 1 })
  }

  /** Suppress late callbacks and release the observable consumers. */
  dispose(): void { this.disposed = true; this.listeners.clear() }

  private isLive(): boolean { return !this.disposed }

  private publish(value: MarketAccess): void {
    this.state = value
    for (const listener of this.listeners) listener()
  }
}

function authorityUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('details' in error)) return true
  const details = error.details
  if (typeof details !== 'object' || details === null || !('status' in details)) return true
  if ('code' in details && details.code === 'account-changed') return true
  return details.status !== 400 && details.status !== 409
}
