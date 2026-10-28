/** Per-agent tool selection with optional Bot-owned persistent preferences. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Current session selections, filtered against the agent's current authorization. */
export interface ToolContextState {
  /** Definitions selected for this session, excluding constant tools. */
  loaded: string[]
  /** Definitions selected for future sessions by the owning Bot or current session. */
  pinned: string[]
}

/** Bot integration owns durable preference parsing and writes; discovery owns model presentation. */
export interface ToolResidencyProvider {
  /** Determine whether this provider owns the agent's preferences.
   * @param agent - Agent being created, resumed, or used by a tool.
   * @returns whether the provider owns this agent.
   */
  matches(agent: Agent): boolean
  /** Read previously stored exact tool names.
   * @param agent - Agent whose Bot preferences are requested.
   * @returns detached tool names; unavailable names remain dormant.
   */
  read(agent: Agent): Promise<readonly string[]>
  /** Save the complete preferred set before a successful tool receipt is returned.
   * @param agent - Agent whose Bot preferences are being updated.
   * @param names - Complete exact-name set, including currently dormant preferences.
   * @returns fulfillment after the owning store has saved the preferences.
   */
  write(agent: Agent, names: readonly string[]): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared discovery registry and per-agent preferred-tool integration. */
    toolDiscovery: ToolDiscoveryRuntime
  }
}

/** Host service for optional durable Bot preferences and session-derived selections. */
export class ToolDiscoveryRuntime extends Service {
  private readonly providers = new Set<ToolResidencyProvider>()
  private readonly pins = new WeakMap<Agent, { provider: ToolResidencyProvider; names: readonly string[] }>()
  private saves: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly snapshot: (agent: Agent) => ToolContextState,
    private readonly constantTools: ReadonlySet<string>) {
    super(ctx, 'toolDiscovery')
    ctx.effect(() => async () => { await this.saves })
  }

  /** Register one Bot preference owner; overlapping owners fail when an agent is resolved.
   * @param provider - Provider matching only the agents it owns.
   * @returns reversible registration disposer.
   */
  registerResidency(provider: ToolResidencyProvider): () => Promise<void> {
    return this.ctx.effect(() => {
      this.providers.add(provider)
      return () => { this.providers.delete(provider) }
    })
  }

  /** Refresh stored Bot selections before first assembly or after an external preference edit.
   * @param agent - Agent whose owner may have saved preferences.
   * @returns fulfillment after preferences have been read.
   */
  async refresh(agent: Agent): Promise<void> {
    const provider = this.provider(agent)
    if (provider) this.pins.set(agent, { provider, names: [...new Set(await provider.read(agent))].sort() })
    else this.pins.delete(agent)
  }

  /** Read detached current session selections without exposing unavailable tool names.
   * @param agent - Agent whose current selection is requested.
   * @returns authorized loaded and preferred names, excluding constant tools.
   */
  state(agent: Agent): ToolContextState {
    const state = this.snapshot(agent)
    const authorized = new Set(this.ctx.tools.schemas(agent).map(tool => tool.name).filter(name => !this.constantTools.has(name)))
    const pinned = this.preferred(agent, state.pinned)
    return { loaded: [...new Set([...state.loaded, ...pinned])].filter(name => authorized.has(name)).sort(),
      pinned: [...pinned].filter(name => authorized.has(name)).sort() }
  }

  /** Test presentation membership without rebuilding authorized schemas for every definition.
   * @param agent - Agent whose selection is being assembled.
   * @param name - Already-authorized definition being considered by the registry.
   * @returns whether session loading or the Bot's preferences select the definition.
   */
  selected(agent: Agent, name: string): boolean {
    const state = this.snapshot(agent)
    return state.loaded.includes(name) || this.preferred(agent, state.pinned).includes(name)
  }

  /** Save a preference edit to its Bot owner while preserving dormant stored names.
   * @param agent - Agent performing the change.
   * @param operation - Whether to add or remove preferred names.
   * @param names - Validated exact tool names affected by the edit.
   * @returns fulfillment after the external save, when an owner is registered.
   */
  async save(agent: Agent, operation: 'pin' | 'release' | 'unpin', names: readonly string[]): Promise<void> {
    const provider = this.provider(agent)
    if (!provider) return
    const saved = this.saves.then(async () => {
      const existing = await provider.read(agent)
      const next = operation === 'pin' ? [...new Set([...existing, ...names])].sort()
        : existing.filter(name => !names.includes(name))
      await provider.write(agent, next)
      this.pins.set(agent, { provider, names: next })
    })
    // The caller receives the failure; later preference edits may still proceed.
    this.saves = saved.catch((_error: unknown) => {})
    await saved
  }

  private preferred(agent: Agent, fallback: readonly string[]): readonly string[] {
    const cached = this.pins.get(agent)
    return cached?.provider === this.provider(agent) ? cached?.names ?? fallback : fallback
  }

  private provider(agent: Agent): ToolResidencyProvider | undefined {
    const matches = [...this.providers].filter(provider => provider.matches(agent))
    if (matches.length > 1) throw new Error('More than one tool residency provider owns this agent')
    return matches[0]
  }
}
