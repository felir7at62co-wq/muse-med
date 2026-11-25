/** Desktop permission defaults and explicit session switches through the native Host services. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import Agents, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import Sessions, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Approval, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { expect, it, vi } from 'vitest'
import { createScope } from '../../../packages/core/scope/src/index.ts'
import Commands from '../../../packages/interaction/commands/src/index.ts'
import PermissionPresets from '../../../packages/interaction/permission-presets/src/index.ts'
import SandboxPolicy from '../../../packages/sandbox/sandbox-policy/src/index.ts'
import Projections from '../../../packages/session/session-projection/src/index.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import { unsupportedInbox } from '../../../packages/test-support/agent-loop-testkit/src/inbox.ts'
import { unsupportedModel } from '../../../packages/test-support/agent-loop-testkit/src/model.ts'

const defaults = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/defaults.cordis.patch.yml'))
const product = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/desktop.cordis.patch.yml'))
const permissionDefaults = defaults.filter(patch => patch.id === 'permission')
const policyOverlays = product.filter(patch => ['permission', 'sandbox-policy', 'approval'].includes(patch.id ?? ''))

/** The command path does not execute a shell; its capability still reports the composed policy. */
const Shell = {
  inject: ['sandboxPolicy'],
  apply(ctx: Context) {
    ctx.provide('shell', {
      sandboxMode: ctx.sandboxPolicy.defaultMode,
      resolve() { throw new Error('permission settings tests do not execute a shell') },
      run() { throw new Error('permission settings tests do not execute a shell') },
      start() { throw new Error('permission settings tests do not execute a shell') },
    })
  },
}

/** Mount the shipped permission layers with the production Loader, ConfigEditor, and Settings. */
async function bench(userConfig?: Record<string, unknown>) {
  const rows = composeEntries([[{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'agents', name: 'cordis:agents' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'system-prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'native-executor', name: 'cordis:executor' },
    { id: 'agent-loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'sandbox-policy', name: 'cordis:sandbox' },
    { id: 'approval', name: 'cordis:approval' },
    { id: 'shell', name: 'cordis:shell' },
    { id: 'commands', name: 'cordis:commands' },
    { id: 'permission', name: 'cordis:permission' },
  ] }], permissionDefaults])
  const fixture = await configurationFixture({ hmr: false, rows, builtins: {
    sessions: Sessions, projections: Projections, agents: Agents, sandbox: SandboxPolicy,
    llm: Llm, prompt: SystemPrompt, tools: Tools, executor: NativeToolExecutor, loop: AgentLoop,
    approval: Approval, shell: Shell, commands: Commands, permission: PermissionPresets,
  } })
  await fixture.ctx.fiber.dispose()
  Object.assign(fixture.profile, { overlays: policyOverlays })
  if (userConfig !== undefined) {
    writeFileSync(fixture.profile.patchPath, JSON.stringify([{ id: 'permission', config: userConfig }]))
  }
  return { ...fixture, ctx: await fixture.start() }
}

/** Command dispatch uses the Session and transition injection; loop operations are unavailable. */
async function commandAgent(ctx: Context, session: Session) {
  const inject = vi.fn<Agent['inject']>()
  const unavailable = (): never => { throw new Error('permission command tests do not run an agent loop') }
  const agent: Agent = {
    id: session.id, session, inject, ctx, options: {}, status: 'idle', inbox: unsupportedInbox(), model: unsupportedModel(),
    send: unavailable, followup: unavailable, steer: unavailable, cancel: unavailable,
    runMaintenance: unavailable, whenIdle: unavailable,
  }
  await ctx.plugin(Object.assign((scope: Context) => { createScope(scope, agent) }, { inject: ['commands'] }))
  return { agent, inject }
}

it('routes approvals to the answerer in new Desktop sessions with Full access', async () => {
  const { ctx } = await bench()
  const session = (await ctx.agents.create({ sessionId: SessionId('desktop-fresh-full') })).agent.session
  const { agent } = await commandAgent(ctx, session)
  expect(ctx.permissionPresets.catalog()).toMatchObject({ defaultPreset: 'danger-full-access' })
  expect(ctx.permissionPresets.names).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('danger-full-access')
  expect(ctx.sessionProjections.snapshot(session).values.permissions).toEqual({ currentValue: 'danger-full-access' })
  expect(session.snapshotEvents()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'approval/policy', data: { policy: 'ask' } }),
  ]))
  expect(ctx.commands.list(agent).map(command => command.name)).toContain('permission')
  const answer = await ctx.commands.execute(agent, '/permission', [], new AbortController().signal)
  expect(answer?.result).toEqual({
    kind: 'success', text: 'current preset danger-full-access (available: read-only, workspace-write, danger-full-access)',
  })
  const answerer = vi.fn<() => Promise<ApprovalOutcome>>()
    .mockResolvedValueOnce('rejected')
    .mockResolvedValueOnce('allowed-once')
  ctx.on('approval/request', answerer)
  session.append('turn/start', { turn: 1 })
  const request = { agent, toolName: 'jingliu_run', reason: 'Import script into the selected project' }
  await expect(ctx.approval.request(request)).resolves.toBe('rejected')
  await expect(ctx.approval.request(request)).resolves.toBe('allowed-once')
  expect(answerer).toHaveBeenCalledTimes(2)
})

