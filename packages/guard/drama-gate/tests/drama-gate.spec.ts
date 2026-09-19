import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as DramaGate from '@deepseek-ai/dsh-guard-drama'
import type { Config } from '@deepseek-ai/dsh-guard-drama'
import { WORKSPACE } from './harness.ts'

/**
 * Wiring suite for the drama gate: the plugin is mounted on a REAL tool registry
 * and driven through `ctx.tools.execute`, so the cases prove the interceptor
 * actually sits in the dispatch waterfall — a refused call never reaches the
 * tool body, and an allowed one does.
 */

const signal = new AbortController().signal

/** Whether each registered fixture body ran, keyed by tool name. */
type Ran = Map<string, number>

/** Mount SystemPrompt + the real tool registry + the gate, and register one counting fixture per name. */
async function harness(names: readonly string[], config: Config = {}): Promise<{ ctx: Context; ran: Ran }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const ran: Ran = new Map()
  for (const name of names) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `${name} fixture`,
      parameters: {
        method: { type: 'string' },
        idempotency_key: { type: 'string' },
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      async execute() {
        ran.set(name, (ran.get(name) ?? 0) + 1)
        return [{ type: 'text', text: 'ran' }]
      },
    }))
  }
  await ctx.plugin(DramaGate, config)
  return { ctx, ran }
}

describe('the gate intercepts real dispatch', () => {
  it('refuses a paid method without a key before the body runs', async () => {
    const { ctx, ran } = await harness(['jubian_storyboard'])
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c1'),
      name: 'jubian_storyboard',
      arguments: { method: 'generate' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(ran.get('jubian_storyboard')).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('必须带 idempotency_key')
  })

  it('lets an allowed call reach the body', async () => {
    const { ctx, ran } = await harness(['jubian_storyboard'])
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c2'),
      name: 'jubian_storyboard',
      arguments: { method: 'get' },
    })
    expect(result.isError).toBe(false)
    expect(ran.get('jubian_storyboard')).toBe(1)
  })

  it('refuses a gated write into the workshop', async () => {
    // A dispatched call carries no session cwd here, so the configured root is what
    // resolves the workshop-relative path the model wrote.
    const { ctx, ran } = await harness(['write'], { workspaceRoot: WORKSPACE })
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c3'),
      name: 'write',
      arguments: { file_path: 'short-drama/demo/prompts/01.txt', content: '【镜头1】\n时长：1秒\n旁白：他走了\n' },
    })
    expect(result.isError).toBe(true)
    expect(ran.get('write')).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('本格式没有旁白')
  })

  it('leaves an unrelated tool untouched', async () => {
    const { ctx, ran } = await harness(['grep'])
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c4'),
      name: 'grep',
      arguments: { method: 'generate' },
    })
    expect(result.isError).toBe(false)
    expect(ran.get('grep')).toBe(1)
  })

  it('explains a retired MUSE tool name instead of returning a bare UNKNOWN_TOOL', async () => {
    const { ctx } = await harness([])
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c5'),
      name: 'timeline',
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('已下线的 MUSE 工具名')
  })

  it('honors a switch, letting the same call through when the rule is off', async () => {
    const { ctx, ran } = await harness(['jubian_storyboard'], { idempotencyKey: false })
    const result = await ctx.tools.execute({
      signal,
      callId: ToolCallId('c6'),
      name: 'jubian_storyboard',
      arguments: { method: 'generate' },
    })
    expect(result.isError).toBe(false)
    expect(ran.get('jubian_storyboard')).toBe(1)
  })
})

describe('config validation', () => {
  const BAD_CONFIGS: [string, Config][] = [
    ['a workshopDir with a separator', { workshopDir: join('a', 'b') }],
    ['an absolute workshopDir', { workshopDir: resolve('/drama') }],
    ['a blank workshopDir', { workshopDir: '   ' }],
    ['a parent workshopDir', { workshopDir: '..' }],
    ['a relative workspaceRoot', { workspaceRoot: join('relative', 'root') }],
    ['a relative projectRoot', { projectRoot: join('relative', 'root') }],
  ]

  it.each(BAD_CONFIGS)('rejects %s', async (_label, config) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(DramaGate, config)).rejects.toThrow(/drama-gate:/)
  })

  it('accepts the shipped defaults and registers nothing model-facing', async () => {
    const { ctx } = await harness([])
    expect(ctx.tools.schemas()).toEqual([])
  })
})
