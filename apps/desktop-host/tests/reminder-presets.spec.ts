/** Product presets keep reminders scoped to their own mount and exclude delegated agents. */
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import Schedule from '@deepseek-ai/dsh-schedule'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../packages/storage/storage-domain/tests/helpers/memory-backend.ts'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalFs from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { SessionId } from '@deepseek-ai/dsh-session'
import { executeModelToolFixture, defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { PtcRuntime, type PtcRunRequest, type PtcRunSpec, type PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import * as DelegationPolicy from '../src/delegation-policy.ts'
import { MockAdapter } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as ToolSchedule from '@deepseek-ai/dsh-tool-schedule'
import { parse as parseYaml } from 'yaml'
import { expect, it } from 'vitest'
import { harness } from '../../../packages/schedule/schedule/tests/harness.ts'

interface PresetRow {
  readonly id: string
  readonly name: string
  readonly config?: {
    readonly backgroundMode?: string
    readonly toolFilter?: { readonly deny?: readonly string[] }
  } | readonly PresetRow[]
}

const reminderTools = ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view']
const presets = ['standard', 'ptc', 'cordis', 'short-drama', 'creation', 'minimal']

function rows(preset: string): readonly PresetRow[] {
  return parseYaml(readFileSync(new URL(`../presets/${preset}/agent.cordis.yml`, import.meta.url), 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => ({ __jsExpr: value }) }],
  }) as PresetRow[]
}

