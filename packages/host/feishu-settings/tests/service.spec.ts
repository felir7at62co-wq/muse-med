/** The row's Remote surface over a real settings document. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisterAppPort } from '../src/login.ts'
import { BRIDGE_SETTINGS_NAMESPACE } from '../src/settings.ts'
import { FEISHU_CHANNEL_ROW_ID, FeishuSetupService, type FeishuSetupServiceOptions } from '../src/service.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

/** A registration call that answers like the platform, without any request. */
const scannedPort: RegisterAppPort = async (request) => {
  request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/xyz', expireIn: 300 })
  return { client_id: 'cli_x', client_secret: 'sec_x', user_info: { open_id: 'ou_x' } }
}

/** Whether a filesystem error means the document is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The stored section of the bridge's namespace, or undefined when absent. */
async function storedBridgeSection(documentPath: string): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(documentPath, 'utf8').catch((error: unknown) => {
    if (isENOENT(error)) return undefined
    throw error
  })
  if (text === undefined) return undefined
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
 * @param options - the composition's Loader view, and whether the bridge row
 *   registered the section itself before this row mounted.
 * @returns the published service.
 */
async function harness(
  documentPath: string,
  register: RegisterAppPort = scannedPort,
  options: { readonly loader?: FeishuSetupServiceOptions['loader']; readonly bridgeRegistersSection?: boolean } = {},
): Promise<FeishuSetupService> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(FileSettingsProvider, { path: documentPath, watch: false })
  if (options.bridgeRegistersSection === true) {
    // The bridge's own registration: its schema is the owner of this section,
    // and the secret keeps the `role('secret')` every settings surface redacts.
    ctx.settings.register(BRIDGE_SETTINGS_NAMESPACE, z.object({
      enabled: z.boolean().default(true),
      appId: z.string().default(''),
      appSecret: z.string().role('secret').default(''),
    }), { applies: 'restart' })
  }
  const loader = options.loader
  await ctx.plugin(FeishuSetupService, { register, settings: ctx.settings, ...(loader === undefined ? {} : { loader }) })
  return ctx.get('feishuSetup') as FeishuSetupService
}

/**
 * One Loader entry as the service observes it.
 * @param disabled - entry-level switch the composition composed.
 * @param mounted - whether the Loader started the row's plugin at all.
 * @returns the entry.
 */
function bridgeEntry(disabled: boolean, mounted: boolean) {
  return {
    options: { id: FEISHU_CHANNEL_ROW_ID, disabled },
    ...(mounted ? { fiber: { state: 2 } } : {}),
  }
}

/**
 * A settings provider this suite drives directly, for the two refusals the file
 * provider never produces: a deployment that refuses in-process writes, and one
 * whose section name is already taken.
 */
class RefusingProvider extends SettingsProvider {
  constructor(ctx: Context, private readonly refusal: 'writing' | 'registering') {
    super(ctx)
  }

  /** The file provider always accepts writes; these do not. */
  override get writable(): boolean {
    return this.refusal !== 'writing'
  }

  /** The bridge's name taken by another row; this product's own section registers normally. */
  override register: SettingsProvider['register'] = ((ns: string, ...rest: unknown[]) => {
    if (this.refusal === 'registering' && ns === BRIDGE_SETTINGS_NAMESPACE) {
      throw new Error(`settings namespace "${ns}" is already registered`)
    }
    return (SettingsProvider.prototype.register as (...args: unknown[]) => unknown).call(this, ns, ...rest)
  }) as SettingsProvider['register']

  protected override async load(): Promise<Record<string, unknown>> {
    return {}
  }

  protected override async persist(): Promise<void> {}
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

  it('stores the pair at first use when this composition runs no bridge row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      // The reported failure: the switch is already on, so this boot composes
      // no placeholder, and the profile's gate keeps the bridge row disabled
      // (scripts/muse-web.mjs). The section has no other owner, so this product
      // registers it when the page first reads or writes.
      await writeFile(documentPath, 'feishu:\n  enabled: true\n')
      const service = await harness(documentPath, scannedPort, { loader: { entries: () => [bridgeEntry(true, false)] } })
      expect(await service.status()).toMatchObject({ enabled: true, writable: true, credential: 'none' })

      await service.setCredentials({ appId: 'cli_manual', appSecret: 'sec_manual' })

      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_manual', appSecret: 'sec_manual' })
      expect(await service.status()).toMatchObject({ appId: 'cli_manual', credential: 'manual' })
      expect(JSON.stringify(await service.status())).not.toContain('sec_manual')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes through the bridge’s own registration when that row runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      await writeFile(documentPath, 'feishu:\n  enabled: true\n')
      const service = await harness(documentPath, scannedPort, {
        loader: { entries: () => [bridgeEntry(false, true)] },
        bridgeRegistersSection: true,
      })

      await service.setCredentials({ appId: 'cli_manual', appSecret: 'sec_manual' })

      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_manual', appSecret: 'sec_manual' })
      expect(await service.status()).toMatchObject({ credential: 'manual' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the reason, never the secret, when no section can take the pair', async () => {
    for (const [refusal, reason] of [
      ['registering', 'section-unregistered'],
      ['writing', 'provider-read-only'],
    ] as const) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(RefusingProvider, refusal)
      await ctx.plugin(FeishuSetupService, { register: scannedPort, settings: ctx.settings })
      const service = ctx.get('feishuSetup') as FeishuSetupService

      const failure = await service.setCredentials({ appId: 'cli_x', appSecret: 'sec_leak' }).then(
        () => undefined,
        (error: unknown) => error as { code?: string; message: string; details?: unknown },
      )

      expect(failure?.code).toBe('feishu/credentials-unwritable')
      expect(failure?.details).toEqual({ reason })
      expect(failure?.message).toMatch(/dsh-lark-bridge/u)
      expect(JSON.stringify(failure)).not.toContain('sec_leak')
    }
  })

