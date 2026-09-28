/** The row's Remote surface over a real profile, patch file, and settings service. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { RegisterAppPort } from '../src/login.ts'
import { FeishuSetupService } from '../src/service.ts'
import { FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_NAMESPACE } from '../src/settings.ts'
import { feishuProfile, rowConfig, storedRows, type FeishuComposition } from './profile.ts'

/** A registration call that answers like the platform, without any request. */
const scannedPort: RegisterAppPort = async (request) => {
  request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/xyz', expireIn: 300 })
  return { client_id: 'cli_x', client_secret: 'sec_x', user_info: { open_id: 'ou_x' } }
}

/**
 * Mount the row over a booted composition, reading the switch the way the
 * desktop gate does: the `feishu` row's own `enabled` field.
 * @param composition - booted profile composition.
 * @param register - registration call the flow uses.
 * @returns the published service.
 */
async function harness(
  composition: FeishuComposition,
  register: RegisterAppPort = scannedPort,
): Promise<FeishuSetupService> {
  const { ctx } = composition
  await ctx.plugin(FeishuSetupService, {
    register,
    enabled: () => rowConfig(ctx, FEISHU_SETTINGS_NAMESPACE)?.['enabled'] === true,
    settings: ctx.get('settings') as SettingsForms,
    loader: ctx.loader,
  })
  return ctx.get('feishuSetup') as FeishuSetupService
}

describe('FeishuSetupService', () => {
  it('writes the bridge section read-merge-write, leaving every other key intact', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: { ordinary: 'bridge', appId: 'cli_old', autoRegistration: true } },
    ])
    const service = await harness(composition)
    await service.setCredentials({ appId: 'cli_new', appSecret: 'sec_new' })

    // Only the target keys move; every key the bridge owns stays as the
    // operator left it, because the write merges into the stored section.
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toMatchObject({
      ordinary: 'bridge', appId: 'cli_new', appSecret: 'sec_new', autoRegistration: true,
    })
    // The write reached the running entry, so the next read sees it live.
    expect(rowConfig(composition.ctx, FEISHU_CHANNEL_ROW_ID)).toMatchObject({ appId: 'cli_new' })
    expect(await service.status()).toMatchObject({ appId: 'cli_new', credential: 'manual' })
  })

  it('publishes the six setup methods', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)
    expect(remoteMethods(service).map(entry => entry.method).sort())
      .toEqual(['beginLogin', 'cancelLogin', 'forget', 'setCredentials', 'setEnabled', 'status'])
  })

  it('stores the scanned pair in the bridge section, and never answers with it', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)
    expect(await service.status())
      .toMatchObject({ enabled: false, credential: 'none', appId: '', writable: true, login: null })

    const ticket = await service.beginLogin()
    expect(ticket.url).toBe('https://open.feishu.cn/scan/xyz')
    await vi.waitFor(async () => {
      expect((await service.status()).credential).toBe('registered')
    })
    // The pair landed in the bridge row's own section, which is the Config the
    // Loader resolves for that plugin, and the section reports only that the
    // secret is set.
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID))
      .toMatchObject({ appId: 'cli_x', appSecret: 'sec_x', registeredBy: 'ou_x' })
    expect(await service.status()).toMatchObject({ appId: 'cli_x' })
    expect(JSON.stringify(await service.status())).not.toContain('sec_x')
    expect(composition.ctx.get('settings')!.describe({ redactSecrets: true })
      .find(section => section.ns === FEISHU_CHANNEL_ROW_ID)?.secrets)
      .toContainEqual({ path: ['appSecret'], set: true })

    // A hand-entered pair keeps the stored secret and drops the scanner mark.
    await service.setCredentials({ appId: 'cli_manual', appSecret: '' })
    expect(await service.status()).toMatchObject({ appId: 'cli_manual', credential: 'manual' })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID))
      .toMatchObject({ appId: 'cli_manual', appSecret: 'sec_x', registeredBy: '' })

    await service.forget()
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID) ?? {}).not.toHaveProperty('appSecret')
    expect(await service.status()).toMatchObject({ enabled: false, credential: 'none', appId: '' })
  })

  it('writes the pair and the switch without a restart in between', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)

    await service.setCredentials({ appId: 'cli_manual', appSecret: 'sec_manual' })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID))
      .toMatchObject({ appId: 'cli_manual', appSecret: 'sec_manual' })
    // The switch is its own row's Config, so the write and the read agree in
    // this boot; the bridge row's activation key follows at the next one, which
    // is what the page reports as `restart-pending`.
    expect(await service.setEnabled({ enabled: true }))
      .toMatchObject({ enabled: true, row: 'restart-pending' })
    expect(storedRows(composition.patchPath).get(FEISHU_SETTINGS_NAMESPACE)).toMatchObject({ enabled: true })
    expect(rowConfig(composition.ctx, FEISHU_SETTINGS_NAMESPACE)?.['enabled']).toBe(true)
  })

  it('reports the row active once the composition carried the switch into it', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch', enabled: true } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: { ordinary: 'bridge', enabled: true } },
    ])
    const service = await harness(composition)

    expect(await service.status()).toMatchObject({ enabled: true, row: 'active' })
  })

  it('names the reason, never the secret, when this composition mounts no bridge row', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
    ])
    const service = await harness(composition)

    expect(await service.status()).toMatchObject({ row: 'unavailable', writable: false })
    const failure = await service.setCredentials({ appId: 'cli_x', appSecret: 'sec_leak' }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; message: string; details?: unknown },
    )

    // The section belongs to the composition entry, so a composition that
    // mounts no bridge row says which row is missing instead of quoting the
    // settings service's own message.
    expect(failure?.code).toBe('feishu/credentials-unwritable')
    expect(failure?.details).toEqual({ reason: 'section-unregistered' })
    expect(failure?.message).toMatch(/feishu-channel/u)
    expect(JSON.stringify(failure)).not.toContain('sec_leak')
  })

  it('reports a schema refusal as a bounded reason without the refused pair', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)

    const failure = await service.setCredentials({ appId: 'not-an-app-id', appSecret: 'sec_leak' }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; message: string; details?: unknown },
    )

    expect(failure?.code).toBe('feishu/credentials-unwritable')
    expect(failure?.details).toEqual({ reason: 'write-rejected' })
    expect(JSON.stringify(failure)).not.toContain('sec_leak')
    expect(JSON.stringify(storedRows(composition.patchPath))).not.toContain('sec_leak')
  })

  it('requires a secret while none is stored, and keeps a stored one when blank', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)

    const failure = await service.setCredentials({ appId: 'cli_x', appSecret: '' }).then(
      () => undefined,
      (error: unknown) => error as { code?: string; message: string },
    )
    expect(failure?.code).toBe('feishu/secret-required')
    expect(failure?.message).toMatch(/no app secret is stored/u)
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toBeUndefined()

    // Once a secret is stored, a blank field means "keep it".
    await service.setCredentials({ appId: 'cli_x', appSecret: 'sec_x' })
    await service.setCredentials({ appId: 'cli_y', appSecret: '' })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID))
      .toMatchObject({ appId: 'cli_y', appSecret: 'sec_x' })
    expect(await service.status()).toMatchObject({ credential: 'manual' })
  })

  it('passes a registration call that throws before it answers straight through', async () => {
    const composition = await feishuProfile()
    // Not a platform refusal: nothing bounded can describe a Host-side fault,
    // so it reaches the page as the infrastructure failure it is.
    const unwired = new Error('registration bridge is not wired')
    const service = await harness(composition, () => { throw unwired })

    await expect(service.beginLogin()).rejects.toBe(unwired)
  })

  it('reports a failed scan as a code, and a withdrawal clears the pending ticket', async () => {
    const failing = await feishuProfile()
    const failingService = await harness(failing, async () => {
      throw Object.assign(new Error('app_secret=sec_leak'), { code: 'invalid_request' })
    })
    // The platform's code is the page's reason; the platform's own text (which
    // here quotes request material) never crosses.
    const refusal = await failingService.beginLogin().then(
      () => undefined,
      (error: unknown) => error as { code?: string; message: string; details?: unknown },
    )
    expect(refusal?.code).toBe('feishu/login-failed')
    expect(refusal?.details).toEqual({ code: 'invalid_request' })
    expect(JSON.stringify(refusal)).not.toContain('sec_leak')
    expect((await failingService.status()).lastError).toBe('invalid_request')

    const pending = await feishuProfile()
    const pendingService = await harness(pending, async (request) => {
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/pending', expireIn: 60 })
      return await new Promise<never>(() => {})
    })
    expect((await pendingService.beginLogin()).url).toContain('/pending')
    expect((await pendingService.status()).login?.url).toContain('/pending')
    expect((await pendingService.cancelLogin()).login).toBeNull()
  })
})

