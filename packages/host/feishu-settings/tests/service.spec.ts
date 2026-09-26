/** The row's Remote surface over a real settings document. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisterAppPort } from '../src/login.ts'
import { BRIDGE_SETTINGS_NAMESPACE } from '../src/settings.ts'
import { FeishuSetupService } from '../src/service.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

/** A registration call that answers like the platform, without any request. */
const scannedPort: RegisterAppPort = async (request) => {
  request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/xyz', expireIn: 300 })
  return { client_id: 'cli_x', client_secret: 'sec_x', user_info: { open_id: 'ou_x' } }
}

/** The stored section of the bridge's namespace, or undefined when absent. */
async function storedBridgeSection(documentPath: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(documentPath, 'utf8')
  const line = text.split(/\r?\n/u).findIndex(candidate => candidate.startsWith(`${BRIDGE_SETTINGS_NAMESPACE}:`))
  if (line === -1) return undefined
  const section: Record<string, unknown> = {}
  for (const candidate of text.split(/\r?\n/u).slice(line + 1)) {
    if (!/^\s/u.test(candidate) || candidate.trim().length === 0) break
    const [key, ...rest] = candidate.trim().split(':')
    if (key !== undefined) section[key] = rest.join(':').trim()
  }
  return section
}

/**
 * Mount the provider and the row over one document.
 * @param documentPath - settings document path, which need not exist.
 * @param register - registration call the flow uses.
 * @returns the published service.
 */
async function harness(documentPath: string, register: RegisterAppPort = scannedPort): Promise<FeishuSetupService> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FileSettingsProvider, { path: documentPath, watch: false })
  await ctx.plugin(FeishuSetupService, { register, settings: ctx.settings })
  return ctx.get('feishuSetup') as FeishuSetupService
}

describe('FeishuSetupService', () => {
  it('writes the bridge section read-merge-write, leaving every other key intact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      // A section the bridge itself owns, carrying keys this product never names.
      await writeFile(documentPath, [
        'dsh-lark-bridge:',
        '  appId: cli_old',
        '  requireMention: false',
        '  controlPort: 40955',
        '  senderAllowlist:',
        '    - ou_keep',
        '',
      ].join('\n'))
      const service = await harness(documentPath)
      await service.setCredentials({ appId: 'cli_new', appSecret: 'sec_new' })

      const text = await readFile(documentPath, 'utf8')
      // Only the two target keys move; every key the bridge owns stays as the
      // operator left it, because the write merges into the stored section.
      expect(text).toContain('appId: cli_new')
      expect(text).toContain('appSecret: sec_new')
      expect(text).toContain('requireMention: false')
      expect(text).toContain('controlPort: 40955')
      expect(text).toContain('ou_keep')
      expect(text).not.toContain('cli_old')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes the six setup methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    try {
      const service = await harness(join(root, 'settings.yaml'))
      expect(remoteMethods(service).map(entry => entry.method).sort())
        .toEqual(['beginLogin', 'cancelLogin', 'forget', 'setCredentials', 'setEnabled', 'status'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores the scanned pair in the bridge section, and never answers with it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      const service = await harness(documentPath)
      expect(await service.status())
        .toMatchObject({ enabled: false, credential: 'none', row: 'unavailable', login: null })

      const ticket = await service.beginLogin()
      expect(ticket.url).toBe('https://open.feishu.cn/scan/xyz')
      await vi.waitFor(async () => {
        expect((await service.status()).credential).toBe('registered')
      })
      // The pair landed in the bridge's own section, which is what the bridge
      // resolves over its composed config.
      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_x', appSecret: 'sec_x' })
      expect(await service.status()).toMatchObject({ appId: 'cli_x' })
      expect(JSON.stringify(await service.status())).not.toContain('sec_x')

      // A hand-entered pair keeps the stored secret and drops the scanner mark.
      await service.setCredentials({ appId: 'cli_manual', appSecret: '' })
      expect(await service.status()).toMatchObject({ appId: 'cli_manual', credential: 'manual' })
      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_manual', appSecret: 'sec_x' })

      await service.forget()
      expect(await storedBridgeSection(documentPath) ?? {}).not.toHaveProperty('appSecret')
      expect(await service.status()).toMatchObject({ enabled: false, credential: 'none', appId: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the pair before the bridge ever runs, because the switch is off', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      const service = await harness(documentPath)
      await service.setCredentials({ appId: 'cli_manual', appSecret: 'sec_manual' })
      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_manual', appSecret: 'sec_manual' })
      // Turning the switch on is the only remaining step; the pair is already
      // where the bridge will read it at the next start.
      expect(await service.setEnabled({ enabled: true })).toMatchObject({ enabled: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to store a pair when this boot composes no bridge section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      // A boot that already has the switch on registers no placeholder, and no
      // bridge is composed here, so there is nowhere to put the pair. Within one
      // process the placeholder stays registered, which is why enabling and then
      // saving works without a restart in between.
      await writeFile(documentPath, 'feishu:\n  enabled: true\n')
      const service = await harness(documentPath)
      expect(await service.status()).toMatchObject({ enabled: true })
      await expect(service.setCredentials({ appId: 'cli_x', appSecret: 'sec_x' }))
        .rejects.toThrow(/bridge-settings-unavailable/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a failed scan as a code, and a withdrawal clears the pending ticket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    try {
      const failing = await harness(join(root, 'settings.yaml'), async () => {
        throw Object.assign(new Error('app_secret=sec_leak'), { code: 'invalid_request' })
      })
      await expect(failing.beginLogin()).rejects.toMatchObject({ code: 'invalid_request' })
      expect((await failing.status()).lastError).toBe('invalid_request')

      const root2 = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
      try {
        const pending = await harness(join(root2, 'settings.yaml'), async (request) => {
          request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/pending', expireIn: 60 })
          return await new Promise(() => {})
        })
        expect((await pending.beginLogin()).url).toContain('/pending')
        expect((await pending.status()).login?.url).toContain('/pending')
        expect((await pending.cancelLogin()).login).toBeNull()
      } finally {
        await rm(root2, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
