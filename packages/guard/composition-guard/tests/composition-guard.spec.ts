import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf, scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { Scope, ScopeKey, ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as CompositionGuard from '@deepseek-ai/dsh-composition-guard'
import { guardState } from '@deepseek-ai/dsh-composition-guard'
import type { Config } from '@deepseek-ai/dsh-composition-guard'
import { PRESET_TOOLS, publishAgent, stubAgent, toolFixture } from './harness.ts'

/**
 * Behavior suite for the composition guard: the baseline each agent gets (born
 * under the guard, or adopted at activation), detection of a silent tool
 * withdrawal on the loader's config update, the preset-change and
 * already-reported silences, re-arming after recovery, config bounds, contained
 * failures, and disposal.
 *
 * Everything downstream of the scripted withdrawal is real: the real tool
 * registry answers the scope view the guard reads, the real agent registry holds
 * the fabricated agents, and the fabricated update drives the real
 * `internal/update` waterfall the Loader and `dsh-app-boot` observe.
 */

/** One preset's standing composition: the layer its agents inherit tools from. */
interface Standing {
  readonly key: ScopeKey
  readonly ctx: Context
  /** Live registrations of this standing layer; empty while withdrawn. */
  undos: (() => void)[]
}

/**
 * `LoggerLevel.WARN`. An exporter without an explicit level threshold defaults
 * to INFO and therefore drops warn records, so a capture sink must raise its own.
 */
const WARN_LEVEL = 2

/** Storage key for the standing composition of a deployment that composes no roster. */
const UNROSTERED = Symbol('unrostered')

/** One fabricated session under test. */
interface AgentFixture {
  readonly agent: Agent
  /** Messages the guard delivered into this session. */
  readonly injected: UserMessage[]
  /**
   * Withdraw this agent's preset-provided tools: the live-reload defect. `keep`
   * names the tools that survive, for a partially withdrawn composition.
   */
  withdraw(keep?: readonly string[]): void
  /** Put them back: recovery. */
  restore(): void
  /** Re-link this agent to another preset's standing composition. */
  switchTo(preset: string): void
  /** The tool names this agent's scope resolves now. */
  visibleTools(): string[]
  dispose(): Promise<void>
}

interface Harness {
  readonly ctx: Context
  /** Mount the guard; the returned disposer unloads it. */
  mountGuard(config?: Config): Promise<() => Promise<void>>
  /**
   * Publish a fabricated agent joined to `preset`'s standing composition, or to
   * an unrostered one when `preset` is omitted (a deployment composing no roster).
   */
  spawn(id: string, preset?: string): Promise<AgentFixture>
  /** Publish a fabricated agent whose context carries no scope key at all. */
  spawnScopeless(id: string): Promise<Agent>
  /** Make the roster read throw, proving a failing check is contained. */
  breakRoster(): void
  /** Every `warn` line the host logged, oldest first. */
  warnings(): string[]
  /** Drive one loader config update through the real waterfall, then let the sweep settle. */
  loaderUpdate(reload?: () => void, fail?: boolean): Promise<void>
}

/** A tool definition the fixtures register; the guard only reads names, so the body is inert. */
/**
 * Boot the real service spine and the preset-like scope machinery, without the
 * guard, so each test chooses when (and whether) the guard activates.
 */
async function harness(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)

  // The guard's own diagnostics are the log channel under test, so capture them
  // from the host logger rather than asserting on a spy the guard never uses.
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: WARN_LEVEL },
    export: (message) => { warnings.push(String(message.args[0])) },
  })

  // A scoped context resolves services through the MINTING plugin's dependency
  // chain, so the minter declares what scope holders will reach; in production
  // the agent loop's own inject list plays this role.
  let mintCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => { mintCtx = inner }, { inject: ['tools'] }))

  const standings = new Map<string | symbol, Standing>()
  const presetByKey = new Map<ScopeKey, string>()
  let rosterBroken = false

  function standingFor(preset: string | undefined): Standing {
    // An omitted preset is a deployment composing no roster: the agent still
    // inherits a standing layer, but no preset id answers for it.
    const name = preset ?? UNROSTERED
    const existing = standings.get(name)
    if (existing !== undefined) return existing
    const key: ScopeKey = { preset: name }
    const scope: Scope = createScope(mintCtx, key)
    if (preset !== undefined) presetByKey.set(key, preset)
    const standing: Standing = { key, ctx: scope.ctx, undos: [] }
    install(standing)
    standings.set(name, standing)
    return standing
  }

  /** Register the preset's tools into its standing layer. */
  function install(standing: Standing): void {
    standing.undos = PRESET_TOOLS.map(toolName => standing.ctx.tools.register(toolFixture(toolName)))
  }

  /** Dispose every live registration of one standing layer. */
  function withdrawFrom(standing: Standing): void {
    for (const undo of standing.undos) undo()
    standing.undos = []
  }

  // The optional roster this guard reads, answering like `AgentPresets` does: the
  // preset is the standing composition the agent's scope key is parented to.
  ctx.provide('agentPresets', {
    composedPreset(agentCtx: Context): string | undefined {
      if (rosterBroken) throw new Error('roster exploded')
      const key = scopeOf(agentCtx)
      const parent = key === undefined ? undefined : scopeParentOf(key)
      return parent === undefined ? undefined : presetByKey.get(parent)
    },
  })

  return {
    ctx,
    breakRoster(): void { rosterBroken = true },
    warnings(): string[] {
      return [...warnings]
    },
    async mountGuard(config: Config = {}): Promise<() => Promise<void>> {
      const fiber = await ctx.plugin(CompositionGuard, config)
      return () => fiber.dispose()
    },
    async loaderUpdate(reload?: () => void, fail = false): Promise<void> {
      // The runtime value IS the update's restart promise, while the
      // `internal/update` declaration types this waterfall's return as void.
      // oxlint-disable-next-line typescript/no-confusing-void-expression -- see above
      const settled = ctx.waterfall(ctx.fiber, 'internal/update', {}, false, () => {
        reload?.()
        return fail ? Promise.reject(new Error('the row failed to restart')) : Promise.resolve()
      })
      // The update's own restart promise is what the guard observes; an
      // app-boot-style observer contains its rejection, so this harness does too.
      await Promise.resolve(settled).catch(() => undefined)
      // The guard sweeps in a continuation of that promise, so let the
      // continuation run before the assertion reads its effect.
      await new Promise((resolve) => { setTimeout(resolve, 0) })
    },
    async spawn(id: string, preset?: string): Promise<AgentFixture> {
      const standing = standingFor(preset)
      const agentKey: ScopeKey = {}
      const scope = createScope(mintCtx, agentKey)
      const binding: ScopeParentBinding = bindScopeParent(agentKey, standing.key)
      const injected: UserMessage[] = []
      const agent = stubAgent(SessionId(id), scope.ctx, injected)
      const detach = await publishAgent(ctx, agent)
      let current = standing
      return {
        agent,
        injected,
        withdraw: (keep: readonly string[] = []) => {
          withdrawFrom(current)
          for (const toolName of keep) current.undos.push(current.ctx.tools.register(toolFixture(toolName)))
        },
        restore: () => {
          withdrawFrom(current)
          install(current)
        },
        switchTo: (next: string) => {
          current = standingFor(next)
          binding.rebind(current.key)
        },
        visibleTools: () => {
          const scopeKey = scopeOf(agent.ctx)
          /* v8 ignore next -- this suite always publishes an agent with a scope key */
          if (scopeKey === undefined) return []
          return ctx.tools.schemas(scopeKey).map(schema => schema.name).sort()
        },
        dispose: async () => {
          detach()
          await scope.dispose()
        },
      }
    },
    async spawnScopeless(id: string): Promise<Agent> {
      const injected: UserMessage[] = []
      const agent = stubAgent(SessionId(id), mintCtx, injected)
      await publishAgent(ctx, agent)
      return agent
    },
  }
}

