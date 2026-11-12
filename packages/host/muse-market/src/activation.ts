/** Opt-in activation of exact Session-bound market Skill releases. */
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { createScope, scopeOf, type Scope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { MarketError } from './format.ts'
import { MuseMarketLocal } from './local.ts'
import { createMarketSkillProvider } from './skills.ts'
import { marketBindingProjectionDefinition } from './session.ts'
import type { MuseMarketBindingState, MuseMarketBindingView, MuseMarketBindingRequest,
  MuseMarketDefaultInput, MuseMarketDefaults, MuseMarketBindingEntry, MarketReleaseId } from './types.ts'
import type {} from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { museMarketActivation: MuseMarketActivation }
}

/** Activation policy is separate from the local-only publication service. */
export default class MuseMarketActivation extends TypertRemoteService {
  static inject = ['museMarket', 'agents', 'sessionProjections', 'sessionQuery']
  private readonly local: MuseMarketLocal
  private readonly controls = new Map<Agent, SkillProviderControl>()
  private readonly scopes = new Set<Scope>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private bindingState!: ProjectionHandle<MuseMarketBindingState>

  constructor(ctx: Context) {
    super(ctx, 'museMarketActivation')
    this.local = new MuseMarketLocal(ctx.museMarket.publicationStorage())
    ctx.effect(() => async () => {
      this.lifetime.abort(new MarketError('activation-closed'))
      await Promise.all([...this.scopes].map(scope => scope.dispose()))
      await Promise.allSettled([...this.pending])
    })
  }

  async [Service.init](): Promise<void> {
    await this.local.initializeActivation()
    this.bindingState = await this.ctx.sessionProjections.register(marketBindingProjectionDefinition)
    this.lifetime.signal.throwIfAborted()
    this.ctx.on('agent/created', async ({ agent }) => { await this.owned(() => this.attach(agent)) })
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      await this.owned(async () => {
        const state = this.bindingState.stateOf(agent.session)
        if (!state.bound && !state.requested) {
          await this.local.captureDefaults((releases) => {
            signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
            agent.session.append('muse-market/bound', { releases })
          })
          this.controls.get(agent)?.invalidate()
        }
      })
      return next()
    }, { prepend: true })
    this.ctx.on('muse-market/before-remove', async (id) => { await this.assertUnused(id) })
    this.ctx.on('session-skills/prepare-view', view => this.owned(async () => {
      view.signal.throwIfAborted()
      const state = view.projections.values.museMarketBinding
      if (state === undefined) throw new MarketError('binding-projection-unavailable')
      let entries: readonly MuseMarketBindingEntry[]
      if (state.bound) {
        entries = state.releases
      } else if (state.requested) {
        entries = []
      } else {
        entries = await this.local.captureDefaults()
      }
      view.signal.throwIfAborted(); this.lifetime.signal.throwIfAborted()
      if (entries.length === 0) return
      const context = view.context(), key = scopeOf(context)
      if (key === undefined) throw new MarketError('binding-scope-unavailable')
      const registration = this.registration(context, key)
      await registration.ctx.plugin({ inject: ['skills'], apply: (scope) => {
        scope.effect(() => scope.skills.registerProvider(() => createMarketSkillProvider(this.local,
          this.ctx.museMarket.publicationStorage(), () => entries, `muse-market-cold-${view.sessionId}`)))
      } }).await()
    }))
  }

  private registration(parent: Context, key: ScopeKey): Scope {
    const scope = createScope(parent, key)
    this.scopes.add(scope)
    scope.ctx.effect(() => () => { this.scopes.delete(scope) })
    return scope
  }

  private async owned<T>(run: () => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    const pending = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted()
      return run()
    })
    this.pending.add(pending)
    try { return await pending } finally { this.pending.delete(pending) }
  }

  private async attach(agent: Agent): Promise<void> {
    const selection = async (): Promise<readonly MuseMarketBindingEntry[]> => {
      const state = this.bindingState.stateOf(agent.session)
      return state.bound ? state.releases : state.requested ? [] : await this.local.captureDefaults()
    }
    const registration = this.registration(agent.ctx, agent)
    await registration.ctx.plugin({ inject: ['skills'], apply: (scope) => {
      scope.effect(() => scope.skills.registerProvider((control) => {
        this.controls.set(agent, control)
        scope.effect(() => () => { if (this.controls.get(agent) === control) this.controls.delete(agent) })
        return createMarketSkillProvider(this.local, this.ctx.museMarket.publicationStorage(), selection, `muse-market-${agent.id}`)
      }))
    } }).await()
  }

  private async assertUnused(id: MarketReleaseId): Promise<void> {
    for (const record of await this.ctx.sessionQuery.listSessions()) {
      using observation = await this.ctx.sessionQuery.observeSession(record.header.id)
      const state = observation.projections?.values.museMarketBinding
      if (state === undefined) throw new MarketError('binding-projection-unavailable')
      if (state.releases.some(entry => entry.release.id === id)) throw new MarketError('release-in-use')
    }
  }

  private async operation<T>(run: () => Promise<T>): Promise<T> {
    try { return await this.owned(run) }
    catch (error) {
      throw new RemoteError('muse-market/operation-failed', 'Skill activation operation failed', {
        code: error instanceof MarketError ? error.code : 'activation-unavailable',
      })
    }
  }

  /** Read the complete committed defaults without rebinding any Session.
   * @returns Activation revision and exact local archive choices.
   */
  @Remote('defaults')
  async defaults(): Promise<MuseMarketDefaults> { return await this.operation(() => this.local.defaults()) }

  /** Explicitly switch or disable one default using the last observed archive identity.
   * @param input - Skill name, expected current archive and selected target or null.
   * @returns Complete committed defaults; existing bound Sessions are unchanged.
   */
  @Remote('setDefault')
  async setDefault(input: MuseMarketDefaultInput): Promise<MuseMarketDefaults> {
    return await this.operation(async () => {
      const result = await this.local.setDefault(input)
      for (const [agent, control] of this.controls) {
        const state = this.bindingState.stateOf(agent.session)
        if (!state.bound && !state.requested) control.invalidate()
      }
      for (const event of ['muse-market/defaults-changed', 'skills/change'] as const) {
        try { this.ctx.emit(event) }
        catch (error) { this.ctx.logger.warn(`Market defaults observer failed: ${String(error)}`) }
      }
      return result
    })
  }

  /** Inspect a live or cold Session's exact selection without creating an Agent.
   * @param input - Session identity.
   * @returns Bound releases, latest blank-session defaults, or the unchanged legacy empty set.
   */
  @Remote('binding')
  async binding(input: MuseMarketBindingRequest): Promise<MuseMarketBindingView> {
    return await this.operation(async () => {
      using observation = await this.ctx.sessionQuery.observeSession(input.sessionId)
      const state = observation.projections?.values.museMarketBinding
      if (state === undefined) throw new MarketError('binding-projection-unavailable')
      if (state.bound) return { phase: 'bound', releases: state.releases }
      return state.requested ? { phase: 'legacy', releases: [] } : { phase: 'blank', releases: await this.local.captureDefaults() }
    })
  }
}
