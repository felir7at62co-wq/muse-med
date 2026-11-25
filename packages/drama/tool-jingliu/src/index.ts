/** Discover and invoke the current Jingliu desktop-agent workflow catalog. @module */
import type { Context } from '@deepseek-ai/cordis'
import { draftDirectory } from '@deepseek-ai/dsh-drama-settings/draft-directory'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
import { output, workflowTools, type Fields } from './workflow-tools.ts'

export type { Dependencies } from './workflow-tools.ts'

/** Cordis plugin name. */
export const name = 'tool-jingliu'
/** Required Host services. */
export const inject = ['tools', 'jingliuConnection']

/**
 * Register the catalog and workflow tools in the current scope.
 * @param ctx - Cordis context providing the authenticated connection and tool registry.
 */
export function apply(ctx: Context): void {
  const tools = workflowTools({
    connect: () => ctx.jingliuConnection.connection(),
    selected: (sid, owner) => ctx.jingliuConnection.selected(sid, owner),
    select: (sid, project, signal) => ctx.jingliuConnection.selectProject(sid, project, signal),
    draftRoot: async () => (await draftDirectory(ctx.settings)).path,
    approve: async (exec, reason) => {
      const approval = ctx.get('approval')
      return !!approval && !!exec.agent && await approval.request({
        agent: exec.agent, callId: exec.callId, toolName: exec.name, reason, signal: exec.signal,
      }) === 'allowed-once'
    },
  })
  for (const definition of tools) ctx.effect(() => ctx.tools.register(definition))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'muse_billing',
    description: '查询当前 Muse 登录用户的镜流积分余额、已用和占用额度，或查看近期积分流水。1 积分等于 1 元。流水显示有正负号的余额变动，结算调整只记录该次调整。',
    parameters: {
      include_ledger: { type: 'boolean', description: '需要消费明细时传 true，返回最多 10 条近期流水；省略时只查余额。' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute({ include_ledger }, exec): Promise<Fields> {
      const connection = ctx.jingliuConnection
      const { balance, ledger } = include_ledger
        ? await connection.billingDetails(exec.signal)
        : { balance: await connection.balance(exec.signal), ledger: null }
      return {
        account: 'jingliu',
        available_yuan: balance.unlimited ? null : balance.available,
        used_fen: balance.usedFen,
        held_fen: balance.heldFen,
        unlimited: balance.unlimited,
        enforced: balance.enforced,
        ...(include_ledger && { ledger: ledger?.slice(0, 10).map(entry => ({ ...entry })) ?? null }),
      }
    },
    presentCall: () => ({ card: 'generic', title: '镜流 · 余额与费用', kind: 'other' }),
  })))
}
