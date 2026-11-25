import { Context } from '@deepseek-ai/cordis'
import type { JingliuConnection, JingliuSession } from '@deepseek-ai/dsh-jingliu-connection'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as JingliuTools from '../src/index.ts'

const project = { id: 'film', title: '雨夜' }
const balance = { unlimited: false, available: '12.50', usedFen: 18, heldFen: 5, enforced: false }

async function fixture() {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registered = new Map<string, ToolDefinition>()
  const request = vi.fn<JingliuSession['request']>()
  const connection = {
    connection: vi.fn<JingliuConnection['connection']>().mockResolvedValue({ identity: 'studio-user', request, download: async () => new Map() }),
    selected: vi.fn<JingliuConnection['selected']>().mockResolvedValue(project),
    selectProject: vi.fn<JingliuConnection['selectProject']>().mockResolvedValue(project),
    balance: vi.fn<JingliuConnection['balance']>().mockResolvedValue(balance),
    billingDetails: vi.fn<JingliuConnection['billingDetails']>(),
  }
  ctx.provide('tools', { register(tool: ToolDefinition) {
    registered.set(tool.name, tool)
    return () => { registered.delete(tool.name) }
  } } as Context['tools'])
  const studio: Pick<JingliuConnection, keyof typeof connection> = connection
  ctx.provide('jingliuConnection', studio as JingliuConnection)
  ctx.provide('settings', { describe: () => [{ ns: 'drama-settings', value: { jianyingDraftDir: '' } }] } as Context['settings'])
  const plugin = ctx.plugin(JingliuTools)
  await plugin.await()
  const agent = { session: { id: 'session-9' } } as ToolRunContext['agent'] & object
  const signal = new AbortController().signal
  const call = (name: string, args: Record<string, unknown>) => {
    const callId = ToolCallId('jingliu-request')
    return registered.get(name)!.execute(args, { name, arguments: args, callId, rootCallId: callId, agent, signal,
      token: Symbol() as ToolExecutionToken, deferContext() {}, concludeTurn() {} })
  }
  return { ctx, plugin, registered, request, connection, call, signal, agent }
}

it('registers account-scoped billing with bounded signed ledger entries and unloads the tools', async () => {
  const f = await fixture()
  const ledger = Array.from({ length: 11 }, (_, index) => ({ time: '2026-11-22T08:36:00Z', kind: 'spend' as const, amountFen: -index - 1 }))
  f.connection.billingDetails.mockResolvedValueOnce({ balance: { ...balance, unlimited: true }, ledger })
    .mockResolvedValueOnce({ balance, ledger: null })
  const tool = f.registered.get('muse_billing')!
  expect(tool.isConcurrencySafe?.({})).toBe(true)
  expect(tool.presentCall?.({})).toMatchObject({ title: '镜流 · 余额与费用' })
  await expect(f.call('muse_billing', {})).resolves.toEqual({ account: 'jingliu', available_yuan: '12.50', used_fen: 18,
    held_fen: 5, unlimited: false, enforced: false })
  expect(f.connection.billingDetails).not.toHaveBeenCalled()
  await expect(f.call('muse_billing', { include_ledger: true })).resolves.toMatchObject({ available_yuan: null, ledger: ledger.slice(0, 10) })
  await expect(f.call('muse_billing', { include_ledger: true })).resolves.toMatchObject({ ledger: null })
  expect(f.connection.balance).toHaveBeenCalledWith(f.signal)
  expect(f.connection.billingDetails).toHaveBeenCalledWith(f.signal)
  await f.plugin.dispose()
  expect([...f.registered]).toEqual([])
})

it('routes project selection through approval and checks draft settings before dispatch', async () => {
  const f = await fixture()
  await expect(f.call('jingliu_projects', { action: 'current' })).resolves.toEqual({ project })
  expect(f.connection.selected).toHaveBeenCalledWith('session-9', 'studio-user')
  f.request.mockResolvedValue(project)
  const args = { action: 'select', project_id: project.id }
  await expect(f.call('jingliu_projects', args)).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
  const request = vi.fn<Context['approval']['request']>().mockResolvedValueOnce('rejected').mockResolvedValueOnce('allowed-once')
  const approval: Pick<Context['approval'], 'request'> = { request }
  f.ctx.provide('approval', approval as Context['approval'])
  await expect(f.call('jingliu_projects', args)).rejects.toMatchObject({ code: 'JINGLIU_APPROVAL_REQUIRED' })
  expect(f.connection.selectProject).not.toHaveBeenCalled()
  await expect(f.call('jingliu_projects', args)).resolves.toEqual({ project })
  expect(request).toHaveBeenLastCalledWith({ agent: f.agent, callId: 'jingliu-request', toolName: 'jingliu_projects',
    reason: '将当前对话关联到镜流项目「雨夜」 (film)', signal: f.signal })
  expect(f.connection.selectProject).toHaveBeenCalledWith('session-9', project.id, f.signal)

  f.request.mockClear().mockResolvedValue({ count: 1, tools: [{ name: 'export_jianying', description: '导出草稿', role: 'viewer',
    risk: 'read', costs: false, long_running: false, needs_confirm: false, account_scoped: false,
    parameters: { type: 'object', properties: { project_id: { type: 'string' } } } }] })
  await expect(f.call('jingliu_run', { workflow: 'export_jianying', project_id: project.id }))
    .rejects.toMatchObject({ code: 'JINGLIU_DRAFT_ROOT_REQUIRED' })
  expect(f.request.mock.calls.map(([path]) => path)).toEqual(['/desktop-agent/tools'])
})
