/**
 * Real-composition gate for the Feishu switch and the setup row.
 *
 * The composed rows come from the shipped patch files, and the Loader starts
 * them for real: the product settings document decides whether the bridge row's
 * plugin code is ever imported, and the setup row answers `beginLogin` with the
 * URL the Host rendered 闁?the registration call itself is a fake, so no request
 * leaves the process.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { FeishuSetupService, type RegisterAppPort } from '@deepseek-ai/dsh-feishu-settings'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { feishuGateLayer } from '../../desktop-host/src/feishu-gate.ts'

const bridgePatch = join(import.meta.dirname, '../../../third_party/plugins/dsh-lark-bridge/cordis.patch.yml')
const desktopPatch = join(import.meta.dirname, '../../desktop-host/config/desktop.cordis.patch.yml')
const setupPatch = join(import.meta.dirname, '../../../packages/host/feishu-settings/cordis.patch.yml')
const BRIDGE_MODULE = '@moyu-good/dsh-lark-bridge'
const SETUP_MODULE = '@deepseek-ai/dsh-feishu-settings'
const SETTINGS_MODULE = '@deepseek-ai/dsh-settings-file'

/** Composition layers of the shipped Desktop profile that concern these rows. */
function feishuLayers(): PatchOptions[][] {
  return [
    loadOverlayPatches('muse-med', bridgePatch),
    loadOverlayPatches('muse-med', desktopPatch),
    loadOverlayPatches('muse-med', setupPatch),
  ]
}

interface Composition {
  readonly imported: string[]
  readonly bridgeApplied: number
  readonly diagnostics: string[]
  readonly composed: string
  readonly setup: FeishuSetupService | undefined
  readonly hasSettings: boolean
}

/**
 * Boot the composed rows through the real Loader over the real patch files.
 * @param document - settings document text, or undefined for an absent document.
 * @param options - `withSettingsProvider` composes the file provider, which fails
 *   loud on a document it cannot parse; the gate must not need it.
 * @returns what the Loader reached, what the gate reported, and the composed rows.
 */
async function bootComposition(
  document: string | undefined,
  options: { withSettingsProvider: boolean } = { withSettingsProvider: true },
): Promise<Composition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-setup-'))
  const ctx = new Context()
  const imported: string[] = []
  let bridgeApplied = 0
  const diagnostics: string[] = []
  // The registration call is the only faked piece: it reports a URL and never
  // settles, so a scan started here can never write credentials or reach the network.
  const register: RegisterAppPort = async (request) => {
    request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/fake', expireIn: 300 })
    return await new Promise(() => {})
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('Unexpected request')
  })
  try {
    const documentPath = join(root, 'settings.yaml')
    if (document !== undefined) await writeFile(documentPath, document)
    const layers = feishuLayers()
    const gate = feishuGateLayer(composeEntries(layers), documentPath, message => diagnostics.push(message))
    const rows = composeEntries([...layers, gate])
    const composed = JSON.stringify(rows)
    if (options.withSettingsProvider) {
      rows.push({
        id: 'settings',
        name: SETTINGS_MODULE,
        config: { path: documentPath, watch: false },
      } as never)
    }
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump(rows))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const inert = { name: 'inert', inject: [], apply: () => {} }
    const modules = new Map<string, unknown>([
      [BRIDGE_MODULE, {
        name: 'dsh-lark-bridge',
        inject: [],
        apply: () => {
          bridgeApplied += 1
        },
      }],
      [SETUP_MODULE, {
        name: 'feishu-settings',
        apply: (loaded: Context) => {
          // The row mounts its service inside the injected scope, exactly as the
          // shipped `apply` does, and passes the services it resolved there.
          loaded.inject(['settings'], (scoped: Context) => {              const loader = scoped.get('loader')
            scoped.plugin(FeishuSetupService, {
              register,
              settings: scoped.settings,
              ...(loader === undefined ? {} : { loader }),
            })
          })
        },
      }],
      [SETTINGS_MODULE, FileSettingsProvider],
      ['@deepseek-ai/dsh-host-directory-picker-native', inert],
      ['@deepseek-ai/dsh-client-ui-directory-picker-native', inert],
      ['@deepseek-ai/dsh-drama-settings', inert],
      ['@deepseek-ai/dsh-tool-jubian', inert],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        imported.push(specifier)
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`Unexpected module ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    return {
      imported,
      bridgeApplied,
      diagnostics,
      composed,
      setup: ctx.get('feishuSetup') as FeishuSetupService | undefined,
      hasSettings: ctx.get('settings') !== undefined,
    }
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

it('keeps the bridge unmounted while the product switch is unset', async () => {
  const composition = await bootComposition(undefined)

  expect(composition.imported).not.toContain(BRIDGE_MODULE)
  expect(composition.bridgeApplied).toBe(0)
  expect(composition.hasSettings).toBe(true)
  expect(composition.setup).toBeDefined()
  expect(await composition.setup?.status()).toMatchObject({ enabled: false, row: 'unavailable' })
})

it('keeps the bridge unmounted on a document it cannot parse, and reports a position only', async () => {
  const composition = await bootComposition('feishu:\n  appSecret: hunter3-secret\n  enabled: [\n', { withSettingsProvider: false })

  // The gate is fail-closed: a document nobody can read is not consent, and it
  // never turns a broken document into a failed boot.
  expect(composition.imported).not.toContain(BRIDGE_MODULE)
  expect(composition.diagnostics.join('\n')).toMatch(/invalid settings document at .*settings\.yaml: .* at line \d+, column \d+/u)
  expect(composition.diagnostics.join('\n')).not.toMatch(/hunter3-secret/u)
  expect(composition.composed).not.toMatch(/hunter3-secret/u)
})

it('mounts the bridge once the stored switch is on, and beginLogin answers with a Host-rendered URL', async () => {
  const composition = await bootComposition('feishu:\n  enabled: true\n')

  expect(composition.imported.filter(specifier => specifier === BRIDGE_MODULE)).toEqual([BRIDGE_MODULE])
  expect(composition.bridgeApplied).toBe(1)
  const ticket = await composition.setup?.beginLogin()
  expect(ticket?.url).toBe('https://open.feishu.cn/scan/fake')
  expect(ticket?.qrDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
  expect(ticket?.expiresInSeconds).toBe(300)
})

it('never composes a stored credential pair into an entry or a diagnostic', async () => {
  const composition = await bootComposition('feishu:\n  enabled: true\ndsh-lark-bridge:\n  appId: cli_secret\n  appSecret: hunter3-secret\n')

  // Credentials live in the bridge's own settings section, which no composed
  // entry and no configuration dump can carry.
  expect(composition.composed).not.toMatch(/hunter3-secret/u)
  expect(composition.diagnostics.join('\n')).not.toMatch(/hunter3-secret/u)
  // This composition mounts no bridge, so the pair is not even readable here:
  // the section belongs to the bridge plugin, which registers it when it runs.
  expect(await composition.setup?.status()).toMatchObject({ enabled: true, credential: 'none' })
  expect(JSON.stringify(await composition.setup?.status())).not.toMatch(/hunter3-secret/u)
})
