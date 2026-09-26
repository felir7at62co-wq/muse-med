/**
 * Real-composition gate for the bundled Feishu bridge row: this product's own
 * settings document decides whether the Loader ever imports that row's plugin.
 * The row's `config.enabled` cannot carry that decision, because the staged
 * package resolves it through the bridge's own stored settings section, so a
 * value stored there once would keep the bridge active across a restart this
 * product never asked for.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import z from '@deepseek-ai/schemastery'
import * as yaml from 'js-yaml'
import { expect, it, vi } from 'vitest'
import { FEISHU_CHANNEL_ROW_ID, feishuGateLayer, readFeishuEnabled } from '../../desktop-host/src/feishu-gate.ts'

const bridgePatch = fileURLToPath(new URL('../../../third_party/plugins/dsh-lark-bridge/cordis.patch.yml', import.meta.url))
const desktopPatch = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const BRIDGE_MODULE = '@moyu-good/dsh-lark-bridge'

/** The activation controls the shipped row composes, in the order the staged bridge's Config declares them. */
const ACTIVATION_CONTROLS = {
  enabled: false,
  autoRegistration: false,
  crossInstanceSync: false,
  requireMention: true,
  denyTools: ['ask_user_question', 'exit_plan_mode'],
}

/** Composition layers of the shipped Desktop profile that concern this row, in application order. */
function feishuLayers(): PatchOptions[][] {
  return [
    loadOverlayPatches('dsh desktop', bridgePatch),
    loadOverlayPatches('dsh desktop', desktopPatch),
  ]
}

/**
 * Boot the composed rows through the real Loader over the real patch files.
 * @param document - settings document text, or undefined for an absent document.
 * @returns what the row's plugin module observed, and the entry state the Loader saw.
 */
async function bootComposition(document: string | undefined): Promise<{
  imported: string[]
  applied: unknown[]
  registerApp: ReturnType<typeof vi.fn>
  fetchCalls: number
  effectiveDisabled: boolean | null | undefined
  effectiveConfig: unknown
  active: boolean
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-feishu-'))
  const ctx = new Context()
  const imported: string[] = []
  const applied: unknown[] = []
  const registerApp = vi.fn()
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected request') })
  try {
    const documentPath = join(root, 'settings.yaml')
    if (document !== undefined) await writeFile(documentPath, document)
    const layers = feishuLayers()
    const gate = feishuGateLayer(composeEntries(layers), documentPath)
    const composed = composeEntries([...layers, gate])
    const row = composed.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)
    if (row === undefined) throw new Error('the composed Desktop layers have no Feishu bridge row')
    // The pinned bridge is built from third_party/plugins by the Desktop package
    // pipeline and is not installed in this workspace, so the row's module is a
    // probe: it records that the Loader reached it, and calls the device-code
    // registration port a credential-less bridge would call while booting.
    const probe = {
      name: 'dsh-lark-bridge',
      inject: [],
      apply: (_ctx: Context, config: unknown) => {
        applied.push(config)
        registerApp()
      },
    }
    const inert = { name: 'inert', inject: [], apply: () => {} }
    const modules = new Map<string, unknown>([
      [BRIDGE_MODULE, probe],
      ['@deepseek-ai/dsh-host-directory-picker-native', inert],
      ['@deepseek-ai/dsh-client-ui-directory-picker-native', inert],
      ['@deepseek-ai/dsh-drama-settings', inert],
      ['@deepseek-ai/dsh-tool-jubian', inert],
    ])

    const config = join(root, 'cordis.yml')
    await writeFile(config, yaml.dump(composed))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
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
    const entries = [...ctx.loader.entries()]
    for (const entry of entries) await entry.fiber?.await()
    const entry = entries.find(candidate => candidate.options.id === FEISHU_CHANNEL_ROW_ID)
    return {
      imported,
      applied,
      registerApp,
      fetchCalls: fetch.mock.calls.length,
      effectiveDisabled: row.disabled,
      effectiveConfig: row.config,
      active: entry?.fiber !== undefined,
    }
  } finally {
    fetch.mockRestore()
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

it('leaves the bundled Feishu bridge unmounted while the product switch is unset', async () => {
  const composition = await bootComposition(undefined)

  // The row is in the composition — the Loader simply never starts it, so the
  // plugin code that opens a control server, writes peer heartbeats, and asks
  // the platform for a device code never runs.
  expect(composition.effectiveDisabled).toBe(true)
  expect(composition.effectiveConfig).toMatchObject(ACTIVATION_CONTROLS)
  expect(composition.active).toBe(false)
  expect(composition.imported).not.toContain(BRIDGE_MODULE)
  expect(composition.applied).toEqual([])
  expect(composition.registerApp).not.toHaveBeenCalled()
  expect(composition.fetchCalls).toBe(0)
})

it('mounts the bundled Feishu bridge only after the stored switch turns it on', async () => {
  const composition = await bootComposition('feishu:\n  enabled: true\n')

  expect(composition.effectiveDisabled).toBe(false)
  expect(composition.active).toBe(true)
  expect(composition.imported.filter(specifier => specifier === BRIDGE_MODULE)).toEqual([BRIDGE_MODULE])
  // A patch replaces the whole config, so the row carries the switch plus every
  // activation control this product keeps closed: turning the bridge on must not
  // turn on QR self-registration or cross-instance synchronization with it.
  expect(composition.effectiveConfig).toEqual({ ...ACTIVATION_CONTROLS, enabled: true })
  expect(composition.applied).toEqual([{ ...ACTIVATION_CONTROLS, enabled: true }])
  // The stub device-code port stands in for the platform call, so one boot shows
  // the row's plugin really ran without a single request leaving the process.
  expect(composition.registerApp).toHaveBeenCalledTimes(1)
  expect(composition.fetchCalls).toBe(0)
})

it('keeps the patch itself a fail-safe for a composition that skips the gate layer', () => {
  const rows = composeEntries(feishuLayers())
  const row = rows.find(candidate => candidate.id === FEISHU_CHANNEL_ROW_ID)

  // Without the gate layer the row must stay off, and the controls the staged
  // package reads must keep it inert even where the Loader does start it.
  expect(row?.disabled).toBe(true)
  expect(row?.config).toEqual(ACTIVATION_CONTROLS)
  // Credentials are entered in this product's own settings namespace; inheriting
  // a host environment variable would silently reuse another deployment's app.
  expect(row?.config).not.toHaveProperty('appId')
  expect(row?.config).not.toHaveProperty('appSecret')
})

it('reads the gate from the settings document the composed provider reads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-feishu-home-'))
  try {
    vi.stubEnv('MUSE_HOME', home)
    const rows = [{ id: FEISHU_CHANNEL_ROW_ID, config: { requireMention: true } }]
    expect(feishuGateLayer(rows)).toEqual([
      { id: FEISHU_CHANNEL_ROW_ID, disabled: true, config: { requireMention: true, enabled: false } },
    ])
    await writeFile(join(home, 'settings.yaml'), 'feishu:\n  enabled: true\n')
    expect(feishuGateLayer(rows)).toEqual([
      { id: FEISHU_CHANNEL_ROW_ID, disabled: false, config: { requireMention: true, enabled: true } },
    ])
    expect(feishuGateLayer([{ id: 'other-row' }])).toEqual([])
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})