/** The texts the guard delivered into one session, in order. */
function notices(fixture: AgentFixture): string[] {
  return fixture.injected.map(message =>
    message.content.map(block => block.type === 'text' ? block.text : '').join('|'))
}

/** The guard's own log lines among every warning the host logged. */
function guardWarnings(h: Harness): string[] {
  return h.warnings().filter(line => line.startsWith('composition-guard:'))
}

describe('detection', () => {
  it('detects a silent withdrawal on the loader update and announces it once, on both channels', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')

    expect(session.visibleTools()).toEqual([...PRESET_TOOLS])

    session.withdraw()
    await h.loaderUpdate()

    const lines = guardWarnings(h)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('session "a1"')
    expect(lines[0]).toContain('preset drama')
    expect(lines[0]).toContain('[edit, read, write]')
    expect(lines[0]).toContain('host restart')

    const delivered = notices(session)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe(
      '这个会话的部分工具被一次配置热加载撤掉了（缺少：edit、read、write）。'
      + '**重启一次 DSH 宿主**即可恢复；已经打开的会话不方便重启时，可新开一个会话继续。',
    )
    expect(session.injected[0]!.source).toEqual({
      kind: 'plugin',
      plugin: 'composition-guard',
      form: 'notice',
      summary: '工具被热加载撤掉：缺少 edit、read、write',
    })
  })

  it('stays silent on a second update with no further change', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    session.withdraw()
    await h.loaderUpdate()
    await h.loaderUpdate()
    await h.loaderUpdate()

    expect(guardWarnings(h)).toHaveLength(1)
    expect(notices(session)).toHaveLength(1)
  })

  it('stays silent on an update that changes nothing', async () => {
    const h = await harness()
    await h.mountGuard()
    await h.spawn('a1', 'drama')
    await h.loaderUpdate()

    expect(guardWarnings(h)).toEqual([])
  })

  it('does not report a legitimate preset change', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    // The composition moved, and the tool set with it: a re-composition, not this defect.
    session.switchTo('standard')
    await h.loaderUpdate()

    expect(guardWarnings(h)).toEqual([])
    expect(notices(session)).toEqual([])
    // The new composition IS the baseline, so a withdrawal under it is news.
    session.withdraw()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toHaveLength(1)
    expect(guardWarnings(h)[0]).toContain('preset standard')
  })

  it('re-arms after recovery, so a later regression is announced again', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')

    session.withdraw()
    await h.loaderUpdate()
    session.restore()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toHaveLength(1)

    // A regression after the names came back is a new regression.
    session.withdraw()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toHaveLength(2)
    expect(notices(session)).toHaveLength(2)
  })

  it('reports only the names that disappeared', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    // A partially withdrawn composition: `read` survives this reload.
    session.withdraw(['read'])

    await h.loaderUpdate()
    expect(guardWarnings(h)[0]).toContain('[edit, write]')
    expect(notices(session)[0]).toContain('缺少：edit、write')
  })

  it('reports a withdrawal for an agent that composed no preset', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('rostermless')
    session.withdraw()
    await h.loaderUpdate()

    expect(guardWarnings(h)).toHaveLength(1)
    expect(guardWarnings(h)[0]).toContain('preset (none)')
  })

  it('sweeps after a failed reload, because the rows are withdrawn either way', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    session.withdraw()
    await h.loaderUpdate(undefined, true)

    expect(guardWarnings(h)).toHaveLength(1)
    expect(notices(session)).toHaveLength(1)
  })

  it('reports each of two agents independently, capped by maxAgentsPerUpdate', async () => {
    const h = await harness()
    await h.mountGuard({ maxAgentsPerUpdate: 1 })
    const first = await h.spawn('a1', 'first')
    const second = await h.spawn('a2', 'second')
    first.withdraw()
    second.withdraw()
    await h.loaderUpdate()

    // Only the first live agent fits the cap; the second is inspected by a later update.
    expect(guardWarnings(h)).toHaveLength(1)
    expect(guardWarnings(h)[0]).toContain('"a1"')
    expect(notices(second)).toEqual([])
  })

  it('applies with the documented default cap when it is constructed directly', async () => {
    const h = await harness()
    // Direct construction bypasses the Loader schema, so the guard supplies its
    // own defaults for the fields the schema would have filled.
    CompositionGuard.apply(h.ctx, { announceInSession: true })
    const session = await h.spawn('a1', 'drama')
    session.withdraw()
    await h.loaderUpdate()

    expect(guardWarnings(h)).toHaveLength(1)
  })

  it('publishes the tracked baseline the invariant companion reads', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')

    expect(guardState(h.ctx.root.fiber).composed).toBe(true)
    expect(guardState(h.ctx.root.fiber).tracked[0]?.baseline).toEqual({
      names: [...PRESET_TOOLS],
      preset: 'drama',
      revision: 1,
      reported: undefined,
    })

    session.withdraw()
    await h.loaderUpdate()
    expect(guardState(h.ctx.root.fiber).tracked[0]?.baseline.reported).toEqual([...PRESET_TOOLS])
  })
})

