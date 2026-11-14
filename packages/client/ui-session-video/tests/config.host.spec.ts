/** Page bootstrap contains only live presentation policy and follows the Host plugin lifetime. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { SESSION_VIDEO_CONFIG_GLOBAL } from '../src/config.ts'

/** This bootstrap listener reads no Peer-specific fields. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

it('publishes the current switch without media or credentials and releases the generated-form policy', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  let enabled = false
  const release = vi.fn<() => void>()
  const configure = vi.fn<(options: { auto: boolean }, owner: unknown) => () => void>(() => release)
  ctx.provide('settings', { configure })
  let owner: unknown
  const fiber = ctx.plugin((scope) => { owner = scope.fiber; apply(scope, { enabled: { get: () => enabled }, pixelsPerSecond: 64 }) })
  await fiber.await()
  await ctx.fiber.await()
  expect(configure).toHaveBeenCalledOnce()
  expect(configure.mock.calls[0]?.[0]).toEqual({ auto: false })
  expect(configure.mock.calls[0]?.[1] === owner).toBe(true)
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toEqual([{ kind: 'global', name: SESSION_VIDEO_CONFIG_GLOBAL, value: { enabled: false, pixelsPerSecond: 64 } }])
  enabled = true
  table.length = 0
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toEqual([{ kind: 'global', name: SESSION_VIDEO_CONFIG_GLOBAL, value: { enabled: true, pixelsPerSecond: 64 } }])
  await fiber.dispose()
  table.length = 0
  ctx.emit('webserver/index-inject', table, PAGE_PEER)
  expect(table).toEqual([])
  expect(release).toHaveBeenCalledOnce()
})