it('retains an older Full access session until the user reapplies the preset and restores the switch after restart', async () => {
  const { ctx, start } = await bench()
  const legacy = Session.create(SessionId('desktop-legacy-source'))
  legacy.append('permission/preset', { preset: 'danger-full-access' })
  legacy.append('sandbox/mode', { mode: 'danger-full-access' })
  legacy.append('approval/policy', { policy: 'never' })
  const session = (await ctx.agents.create({ sessionId: SessionId('desktop-legacy'), seed: legacy.snapshotEvents() })).agent.session
  expect(ctx.permissionPresets.current(session)).toBe('custom')
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('danger-full-access')
  expect(ctx.approval.overrideOf(session)).toBe('never')
  const before = session.snapshotEvents()
  const { agent, inject } = await commandAgent(ctx, session)
  const response = await ctx.commands.execute(agent, '/permission danger-full-access', [], new AbortController().signal)
  expect(response?.result).toEqual({ kind: 'success', text: 'preset danger-full-access' })
  expect(session.snapshotEvents().slice(before.length).filter(event => [
    'permission/preset', 'sandbox/mode', 'approval/policy',
  ].includes(event.type)).map(event => [event.type, event.data])).toEqual([
    ['permission/preset', { preset: 'danger-full-access' }],
    ['approval/policy', { policy: 'ask' }],
  ])
  expect(inject).toHaveBeenCalledOnce()
  expect(ctx.sandboxPolicy.resolve({ session }).mode).toBe('danger-full-access')
  const saved = session.snapshotEvents()
  await ctx.fiber.dispose()
  const restarted = await start()
  const restored = (await restarted.agents.create({ sessionId: SessionId('desktop-legacy-restored'), seed: saved })).agent.session
  expect(restarted.permissionPresets.current(restored)).toBe('danger-full-access')
  expect(restarted.sandboxPolicy.resolve({ session: restored }).mode).toBe('danger-full-access')
  expect(restarted.approval.overrideOf(restored)).toBe('ask')
})

it('persists a General default for future sessions without changing current sessions and reads it after restart', async () => {
  const { ctx, profile, start } = await bench()
  const existing = (await ctx.agents.create({ sessionId: SessionId('desktop-before-default-change') })).agent.session
  const before = existing.snapshotEvents()
  const view = ctx.settings.describe().find(row => row.ns === 'permission')!
  await ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 'read-only' }], view.revision)
  expect(ctx.permissionPresets.defaultPreset).toBe('read-only')
  expect(existing.snapshotEvents()).toEqual(before)
  expect(ctx.permissionPresets.current(existing)).toBe('danger-full-access')
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('defaultPreset: read-only')
  const later = (await ctx.agents.create({ sessionId: SessionId('desktop-after-default-change') })).agent.session
  expect(ctx.permissionPresets.current(later)).toBe('read-only')
  expect(ctx.sandboxPolicy.resolve({ session: later }).mode).toBe('read-only')
  expect(later.snapshotEvents().filter(event => event.type === 'approval/policy').at(-1)?.data).toEqual({ policy: 'ask' })
  await ctx.fiber.dispose()
  const restarted = await start()
  expect(restarted.settings.describe().find(row => row.ns === 'permission')?.value).toMatchObject({ defaultPreset: 'read-only' })
  const fresh = (await restarted.agents.create({ sessionId: SessionId('desktop-restart-fresh') })).agent.session
  expect(restarted.permissionPresets.current(fresh)).toBe('read-only')
  expect(restarted.sandboxPolicy.resolve({ session: fresh }).mode).toBe('read-only')
})

it('preserves an explicit saved permission configuration on upgrade and refuses invalid Settings writes', async () => {
  const saved = {
    defaultPreset: 'workspace-write',
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    },
  }
  const { ctx, profile } = await bench(saved)
  const before = readFileSync(profile.patchPath, 'utf8')
  const session = (await ctx.agents.create({ sessionId: SessionId('desktop-upgraded-default') })).agent.session
  expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
  expect(ctx.permissionPresets.current(session)).toBe('workspace-write')
  ctx.permissionPresets.set(session, 'danger-full-access')
  expect(ctx.approval.overrideOf(session)).toBe('never')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  await expect(ctx.settings.mutate('permission', [{ op: 'set', path: ['defaultPreset'], value: 42 }])).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.permissionPresets.defaultPreset).toBe('workspace-write')
})