describe('adopting the agents that already exist', () => {
  it('baselines an agent that was live before activation and reports its later withdrawal', async () => {
    const h = await harness()
    const session = await h.spawn('long-lived', 'drama')

    // The guard joins a RUNNING host: this session is already live here.
    await h.mountGuard()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toEqual([])

    session.withdraw()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toHaveLength(1)
    expect(guardWarnings(h)[0]).toContain('session "long-lived"')
    expect(guardWarnings(h)[0]).toContain('preset drama')
  })

  it('does not report a composition that was already incomplete at activation', async () => {
    const h = await harness()
    const session = await h.spawn('already-hurt', 'drama')

    // The defect happened before the guard existed: two of the three tools are
    // already gone, and nothing observed them. With no earlier observation there
    // is no regression to attribute, and guessing one would fire on every start.
    session.withdraw(['read'])

    await h.mountGuard()
    await h.loaderUpdate()
    await h.loaderUpdate()

    expect(session.visibleTools()).toEqual(['read'])
    expect(guardWarnings(h)).toEqual([])
    expect(notices(session)).toEqual([])
  })

  it('treats the adopted state as the baseline, so a further loss IS reported', async () => {
    const h = await harness()
    const session = await h.spawn('already-hurt', 'drama')
    session.withdraw(['read'])

    await h.mountGuard()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toEqual([])

    // `read` disappears too: that IS a withdrawal relative to what the guard saw.
    session.withdraw()
    await h.loaderUpdate()
    expect(guardWarnings(h)).toHaveLength(1)
    expect(guardWarnings(h)[0]).toContain('[read]')
  })
})

