/** Host-only bootstrap reads accepted live settings and withdraws with its owner. */
import { Context } from '@deepseek-ai/cordis'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it, onTestFinished } from 'vitest'
import * as Host from '../src/index.ts'
import { SESSION_VIDEO_CONFIG_GLOBAL } from '../src/config.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'

it('injects current accepted presentation values without restarting and removes the page listener on unload', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const peer = new Peer(ctx, { principal: { kind: 'owner' } })
  const configuration = await liveConfig(ctx, Host, { enabled: true, pixelsPerSecond: 80 })
  const page = () => {
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table, peer)
    return table
  }
  expect(page()).toEqual([{ kind: 'global', name: SESSION_VIDEO_CONFIG_GLOBAL, value: { enabled: true, pixelsPerSecond: 80 } }])
  await configuration.update({ enabled: false })
  expect(page()).toEqual([{ kind: 'global', name: SESSION_VIDEO_CONFIG_GLOBAL, value: { enabled: false, pixelsPerSecond: 80 } }])
  await configuration.fiber.dispose()
  expect(page()).toEqual([])
})

it('owns the hidden native settings policy for exactly the Host plugin lifetime', () => omitsGeneratedPage(ctx => ctx.plugin(Host)))