  it('reports a schema refusal as a bounded reason without the refused pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      await writeFile(documentPath, 'feishu:\n  enabled: true\n')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(FileSettingsProvider, { path: documentPath, watch: false })
      // The bridge's own section, resolving an app id the way the platform
      // spells one: a write that fails its schema never persists.
      ctx.settings.register(BRIDGE_SETTINGS_NAMESPACE, z.object({
        appId: z.string().default('').pattern(/^(?:cli_[A-Za-z0-9]*)?$/u),
        appSecret: z.string().role('secret').default(''),
      }), { applies: 'restart' })
      await ctx.plugin(FeishuSetupService, { register: scannedPort, settings: ctx.settings })
      const service = ctx.get('feishuSetup') as FeishuSetupService

      const failure = await service.setCredentials({ appId: 'not-an-app-id', appSecret: 'sec_leak' }).then(
        () => undefined,
        (error: unknown) => error as { code?: string; message: string; details?: unknown },
      )

      expect(failure?.code).toBe('feishu/credentials-unwritable')
      expect(failure?.details).toEqual({ reason: 'write-rejected' })
      expect(JSON.stringify(failure)).not.toContain('sec_leak')
      expect(await readFile(documentPath, 'utf8')).not.toContain('sec_leak')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires a secret while none is stored, and keeps a stored one when blank', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      const service = await harness(documentPath, scannedPort, { loader: { entries: () => [bridgeEntry(true, false)] } })

      const failure = await service.setCredentials({ appId: 'cli_x', appSecret: '' }).then(
        () => undefined,
        (error: unknown) => error as { code?: string; message: string },
      )
      expect(failure?.code).toBe('feishu/secret-required')
      expect(failure?.message).toMatch(/no app secret is stored/u)
      expect(await storedBridgeSection(documentPath)).toBeUndefined()

      // Once a secret is stored, a blank field means "keep it".
      await service.setCredentials({ appId: 'cli_x', appSecret: 'sec_x' })
      await service.setCredentials({ appId: 'cli_y', appSecret: '' })
      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_y', appSecret: 'sec_x' })
      expect(await service.status()).toMatchObject({ credential: 'manual' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stores a scanned pair through the same sink while no bridge row runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    const documentPath = join(root, 'settings.yaml')
    try {
      // The QR path completes inside a process nobody restarted, so it meets
      // exactly the composition a hand-entered pair does.
      await writeFile(documentPath, 'feishu:\n  enabled: true\n')
      const service = await harness(documentPath, scannedPort, { loader: { entries: () => [bridgeEntry(true, false)] } })

      await service.beginLogin()
      await vi.waitFor(async () => {
        expect((await service.status()).credential).toBe('registered')
      })

      expect(await storedBridgeSection(documentPath)).toMatchObject({ appId: 'cli_x', appSecret: 'sec_x' })
      expect(JSON.stringify(await service.status())).not.toContain('sec_x')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes a registration call that throws before it answers straight through', async () => {
    const root = await mkdtemp(join(tmpdir(), 'feishu-settings-'))
    try {
      // Not a platform refusal: nothing bounded can describe a Host-side fault,
      // so it reaches the page as the infrastructure failure it is.
      const unwired = new Error('registration bridge is not wired')
      const service = await harness(join(root, 'settings.yaml'), () => { throw unwired })
      await expect(service.beginLogin()).rejects.toBe(unwired)
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
      // The platform's code is the page's reason; the platform's own text (which
      // here quotes request material) never crosses.
      const refusal = await failing.beginLogin().then(
        () => undefined,
        (error: unknown) => error as { code?: string; message: string; details?: unknown },
      )
      expect(refusal?.code).toBe('feishu/login-failed')
      expect(refusal?.details).toEqual({ code: 'invalid_request' })
      expect(JSON.stringify(refusal)).not.toContain('sec_leak')
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
