/** Teardown barriers verify exclusive desktop ownership and fixed connection policy. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import type { Config as McpConfig } from '@deepseek-ai/dsh-mcp-client'


const input = vi.hoisted(() => ({
  state: { available: true, epoch: 0, escapeEpoch: 0, idleMs: 10_000 },
  listeners: new Set<() => void>(),
  states: [] as string[],
}))
vi.mock('../src/computer-input-monitor.ts', () => ({
  createPhysicalInputMonitor: () => ({
    sample: () => input.state,
    subscribe(listener: () => void) { input.listeners.add(listener); return () => { input.listeners.delete(listener) } },
    async close() {},
  }),
}))
vi.mock('../src/computer-control.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/computer-control.ts')>(),
  createComputerStatePublisher: () => ({
    async publish(state: string) { input.states.push(state) },
    close() {},
  }),
}))

const fake = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
  configurations: [] as McpConfig[],
}))

vi.mock('@deepseek-ai/dsh-mcp-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-mcp-client')>()
  return {
    ...original,
    async apply(ctx: Context, config: McpConfig) {
      fake.configurations.push(config)
      ctx.effect(() => () => fake.close())
      await fake.start()
    },
  }
})

import * as Provider from '../src/computer-use.ts'

const contexts: Context[] = []

afterEach(async () => {
  input.state = { available: true, epoch: 0, escapeEpoch: 0, idleMs: 10_000 }
  input.states.length = 0
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  fake.configurations.length = 0
  vi.resetAllMocks()
})

async function context(): Promise<Context> {
  fake.start.mockResolvedValue(undefined)
  fake.close.mockResolvedValue(undefined)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(ComputerUse)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  return ctx
}

describe('Muse computer connection ownership', () => {
  it('keeps startup failures local and disables reconnection before starting the driver', async () => {
    const ctx = await context()
    const ready: PromiseWithResolvers<void> = Promise.withResolvers()
    fake.start.mockReturnValueOnce(ready.promise)
    const first = ctx.plugin(Provider, { command: '/bundled/cua-driver' })
    try {
      await vi.waitFor(() => { expect(fake.start).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('muse-computer')
      await expect(ctx.plugin(Provider, { command: '/second/driver' })).rejects.toThrow('already registered')
      expect(fake.start).toHaveBeenCalledTimes(1)
      expect(fake.configurations[0]).toMatchObject({
        transport: 'stdio', serverName: 'muse-computer', command: '/bundled/cua-driver', args: ['mcp'],
        failOnStartupError: false, reconnect: { enabled: false },
        env: { CUA_DRIVER_PERMISSION_MODE: 'standard', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' },
      })
    } finally {
      ready.resolve()
      await first
    }
  })

  it('releases desktop ownership only after the child finishes closing', async () => {
    const ctx = await context()
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    const first = await ctx.plugin(Provider, { command: '/bundled/cua-driver' })
    fake.close.mockReturnValueOnce(closed.promise)
    const closing = first.dispose()
    try {
      await vi.waitFor(() => { expect(fake.close).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('muse-computer')
      await expect(ctx.plugin(Provider, { command: '/second/driver' })).rejects.toThrow('already registered')
    } finally {
      closed.resolve()
      await closing
    }
    expect(ctx.computerUse.providerName).toBeUndefined()
    const replacement = await ctx.plugin(Provider, { command: '/replacement/driver', args: ['mcp', '--verbose'], toolCallTimeoutMs: 1234 })
    expect(fake.configurations[1]).toMatchObject({ command: '/replacement/driver', args: ['mcp', '--verbose'], toolCallTimeoutMs: 1234 })
    await replacement.dispose()
    expect(ctx.computerUse.providerName).toBeUndefined()
  })

  it('rolls back unexpected activation failures after closing the owned child', async () => {
    const ctx = await context()
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    fake.start.mockRejectedValueOnce(new Error('invalid client activation'))
    fake.close.mockReturnValueOnce(closed.promise)
    const failure = Promise.resolve(ctx.plugin(Provider, { command: '/bundled/driver' })).then(
      () => { throw new Error('Unexpected activation success') }, (error: unknown) => error,
    )
    try {
      await vi.waitFor(() => { expect(fake.close).toHaveBeenCalledTimes(1) })
      expect(ctx.computerUse.providerName).toBe('muse-computer')
    } finally {
      closed.resolve()
    }
    expect(await failure).toEqual(new Error('invalid client activation'))
    expect(ctx.computerUse.providerName).toBeUndefined()
  })
})
