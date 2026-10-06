/** The row's Remote surface over a real profile, patch file, and settings service. */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { RegisterAppPort } from '../src/login.ts'
import { FeishuSetupService } from '../src/service.ts'
import { FEISHU_CHANNEL_ROW_ID, FEISHU_SETTINGS_NAMESPACE } from '../src/settings.ts'
import { feishuProfile, restartFeishuProfile, rowConfig, storedRows, type FeishuComposition } from './profile.ts'

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
  it('withdraws conversation bindings when the app or scanner changes', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: { ordinary: 'bridge', appId: 'cli_old', appSecret: 'synthetic-old', registeredBy: 'ou_old', allowFrom: ['ou_old'], activeSessionId: 'session-old' } },
    ])
    const service = await harness(composition)
    await service.setCredentials({ appId: 'cli_new', appSecret: 'synthetic-new' })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toMatchObject({ allowFrom: [], activeSessionId: '' })
    expect(await service.status()).toMatchObject({ appId: 'cli_new', credential: 'manual' })
  })
  it('writes the bridge section read-merge-write, leaving every other key intact', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: { ordinary: 'bridge', appId: 'cli_old', requireMention: false } },
    ])
    const service = await harness(composition)
    await service.setCredentials({ appId: 'cli_new', appSecret: 'sec_new' })

    // Only the target keys move; every key the bridge owns stays as the
    // operator left it, because the write merges into the stored section.
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toMatchObject({
      ordinary: 'bridge', appId: 'cli_new', appSecret: 'sec_new', requireMention: false,
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

  it('reopens a switch-only save with no stored credentials', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)

    expect(await service.setEnabled({ enabled: true }))
      .toMatchObject({ enabled: true, appId: '', credential: 'none' })
    expect(storedRows(composition.patchPath).get(FEISHU_SETTINGS_NAMESPACE)).toMatchObject({ enabled: true })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toBeUndefined()

    const reopened = await restartFeishuProfile(composition)
    const reopenedService = await harness(reopened)
    expect(reopened.ctx).not.toBe(composition.ctx)
    expect(await reopenedService.status())
      .toMatchObject({ enabled: true, appId: '', credential: 'none', writable: true })
    expect(rowConfig(reopened.ctx, FEISHU_CHANNEL_ROW_ID)).toMatchObject({ appId: '' })
    expect(rowConfig(reopened.ctx, FEISHU_CHANNEL_ROW_ID)?.['appSecret']).toBe('')
  })

  it('restores saved credentials through the Loader while reporting only secret presence', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition)
    const credentials = { appId: 'cli_restart', appSecret: 'synthetic-restart-secret' }

    expect(await service.setCredentials(credentials)).toMatchObject({ appId: credentials.appId, credential: 'manual' })
    await service.setEnabled({ enabled: true })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toMatchObject(credentials)
    const storedPatch = readFileSync(composition.patchPath, 'utf8')

    const reopened = await restartFeishuProfile(composition)
    const reopenedService = await harness(reopened)
    expect(reopened.ctx).not.toBe(composition.ctx)
    expect(readFileSync(reopened.patchPath, 'utf8')).toBe(storedPatch)
    expect(rowConfig(reopened.ctx, FEISHU_CHANNEL_ROW_ID)).toMatchObject(credentials)
    const status = await reopenedService.status()
    expect(status).toMatchObject({ enabled: true, appId: credentials.appId, credential: 'manual' })
    expect(status).not.toHaveProperty('appSecret')
    expect(JSON.stringify(status)).not.toContain(credentials.appSecret)
    const section = reopened.ctx.get('settings')!.describe({ redactSecrets: true })
      .find(candidate => candidate.ns === FEISHU_CHANNEL_ROW_ID)
    expect(section?.secrets).toContainEqual({ path: ['appSecret'], set: true })
    expect(section?.value).not.toHaveProperty('appSecret')
    expect(section?.user).not.toHaveProperty('appSecret')
    expect(JSON.stringify(section)).not.toContain(credentials.appSecret)

    await reopenedService.setCredentials({ appId: 'cli_replaced', appSecret: '' })
    const updated = await restartFeishuProfile(reopened)
    expect(rowConfig(updated.ctx, FEISHU_CHANNEL_ROW_ID))
      .toMatchObject({ appId: 'cli_replaced', appSecret: credentials.appSecret })
    const updatedService = await harness(updated)
    expect(await updatedService.status())
      .toMatchObject({ appId: 'cli_replaced', credential: 'manual' })
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

  it('cancels a pending scan when disabled and forgets an absent bridge section', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch', enabled: true } },
    ])
    let signal: AbortSignal | undefined
    const service = await harness(composition, async (request) => {
      signal = request.signal
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/pending', expireIn: 60 })
      return await new Promise<never>(() => {})
    })
    await service.beginLogin()
    expect((await service.setEnabled({ enabled: false })).login).toBeNull()
    expect(signal?.aborted).toBe(true)
    expect(await service.forget()).toMatchObject({ enabled: false, writable: false, credential: 'none' })
  })

  it('preserves sender and session bindings when the app and scanner stay unchanged', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: {
        ordinary: 'bridge', appId: 'cli_same', appSecret: 'private-test-secret', allowFrom: ['ou_allowed'], activeSessionId: 'session-one',
      } },
    ])
    const service = await harness(composition)
    await service.setCredentials({ appId: 'cli_same', appSecret: '' })
    expect(rowConfig(composition.ctx, FEISHU_CHANNEL_ROW_ID)).toMatchObject({ allowFrom: ['ou_allowed'], activeSessionId: 'session-one' })
  })

  it('clears old bindings when scanning the same app with a different user', async () => {
    const composition = await feishuProfile([
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
      { id: 'feishu-channel', name: 'cordis:bridge', config: {
        ordinary: 'bridge', appId: 'cli_same', appSecret: 'private-test-secret', registeredBy: 'ou_old',
        allowFrom: ['ou_old'], activeSessionId: 'session-one',
      } },
    ])
    const service = await harness(composition, async (request) => {
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/new-user', expireIn: 60 })
      return { client_id: 'cli_same', client_secret: 'private-test-secret', user_info: { open_id: 'ou_new' } }
    })
    await service.beginLogin()
    await vi.waitFor(async () => {
      expect(rowConfig(composition.ctx, FEISHU_CHANNEL_ROW_ID)).toMatchObject({ registeredBy: 'ou_new', allowFrom: [], activeSessionId: '' })
    })
  })

  it('stores a scan without a scanner id as a manual credential', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition, async (request) => {
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/no-user', expireIn: 60 })
      return { client_id: 'cli_test', client_secret: 'private-test-secret' }
    })
    await service.beginLogin()
    await vi.waitFor(async () => { expect((await service.status()).credential).toBe('manual') })
    expect(storedRows(composition.patchPath).get(FEISHU_CHANNEL_ROW_ID)).toMatchObject({ registeredBy: '' })
  })

  it('reports credential persistence failure from the current QR scan without exposing the rejected pair', async () => {
    const composition = await feishuProfile()
    const service = await harness(composition, async (request) => {
      request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/write-rejected', expireIn: 60 })
      return { client_id: 'invalid-app-id', client_secret: 'private-rejected-secret' }
    })
    await service.beginLogin()
    await vi.waitFor(async () => { expect((await service.status()).lastError).toBe('registration-failed') })
    expect(await service.status()).toMatchInlineSnapshot(`
      {
        "appId": "",
        "credential": "none",
        "enabled": false,
        "lastError": "registration-failed",
        "login": null,
        "row": "disabled",
        "writable": true,
      }
    `)
    expect(JSON.stringify(await service.status())).not.toContain('private-rejected-secret')
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
