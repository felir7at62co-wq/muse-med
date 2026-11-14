import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { HEADER_PRESENTATION_GLOBAL } from '../src/header-presentation.ts'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import {
  DEFAULT_BUSY_ENTER_BEHAVIOR, Config, apply,
} from '@deepseek-ai/dsh-client-ui-conversation'


describe('ui-conversation host', () => {
  it.each(['standard', 'floating'] as const)('publishes the %s header policy only while its Host owner is active', async (headerPresentation) => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const peer: PeerScope = { id: brandString<PeerId>('conversation-index'), ctx, principal: { kind: 'owner' },
      signal: new AbortController().signal, interactions: 'none', dispose: async () => { await ctx.fiber.dispose() } }
    const plugin = ctx.plugin(HostPlugin, { headerPresentation })
    await plugin
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table, peer)
    expect(table).toEqual([{ kind: 'global', name: HEADER_PRESENTATION_GLOBAL, value: headerPresentation }])
    await plugin.dispose()
    const retired: IndexInjection[] = []
    ctx.emit('webserver/index-inject', retired, peer)
    expect(retired).toEqual([])
  })

  it('registers, validates, and disposes the durable busy-Enter preference', async () => {
    const ctx = new Context()
    const configuration = await liveConfig(ctx, { Config, apply })
    const { fiber } = configuration
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({
      busyEnter: DEFAULT_BUSY_ENTER_BEHAVIOR, headerPresentation: 'standard',
    })
    await configuration.update({ busyEnter: 'steer' })
    expect(plainConfig(configuration.fiber.effectiveConfig)).toEqual({ busyEnter: 'steer', headerPresentation: 'standard' })
    await expect(configuration.update({ busyEnter: 'invalid' })).rejects.toThrow()
    await fiber.dispose()
  })
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))
