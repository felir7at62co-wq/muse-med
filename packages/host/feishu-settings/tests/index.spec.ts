import { expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as Feishu from '../src/index.ts'
import type { FeishuSetupService } from '../src/service.ts'
import { feishuProfile, restartFeishuProfile, rowConfig, storedRows } from './profile.ts'

it.each([
  { enabled: false, appId: 'cli_stored', appSecret: 'private-stored-secret', active: false },
  { enabled: true, appId: '', appSecret: '', active: false },
  { enabled: true, appId: 'cli_stored', appSecret: '', active: false },
  { enabled: true, appId: 'cli_stored', appSecret: 'private-stored-secret', active: true },
])('activates the composed bridge using startup credentials ($enabled, $appId, $active)', async (options) => {
  const composition = await feishuProfile([
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'feishu', name: 'cordis:feishu', config: { enabled: options.enabled } },
    { id: 'feishu-channel', name: 'cordis:gatedBridge', config: {
      ordinary: 'bridge', enabled: true, appId: options.appId, appSecret: options.appSecret,
    } },
  ])
  expect(rowConfig(composition.ctx, 'feishu-channel')).toMatchObject({ enabled: options.active })
  const setup = composition.ctx.get('feishuSetup') as FeishuSetupService
  expect(await setup.status()).toMatchObject({ enabled: options.enabled })
  await setup.setEnabled({ enabled: !options.enabled })
  await setup.setCredentials({ appId: 'cli_new', appSecret: 'private-new-secret' })
  expect(rowConfig(composition.ctx, 'feishu-channel')).toMatchObject({ enabled: options.active })
  expect(storedRows(composition.patchPath).get('feishu-channel')).toMatchObject({
    appId: 'cli_new', appSecret: 'private-new-secret',
  })
  const reopened = await restartFeishuProfile(composition)
  expect(rowConfig(reopened.ctx, 'feishu-channel')).toMatchObject({ enabled: !options.enabled })
})

it('delegates unrelated and child configurations, and preserves non-object configuration inputs', async () => {
  const composition = await feishuProfile()
  const owner = composition.ctx.plugin(Feishu, { enabled: true })
  await owner.await()
  const ctx = composition.ctx
  const bridge = [...ctx.loader.entries()].find(entry => entry.options.id === 'feishu-channel')!.fiber!
  const unrelated = { enabled: true, marker: 'untouched' }
  expect(ctx.waterfall(ctx.fiber, 'internal/config', unrelated, () => unrelated)).toBe(unrelated)
  const child = bridge.ctx.plugin({ apply: (_ctx: Context, _config: typeof unrelated) => {} }, unrelated)
  await child.await()
  expect(child.config).toBe(unrelated)
  for (const input of [null, ['not-a-config'], 12]) {
    expect(ctx.waterfall(bridge, 'internal/config', input, () => input)).toEqual(input)
  }
  for (const input of [
    {}, { appId: 12 }, { appId: '' }, { appId: 'cli_x' }, { appId: 'cli_x', appSecret: 12 },
  ]) {
    const current = ctx.plugin(Feishu, { enabled: true })
    await current.await()
    expect(ctx.waterfall(bridge, 'internal/config', input, () => input)).toMatchObject({ enabled: false })
    await current.dispose()
  }
})
