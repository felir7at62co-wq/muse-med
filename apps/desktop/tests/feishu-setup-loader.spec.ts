/**
 * Real-composition gate for the bundled Feishu bridge row.
 *
 * The shipped patch files decide the row's composition, and the product switch
 * is the `feishu` row's own Config field: the desktop gate carries it into the
 * bridge row's activation key, and the staged package reads that key before it
 * opens a control server, writes peer heartbeats, or asks the platform for a
 * device code. The row stays mounted while the switch is off — a plugin's
 * settings section IS its Config here, so a disabled row would have nowhere to
 * store the pair a scan produces.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { FEISHU_CHANNEL_ROW_ID, FeishuSetupService, type RegisterAppPort } from '@deepseek-ai/dsh-feishu-settings'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { feishuGateLayer, readFeishuEnabled } from '../../desktop-host/src/feishu-gate.ts'

const bridgePatch = fileURLToPath(new URL('../../../third_party/plugins/dsh-lark-bridge/cordis.patch.yml', import.meta.url))
const desktopPatch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const setupPatch = fileURLToPath(new URL('../../../packages/host/feishu-settings/cordis.patch.yml', import.meta.url))
const BRIDGE_MODULE = '@moyu-good/dsh-lark-bridge'
const SETUP_MODULE = '@deepseek-ai/dsh-feishu-settings'

/** The activation controls the shipped row composes, in the order the staged bridge's Config declares them. */
const ACTIVATION_CONTROLS = {
  enabled: false,
  autoRegistration: false,
  crossInstanceSync: false,
  requireMention: true,
  denyTools: ['ask_user_question', 'exit_plan_mode'],
}

/** Composition layers of the shipped Desktop profile that concern these rows. */
function feishuLayers(): PatchOptions[][] {
  return [
    loadOverlayPatches('muse-med', bridgePatch),
    loadOverlayPatches('muse-med', desktopPatch),
    loadOverlayPatches('muse-med', setupPatch),
  ]
}

interface Composition {
  readonly bridgeApplied: unknown[]
  readonly composed: string
  readonly setup: FeishuSetupService | undefined
}

/**
 * Boot the composed rows through the real Loader over the real patch files.
 *
 * The gate is a patch layer appended to the shipped ones, exactly as
 * `desktopComposition` appends it — not a row of its own — so the composed
 * entry keeps its `name` and the Loader reaches the bridge module.
 * @param enabled - the stored product switch, or undefined for an untouched row.
 * @returns what the bridge row's module observed, and the published service.
 */
async function bootComposition(enabled?: boolean): Promise<Composition> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-setup-'))
  const ctx = new Context()
  const bridgeApplied: unknown[] = []
  // The registration call is the only faked piece: it reports a URL and never
  // settles, so a scan started here can never write credentials or reach the network.
  const register: RegisterAppPort = async (request) => {
    request.onQRCodeReady({ url: 'https://open.feishu.cn/scan/fake', expireIn: 300 })
    return await new Promise<never>(() => {})
  }
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('Unexpected request')
  })
  try {
    const stored: PatchOptions[] = enabled === undefined ? [] : [{ id: 'feishu', config: { enabled } }]
    const layers = [...feishuLayers(), stored]
    const gate = feishuGateLayer(composeEntries(layers))
    const composed = composeEntries([...layers, gate])
    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump(composed))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const inert = { name: 'inert', inject: [], apply: () => {} }
    const modules = new Map<string, unknown>([
      [BRIDGE_MODULE, {
        name: 'dsh-lark-bridge',
        inject: [],
        apply: (_ctx: Context, rowConfig: unknown) => {
          bridgeApplied.push(rowConfig)
        },
      }],
      [SETUP_MODULE, {
        name: 'feishu',
        apply: (loaded: Context) => {
          // The row mounts its service inside the injected scope, exactly as the
          // shipped `apply` does, and passes the services it resolved there.
          loaded.inject(['settings'], (scoped: Context) => {
            const loader = scoped.get('loader')
            scoped.plugin(FeishuSetupService, {
              register,
              enabled: () => false,
              settings: scoped.settings,
              ...(loader === undefined ? {} : { loader }),
            })
          })
        },
      }],
      ['@deepseek-ai/dsh-host-directory-picker-native', inert],
      ['@deepseek-ai/dsh-client-ui-directory-picker-native', inert],
      ['@deepseek-ai/dsh-drama-settings', inert],
      ['@deepseek-ai/dsh-tool-jubian', inert],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`Unexpected module ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    return { bridgeApplied, composed: JSON.stringify(composed), setup: ctx.get('feishuSetup') as FeishuSetupService | undefined }
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

it('composes the bridge inert while the product switch is unset, and mounts the row', async () => {
  const composition = await bootComposition()

  // The row is mounted, and the config the staged plugin receives is the one
  // whose `enabled: false` makes it return before every side effect.
  expect(composition.bridgeApplied).toEqual([ACTIVATION_CONTROLS])
  expect(composition.composed).not.toMatch(/appSecret/u)
})

it('turns the bridge row on exactly when the stored switch is on', async () => {
  const composition = await bootComposition(true)

  expect(composition.bridgeApplied).toEqual([{ ...ACTIVATION_CONTROLS, enabled: true }])
})

it('keeps the shipped patch a fail-safe for a composition that skips the gate layer', () => {
  const rows = composeEntries(feishuLayers())
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)

  // Without the gate layer the row carries the controls the staged package
  // reads, and credentials stay absent: inheriting a host environment variable
  // would silently reuse another deployment's app.
  expect(row?.config).toEqual(ACTIVATION_CONTROLS)
  expect(row?.config).not.toHaveProperty('appId')
  expect(row?.config).not.toHaveProperty('appSecret')
  // The product row is shipped without a config, so a profile that stores
  // nothing reads as off.
  expect(rows.find(candidate => candidate.id === 'feishu')?.config).toBeUndefined()
})

it('reads the switch from the composed product row, and only an exact true opens it', () => {
  expect(readFeishuEnabled([])).toBe(false)
  expect(readFeishuEnabled([{ id: 'feishu' }])).toBe(false)
  expect(readFeishuEnabled([{ id: 'feishu', config: {} }])).toBe(false)
  expect(readFeishuEnabled([{ id: 'feishu', config: { enabled: false } }])).toBe(false)
  // YAML 1.2 core reads a quoted value as the string "true", which is not the switch.
  expect(readFeishuEnabled([{ id: 'feishu', config: { enabled: 'true' } }])).toBe(false)
  expect(readFeishuEnabled([{ id: 'feishu', config: { enabled: true } }])).toBe(true)
})

it('gates only the bridge row, and restates its whole config', () => {
  const rows = [{ id: FEISHU_CHANNEL_ROW_ID, config: { requireMention: true } }]

  expect(feishuGateLayer(rows)).toEqual([
    { id: FEISHU_CHANNEL_ROW_ID, config: { requireMention: true, enabled: false } },
  ])
  expect(feishuGateLayer([...rows, { id: 'feishu', config: { enabled: true } }])).toEqual([
    { id: FEISHU_CHANNEL_ROW_ID, config: { requireMention: true, enabled: true } },
  ])
  expect(feishuGateLayer([{ id: 'other-row' }])).toEqual([])
})