describe('an upgraded product home', () => {
  /** What the product line stored before the settings service became Config-derived forms. */
  const LEGACY_DOCUMENT = [
    'feishu:',
    '  enabled: true',
    'dsh-lark-bridge:',
    '  appId: cli_legacy',
    '  appSecret: hunter2-legacy-secret',
    '',
  ].join('\n')

  it('carries the legacy document into both rows and keeps it as the backup', async () => {
    const composition = await feishuProfile(undefined, LEGACY_DOCUMENT)
    const service = await harness(composition)

    // Both sections land in the profile patch: the product switch in its own
    // row, and the pair in the bridge row the section was renamed for.
    await vi.waitFor(() => {
      expect(storedRows(composition.patchPath).get(FEISHU_SETTINGS_NAMESPACE)).toMatchObject({ enabled: true })
    })
    await vi.waitFor(() => {
      expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID))
        .toMatchObject({ appId: 'cli_legacy', appSecret: 'hunter2-legacy-secret' })
    })
    // The move is a rename, so the backup is the old document byte for byte.
    expect(existsSync(join(composition.profile.home, 'settings.yaml'))).toBe(false)
    expect(readFileSync(join(composition.profile.home, 'settings.yaml.imported'), 'utf8')).toBe(LEGACY_DOCUMENT)
    // The switch the gate reads is the imported value, and the page still only
    // learns that the migrated secret is set.
    await vi.waitFor(async () => {
      expect(await service.status()).toMatchObject({ enabled: true, appId: 'cli_legacy', credential: 'manual' })
    })
    expect(JSON.stringify(await service.status())).not.toContain('hunter2-legacy-secret')
  })
})
