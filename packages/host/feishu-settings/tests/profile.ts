/**
 * A real profile, patch file, config editor, and settings service for the row's
 * tests.
 *
 * The row's whole contract is "this composition entry's Config is its settings
 * section", so the tests mount the real services over a synthetic profile: the
 * bundle layer inserts the rows, the profile's own patch layer is where a write
 * lands, and nothing about the settings path is faked. The bridge row stands in
 * for the staged package with the same split it ships: a plain activation key
 * the composition owns, and volatile credential fields the page writes.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import Hmr from '@deepseek-ai/dsh-hmr'

/** Config of the product switch row. */
export const ProbeConfig = z.object({
  ordinary: z.string().required(),
  enabled: z.boolean().default(false).volatile(),
})

/** Config of the bridge row: the composition owns the activation key, the page owns the pair. */
export const BridgeConfig = z.object({
  ordinary: z.string().required(),
  enabled: z.boolean().default(false),
  autoRegistration: z.boolean().default(false),
  // The platform spells an app id `cli_…`, and a section write that fails this
  // pattern is the schema refusal the Remote surface reports as a bounded reason.
  appId: z.string().default('').pattern(/^(?:cli_[A-Za-z0-9]*)?$/u).volatile(),
  registeredBy: z.string().default('').volatile(),
  appSecret: z.string().role('secret').volatile(),
})

/** The row both the product switch and the bridge stand in for. */
export const ProbeRow = { name: 'probe-row', Config: ProbeConfig, apply: () => {} }

/** The bridge row stand-in. */
export const BridgeRow = { name: 'bridge-row', Config: BridgeConfig, apply: () => {} }

/** Rows every harness composition carries: the settings pair plus the two sections this product writes. */
export const FEISHU_ROWS: readonly EntryOptions[] = [
  { id: 'config-editor', name: 'cordis:editor' },
  { id: 'settings', name: 'cordis:settings' },
  { id: 'feishu', name: 'cordis:probe', config: { ordinary: 'switch' } },
  { id: 'feishu-channel', name: 'cordis:bridge', config: { ordinary: 'bridge', appId: '' } },
]

/** One booted composition, its profile, and the file each write lands in. */
export interface FeishuComposition {
  readonly ctx: Context
  readonly profile: ProfileContext
  /** The profile patch this composition's settings service writes. */
  readonly patchPath: string
}

/**
 * Boot a real profile whose rows hold the two sections this product writes.
 * @param rows - composition rows; defaults to {@link FEISHU_ROWS}.
 * @param legacyDocument - text to place at `<home>/settings.yaml` before the boot,
 *   which is how an upgraded product home looks.
 * @returns the booted context and its profile.
 */
export async function feishuProfile(
  rows: readonly EntryOptions[] = FEISHU_ROWS,
  legacyDocument?: string,
): Promise<FeishuComposition> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-composition-')))
  const dir = join(home, 'profiles', 'test')
  onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  if (legacyDocument !== undefined) writeFileSync(join(home, 'settings.yaml'), legacyDocument)
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  return await bootFeishuProfile(profile)
}

/**
 * Dispose the running Loader and boot the same profile from its persisted files.
 * @param composition - running composition whose profile will be reopened.
 * @returns a new context using the same profile and patch file.
 */
export async function restartFeishuProfile(composition: FeishuComposition): Promise<FeishuComposition> {
  await composition.ctx.fiber.dispose()
  return await bootFeishuProfile(composition.profile)
}

/**
 * Boot the stored profile without rewriting its bundle or user patch.
 * @param profile - profile whose files are already initialized.
 * @returns the booted context and its profile.
 */
async function bootFeishuProfile(profile: ProfileContext): Promise<FeishuComposition> {
  const { dir } = profile
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (host) => {
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(host.loader.builtins, { editor: ConfigEditor, settings: Settings, probe: ProbeRow, bridge: BridgeRow })
  })
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(Timer)
  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})
  return { ctx, profile, patchPath: profile.patchPath }
}

/**
 * The live config this composition holds for one row, with volatile fields
 * resolved to the value their reference carries right now.
 * @param ctx - booted composition.
 * @param id - composition row id.
 * @returns the plain config, or undefined when the composition has no such row.
 */
export function rowConfig(ctx: Context, id: string): Record<string, unknown> | undefined {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  const config: unknown = entry?.fiber?.config
  if (typeof config !== 'object' || config === null) return undefined
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    const reference = value as { get?: () => unknown }
    return [key, typeof reference?.get === 'function' ? reference.get() : value]
  }))
}

/** The profile patch document's stored row configs, keyed by row id. */
export function storedRows(patchPath: string): Map<string, Record<string, unknown>> {
  const parsed = yaml.load(readFileSync(patchPath, 'utf8')) as Array<{ id?: string; config?: Record<string, unknown> }> | null
  return new Map((parsed ?? []).flatMap(row => typeof row.id === 'string' ? [[row.id, row.config ?? {}] as const] : []))
}