describe('containment and ownership', () => {
  it('contains a throwing check: one warning, no propagation, host still running', async () => {
    const h = await harness()
    const session = await h.spawn('a1', 'drama')
    await h.mountGuard()
    // The roster read the guard depends on starts failing: a broken check must
    // cost a log line, never the host.
    h.breakRoster()

    session.withdraw()
    await expect(h.loaderUpdate()).resolves.toBeUndefined()

    const failures = h.warnings().filter(line => line.includes('composition check failed for session "a1"'))
    expect(failures).toHaveLength(1)

    // The failure repeats on every update; its report does not.
    await h.loaderUpdate()
    await h.loaderUpdate()
    expect(h.warnings().filter(line => line.includes('composition check failed for session "a1"'))).toHaveLength(1)
    expect(notices(session)).toEqual([])
  })

  it('contains a failing roster read on the creation dispatch', async () => {
    const h = await harness()
    await h.mountGuard()
    h.breakRoster()
    const session = await h.spawn('a1', 'drama')

    expect(h.warnings().filter(line => line.includes('composition check failed for session "a1"'))).toHaveLength(1)
    expect(notices(session)).toEqual([])
  })

  it('contains a host logger that throws and still delivers the notice', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    // A sink that throws makes `ctx.logger.warn` itself throw; the guard must
    // treat the log channel as one channel, not as the operation.
    h.ctx.logger.exporter({
      levels: { default: WARN_LEVEL },
      export: () => { throw new Error('log sink down') },
    })

    session.withdraw()
    await expect(h.loaderUpdate()).resolves.toBeUndefined()
    expect(notices(session)).toHaveLength(1)
  })

  it('contains a session that refuses the notice and still keeps the log record', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    // A disposed or detached session is exactly the state a delivery can lose to.
    ;(session.agent as unknown as { inject: () => void }).inject = () => { throw new Error('session detached') }

    session.withdraw()
    await expect(h.loaderUpdate()).resolves.toBeUndefined()
    const lines = guardWarnings(h)
    // The log channel carried the regression, and the refused delivery is named
    // as the contained failure it is: two lines, neither one thrown.
    expect(lines.filter(line => line.includes('lost 3 visible tool(s)'))).toHaveLength(1)
    expect(lines.filter(line => line.includes('the composition check failed for session "a1"'))).toHaveLength(1)
    expect(notices(session)).toEqual([])
  })

  it('retries an announcement neither channel accepted, and does not mark it reported', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    // Both channels down at once: the log sink throws and the session is gone.
    h.ctx.logger.exporter({
      levels: { default: WARN_LEVEL },
      export: () => { throw new Error('log sink down') },
    })
    ;(session.agent as unknown as { inject: () => void }).inject = () => { throw new Error('session detached') }

    session.withdraw()
    await h.loaderUpdate()
    await h.loaderUpdate()

    // An undelivered regression is not a reported one, so the guard tries again
    // rather than declaring silence on a message nobody received.
    expect(guardWarnings(h).filter(line => line.includes('lost 3 visible tool(s)'))).toHaveLength(2)
    expect(guardState(h.ctx.root.fiber).tracked[0]?.baseline.reported).toBeUndefined()
  })

  it('keeps the newest instance\'s records when an earlier one unloads', async () => {
    const h = await harness()
    const disposeFirst = await h.mountGuard()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')

    // One guard row per runtime is the supported composition; a reload that
    // starts the replacement before the old fiber finishes unloading must not
    // leave the runtime with no records at all.
    await disposeFirst()
    session.withdraw()
    await h.loaderUpdate()

    expect(guardState(h.ctx.root.fiber).tracked.map(tracked => tracked.agent.id)).toEqual(['a1'])
    expect(guardWarnings(h).filter(line => line.includes('session "a1"'))).toHaveLength(1)
  })

  it('survives a live-agent enumeration that throws, reporting it once', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.exporter({
      levels: { default: WARN_LEVEL },
      export: (message) => { warnings.push(String(message.args[0])) },
    })
    ctx.provide('tools', { schemas: () => [] })
    ctx.provide('agents', { list: () => { throw new Error('registry gone') } })
    await ctx.plugin(CompositionGuard, {})

    ctx.waterfall(ctx.fiber, 'internal/update', {}, false, () => Promise.resolve())
    ctx.waterfall(ctx.fiber, 'internal/update', {}, false, () => Promise.resolve())
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    const failures = warnings.filter(line => line.includes('the composition sweep failed'))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('registry gone')
  })

  it('ignores an agent whose context carries no scope key', async () => {
    const h = await harness()
    await h.mountGuard()
    await h.spawnScopeless('scopeless')
    await h.loaderUpdate()

    expect(guardWarnings(h)).toEqual([])
  })

  it('drops its state and stops checking when the guard is unloaded', async () => {
    const h = await harness()
    const dispose = await h.mountGuard()
    const session = await h.spawn('a1', 'drama')

    await dispose()
    session.withdraw()
    await h.loaderUpdate()

    expect(guardWarnings(h)).toEqual([])
    expect(notices(session)).toEqual([])
  })

  it('forgets an agent the registry disposes', async () => {
    const h = await harness()
    await h.mountGuard()
    const session = await h.spawn('a1', 'drama')
    await session.dispose()
    // A replacement reusing the id is a different composition, not the old one.
    const replacement = await h.spawn('a1', 'drama')
    await h.loaderUpdate()
    expect(guardWarnings(h)).toEqual([])
    expect(notices(replacement)).toEqual([])
  })
})

describe('configuration', () => {
  it('writes only the log line when the in-session notice is off', async () => {
    const h = await harness()
    await h.mountGuard({ announceInSession: false })
    const session = await h.spawn('a1', 'drama')
    session.withdraw()
    await h.loaderUpdate()

    expect(guardWarnings(h)).toHaveLength(1)
    expect(notices(session)).toEqual([])
  })

  it('rejects a non-positive agent cap at load, never falling back to a default', async () => {
    const h = await harness()
    expect(() => { CompositionGuard.apply(h.ctx, { maxAgentsPerUpdate: 0 }) })
      .toThrow(/maxAgentsPerUpdate must be a positive integer/)
    expect(() => { CompositionGuard.apply(h.ctx, { maxAgentsPerUpdate: 2.5 }) })
      .toThrow(/maxAgentsPerUpdate must be a positive integer/)
  })
})
