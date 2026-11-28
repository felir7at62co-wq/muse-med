/** Unattended runs reach a person through a saved IM target only when the agent, or the fallback, decides it must. */
import { Context } from '@deepseek-ai/cordis'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Notify from '../src/unattended-notify.ts'

type Sent = { botId: string; targetId: string; text: string; format?: string }

async function host(config: Notify.Config, coordinator?: unknown) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeToolExecutor)
  const sent: Sent[] = []
  ctx.provide('dshIm' as never, {
    send: async (botId: string, targetId: string, text: string, options?: { format?: string }) => {
      sent.push({ botId, targetId, text, ...(options?.format === undefined ? {} : { format: options.format }) })
      return { sent: true }
    },
  } as never)
  if (coordinator !== undefined) ctx.provide('sessionCoordinator' as never, coordinator as never)
  await ctx.plugin(Notify, config)
  return { ctx, sent }
}

function coordinatorWith(unattended: boolean, tasks: unknown[]) {
  return {
    mode: { unattended },
    async *watchMain(signal: AbortSignal) {
      yield 'main-session'
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
    },
    async *watch(_main: string, signal: AbortSignal) {
      yield tasks
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
    },
  }
}

const marked = (at: number) => ({ id: 'task-21', title: '听宝第21集', owner: 'main-session', createdAt: 0,
  attempts: [{ sessionId: 'worker-1', status: 'blocked', attention: { reason: '剧变登录失效，重派后仍失败', at } }] })

it('stays inactive without a saved delivery target', async () => {
  const { ctx, sent } = await host({})
  const result = await executeModelToolFixture(ctx, { name: 'muse_notify', callId: ToolCallId('no-target'),
    arguments: { title: 't', message: 'm' }, signal: new AbortController().signal })
  expect(result.isError).toBe(true)
  expect(sent).toEqual([])
})

it('sends the agent notice as Markdown to the configured bot and target', async () => {
  const { ctx, sent } = await host({ botId: 'bot_1', targetId: 'production-alerts' })
  const result = await executeModelToolFixture(ctx, { name: 'muse_notify', callId: ToolCallId('notice'),
    arguments: { title: '第12集卡在剧变登录失效', message: '已重试 3 次；请重新登录剧变后回复「继续」。' },
    signal: new AbortController().signal })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ botId: 'bot_1', targetId: 'production-alerts', format: 'markdown' })
  expect(sent[0]!.text).toContain('第12集卡在剧变登录失效')
  expect(sent[0]!.text).toContain('请重新登录剧变')
})

it('notifies once for an attention mark nobody was told about', async () => {
  const { sent } = await host({ botId: 'bot_1', targetId: 'alerts', fallbackMinutes: 1 },
    coordinatorWith(true, [marked(Date.now() - 2 * 60_000)]))
  await vi.waitFor(() => { expect(sent).toHaveLength(1) })
  expect(sent[0]!.text).toContain('听宝第21集')
  expect(sent[0]!.text).toContain('剧变登录失效')
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(sent).toHaveLength(1)
})

it('leaves attended deployments to the people already watching', async () => {
  const { sent } = await host({ botId: 'bot_1', targetId: 'alerts', fallbackMinutes: 1 },
    coordinatorWith(false, [marked(Date.now() - 2 * 60_000)]))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(sent).toEqual([])
})

it('reads attention only from the latest revision', () => {
  const task = marked(5)
  expect(Notify.attentionTasks([task as never])).toEqual([
    { key: 'task-21:5', title: '听宝第21集', sessionId: 'worker-1', reason: '剧变登录失效，重派后仍失败', at: 5 }])
  const resolved = { ...task, attempts: [...task.attempts, { sessionId: 'worker-2', status: 'running' }] }
  expect(Notify.attentionTasks([resolved as never])).toEqual([])
})