it('resolves the stored switch exactly as the settings service resolves that section', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-feishu-document-'))
  const documentPath = join(root, 'settings.yaml')
  const cases: readonly (readonly [string | undefined, boolean])[] = [
    [undefined, false],
    ['', false],
    ['feishu: {}\n', false],
    ['other:\n  enabled: true\n', false],
    ['feishu:\n  enabled: false\n', false],
    ['feishu:\n  enabled: true\n', true],
    // YAML 1.2 core reads this as the string "true", which is not the switch.
    ['feishu:\n  enabled: "true"\n', false],
    // The YAML 1.1 boolean spelling is a string under the provider's schema too.
    ['feishu:\n  enabled: yes\n', false],
  ]
  try {
    for (const [document, enabled] of cases) {
      await rm(documentPath, { force: true })
      if (document !== undefined) await writeFile(documentPath, document)
      expect([document, readFeishuEnabled(documentPath)]).toEqual([document, enabled])
      const ctx = new Context()
      try {
        await ctx.plugin(FileSettingsProvider, { path: documentPath, watch: false })
        const scope = ctx.settings.register('feishu', z.object({ enabled: z.boolean().default(false), appId: z.string() }))
        // A section the provider refuses resolves to the schema default, never
        // to "enabled": the two readings agree on every document.
        expect(scope.get().enabled).toBe(enabled)
      } catch (error) {
        expect([document, enabled, (error as Error).message.length > 0]).toEqual([document, false, true])
      } finally {
        await ctx.fiber.dispose()
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the gate closed on a document it cannot read, without echoing its text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-feishu-invalid-'))
  const documentPath = join(root, 'settings.yaml')
  /** Read once, keeping whether the gate opened and what it reported. */
  const read = (): { enabled: boolean; diagnostics: string } => {
    const lines: string[] = []
    const enabled = readFeishuEnabled(documentPath, message => lines.push(message))
    return { enabled, diagnostics: lines.join('\n') }
  }
  try {
    await writeFile(documentPath, 'feishu: [\n')
    expect(read().enabled).toBe(false)
    expect(read().diagnostics).toMatch(/invalid settings document/u)
    await writeFile(documentPath, '- feishu\n')
    expect(read().enabled).toBe(false)
    expect(read().diagnostics).toMatch(/must be a map of settings sections/u)
    await writeFile(documentPath, 'feishu: enabled\n')
    expect(read().enabled).toBe(false)
    expect(read().diagnostics).toMatch(/section "feishu"/u)
    // The reader quotes the offending source line, and a settings document can
    // hold a `role('secret')` value, so every reason reports position only.
    await writeFile(documentPath, 'feishu:\n  appSecret: hunter2-secret\n  enabled: [\n')
    const syntax = read()
    expect(syntax.enabled).toBe(false)
    expect(syntax.diagnostics).toMatch(/invalid settings document at .*settings\.yaml: .* at line \d+, column \d+/u)
    expect(syntax.diagnostics).not.toMatch(/hunter2-secret/u)
    // An alias bomb is a resource-exhaustion input, not a switch: the reader's
    // own alias limit decides, and the gate never expands it.
    const alias = Array.from({ length: 101 }, () => '*a').join(', ')
    await writeFile(documentPath, `feishu:\n  appId: &a hunter2-secret\n  appSecret: [${alias}]\n`)
    const bomb = read()
    expect(bomb.enabled).toBe(false)
    expect(bomb.diagnostics).toMatch(/cannot be resolved/u)
    expect(bomb.diagnostics).not.toMatch(/hunter2-secret/u)
    // A directory where the document belongs is unreadable, which is not consent.
    await rm(documentPath, { force: true })
    await mkdir(documentPath)
    const unreadable = read()
    expect(unreadable.enabled).toBe(false)
    expect(unreadable.diagnostics).toMatch(/cannot read/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
