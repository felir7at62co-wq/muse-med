/** Host and browser agree on the native header's public startup policy. */
import { Context } from '@deepseek-ai/cordis'
import type { IndexInjection, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Config, apply } from '../src/index.ts'
import * as plugin from '../src/index.ts'
import { HEADER_PRESENTATION_GLOBAL, readHeaderPresentation } from '../src/header-presentation.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

/** The page peer is carried by the event; this preference listener reads none of its fields. */
const PAGE_PEER = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]

afterEach(() => { vi.unstubAllGlobals() })

it.each(['standard', 'floating'] as const)('publishes %s to the page only while its Host plugin is mounted', async (headerPresentation) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const fiber = ctx.plugin(plugin, { headerPresentation })
  await fiber.await()
  const peer = { principal: { kind: 'owner' } } as Parameters<WebServer['renderIndex']>[1]
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table, peer)
  expect(table).toEqual([{ kind: 'global', name: HEADER_PRESENTATION_GLOBAL, value: headerPresentation }])
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, peer)
  expect(after).toEqual([])
})
it('keeps standard navigation when no deployment selected another presentation', () => {
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, undefined)
  expect(Config({}).headerPresentation).toBe('standard')
  expect(readHeaderPresentation()).toBe('standard')
})
it.each(['standard', 'floating'] as const)('projects the Host-selected %s presentation until its plugin is disposed', async (presentation) => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const { fiber } = await liveConfig(ctx, { Config, apply }, { headerPresentation: presentation })
  const rows: IndexInjection[] = []
  ctx.emit('webserver/index-inject', rows, PAGE_PEER)
  expect(rows).toEqual([{ kind: 'global', name: HEADER_PRESENTATION_GLOBAL, value: presentation }])
  const row = rows[0]
  if (row?.kind !== 'global') throw new Error('Host did not publish the startup preference')
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, row.value)
  expect(readHeaderPresentation()).toBe(presentation)
  await fiber.dispose()
  const after: IndexInjection[] = []
  ctx.emit('webserver/index-inject', after, PAGE_PEER)
  expect(after).toEqual([])
})
it.each(['hidden', null, {}, 1])('refuses malformed public header policy %j before registration', (value) => {
  vi.stubGlobal(HEADER_PRESENTATION_GLOBAL, value)
  expect(() => readHeaderPresentation()).toThrow('Invalid conversation header presentation')
})