it('registers reminders only in the complete Muse preset scopes and disposes them with the mount', async () => {
  const { ctx } = await harness()
  try {
    for (const preset of presets) {
      const entries = rows(preset)
      const scheduleRows = entries.filter(row => row.id === 'tool-schedule')
      const clockRows = entries.filter(row => row.id === 'time-context')
      const minimal = preset === 'minimal'
      expect(scheduleRows.map(row => row.name), preset).toEqual(minimal ? [] : ['@deepseek-ai/dsh-tool-schedule'])
      expect(clockRows.map(row => row.name), preset).toEqual(minimal ? [] : ['@deepseek-ai/dsh-time-context'])
      const key = {}
      const scope = createScope(ctx, key)
      try {
        if (scheduleRows.length > 0) await scope.ctx.plugin(ToolSchedule)
        expect(ctx.tools.schemas(key).map(tool => tool.name).sort(), preset).toEqual(minimal ? [] : reminderTools)
        expect(ctx.tools.schemas()).toEqual([])
        expect(ctx.tools.schemas({})).toEqual([])
      } finally {
        await scope.dispose()
      }
      expect(ctx.tools.schemas(key)).toEqual([])
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

it('mounts live-child scheduling policy for each complete preset spawn and fork delegation', () => {
  for (const preset of presets.filter(preset => !['minimal', 'creation'].includes(preset))) {
    const delegation = rows(preset).find(row => row.id === 'delegation')
    if (delegation === undefined || !Array.isArray(delegation.config)) throw new Error(`Missing ${preset} delegation`)
    const children = delegation.config as readonly PresetRow[]
    expect(children.find(row => row.id === 'delegation-policy')?.name).toBe('@deepseek-ai/dsh-desktop-host/delegation-policy')
    for (const id of ['tool-subagent', 'tool-subagent-fork']) {
      const row = children.find(candidate => candidate.id === id)
      if (row === undefined || row.config === undefined || Array.isArray(row.config)) throw new Error(`Missing ${preset} ${id}`)
      const config = row.config as Exclude<PresetRow['config'], readonly PresetRow[] | undefined>
      expect(config.backgroundMode, `${preset}/${id}`).toBeUndefined()
      expect(config.toolFilter, `${preset}/${id}`).toBeUndefined()
    }
  }
})

it.each(['creation'])('keeps the single-agent %s preset without delegation', (preset) => {
  expect(rows(preset).find(row => row.id === 'delegation')).toBeUndefined()
})

it('keeps reminders absent when the optional Host schedule service is disabled', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const key = {}
    const scope = createScope(ctx, key)
    try {
      await scope.ctx.plugin(ToolSchedule)
      expect(ctx.tools.schemas(key)).toEqual([])
      expect(ctx.tools.schemas()).toEqual([])
    } finally {
      await scope.dispose()
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

/** Controlled execution consumes the actual PTC executor's generated bindings. */
class ReminderRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  target = 'schedule_list'
  offered: string[] = []
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: request.timeoutMs ?? 120_000 }
  }
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const functions = spec.bindings.find(namespace => namespace.global === 'tools')?.functions ?? {}
    this.offered = Object.keys(functions)
    const binding = functions[this.target]
    if (binding === undefined) throw new Error(`Tool is unavailable: ${this.target}`)
    return { logs: [], value: await binding({}) }
  }
}

it('denies the actual four schedule tools to live children in native and PTC execution while roots retain them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'muse-real-reminder-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(Agents)
    await ctx.plugin(LocalFs, { cwd: root })
    await ctx.plugin(WorkingDirectory, { defaultDirectory: root }).await()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const native = ctx.plugin(NativeToolExecutor)
    await native.await()
    await ctx.plugin(JsonlPersistence, { root: join(root, 'sessions') }).await()
    await ctx.plugin(Storage)
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    ctx.effect(() => ctx.storage.backend.register('fixture', backend))
    ctx.effect(() => () => backend.close())
    const facility = new DomainFacility(ctx, { backend: 'fixture' })
    ctx.effect(() => {
      const unmount = ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      return async () => { await facility.closeAll(); unmount() }
    })
    await ctx.plugin(Schedule).await()
    await ctx.plugin(Llm)
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    await ctx.plugin(AgentLoop, { agents: [] }).await()
    await ctx.plugin(DelegationPolicy).await()
    await ctx.plugin(ToolSchedule).await()
    const parent = (await ctx.agents.create({ sessionId: SessionId('schedule-parent'),
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    const child = (await ctx.agents.create({ sessionId: SessionId('schedule-child'), parentAgent: parent,
      agentOptions: { provider: 'mock', model: 'mock' } })).agent
    expect(ctx.agents.roots()).toContain(parent)
    expect(ctx.agents.roots()).not.toContain(child)
    expect(ctx.tools.schemas(parent).map(tool => tool.name).sort()).toEqual(reminderTools)
    expect(ctx.tools.schemas(child)).toEqual([])
    const signal = new AbortController().signal
    const rootList = await executeModelToolFixture(ctx, { agent: parent, name: 'schedule_list', arguments: {},
      callId: ToolCallId('root-native-list'), signal })
    expect(rootList.isError).toBe(false)
    for (const name of reminderTools) {
      const result = await executeModelToolFixture(ctx, { agent: child, name, arguments: {},
        callId: ToolCallId(`child-native-${name}`), signal })
      expect(result.isError, name).toBe(true)
      expect(JSON.stringify(result.content), name).toMatch(/not found|not available|unknown tool/iu)
    }
    await native.dispose()
    await ctx.plugin(ReminderRuntime)
    const ptc = ctx.plugin(PtcToolExecutor)
    await ptc.await()
    const runtime = ctx.ptcRuntime as ReminderRuntime
    const executePtc = (agent: typeof parent, name: string) => executeModelToolFixture(ctx, {
      agent, name: 'run_code', arguments: { description: 'Read scheduling capabilities', code: `return await tools.${name}({})` },
      callId: ToolCallId(`${agent.id}-ptc-${name}`), signal,
    })
    const rootPtc = await executePtc(parent, 'schedule_list')
    expect(rootPtc.isError, JSON.stringify(rootPtc.content)).toBe(false)
    expect(runtime.offered.sort()).toEqual(reminderTools)
    for (const name of reminderTools) {
      runtime.target = name
      expect((await executePtc(child, name)).isError, name).toBe(true)
      for (const denied of reminderTools) expect(runtime.offered, name).not.toContain(denied)
    }
    await ptc.dispose()
    await ctx.plugin(NativeToolExecutor).await()
    let ownExecutions = 0
    for (const name of reminderTools) child.ctx.effect(() => child.ctx.tools.register(defineContentToolFixture({
      name, description: 'Late child-owned schedule implementation', parameters: {}, execute: async () => {
        ownExecutions++
        return []
      },
    })))
    expect(ctx.tools.schemas(child)).toEqual([])
    for (const name of reminderTools) {
      const result = await executeModelToolFixture(ctx, { agent: child, name, arguments: {},
        callId: ToolCallId(`child-late-${name}`), signal })
      expect(result.isError, name).toBe(true)
      expect(JSON.stringify(result.content), name).toMatch(/not found|not available|unknown tool/iu)
    }
    expect(ownExecutions).toBe(0)
    expect((await ctx.schedule.list({})).items).toEqual([])
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
