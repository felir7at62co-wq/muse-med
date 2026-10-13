/** Desktop bundle ownership keeps Jianying settings editable through the real Loader and page. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { fireEvent, within, waitFor } from '@testing-library/react'
import { afterAll, expect, it, onTestFinished, vi } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { DramaSettingsSchema, DRAMA_SETTINGS_NAMESPACE, apply } from '@deepseek-ai/dsh-drama-settings'
import SettingsController from '../../../packages/api/settings-controller/src/index.ts'
import { configurationFixture } from '../../../packages/settings/settings/tests/configuration-fixture.ts'
import { draftDirectory } from '../../../packages/drama/drama-settings/src/draft-directory.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-settings/types'

// Keep Node's URL and process APIs for the Host Loader while supplying the DOM
// before React initializes. Both compiler faces remain isolated below.
const dom = await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom')
  const instance = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const keys = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'] as const
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const key of keys) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: instance.window[key] })
  return {
    dispose: () => {
      instance.window.close()
      for (const [key, original] of originals) {
        if (original === undefined) Reflect.deleteProperty(globalThis, key)
        else Object.defineProperty(globalThis, key, original)
      }
    },
  }
})

afterAll(dom.dispose)

/** Keep Host and Client Context declarations in their separate compiler programs. */
interface SettingsPageFixture {
  mountSettingsPage(host: {
    describe(): Promise<{ ok: true; value: SettingsDescribeValue }>
    mutate(ns: string, ops: readonly SettingsPathOpView[], revision: number | undefined): Promise<
      { ok: true; value: SettingsNamespaceView } | { ok: false; error: RemoteError }
    >
  }): Promise<{ container: HTMLElement; dispose(): Promise<void> }>
}

const { mountSettingsPage } = await vi.importActual<SettingsPageFixture>(
  '../../../packages/drama/drama-settings/tests/jianying-settings-page.client.tsx',
)

/** Forward test transport calls to the production controller without a scripted settings store. */
function pageTransport(controller: SettingsController) {
  return {
    describe: async () => ({ ok: true as const, value: controller.describe() }),
    mutate: async (ns: string, ops: readonly SettingsPathOpView[], revision: number | undefined) => {
      try {
        return { ok: true as const, value: await controller.mutate(ns, [...ops], revision) }
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error
        return { ok: false as const, error }
      }
    },
  }
}

const defaults = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/defaults.cordis.patch.yml'))
const product = loadOverlayPatches('muse-med', join(import.meta.dirname, '../config/desktop.cordis.patch.yml'))
const dramaRows = defaults.flatMap(patch => patch.insert ?? []).filter(row => row.id === DRAMA_SETTINGS_NAMESPACE)
const dramaOverlays = product.filter(patch => patch.id === DRAMA_SETTINGS_NAMESPACE
  || patch.insert?.some(row => row.id === DRAMA_SETTINGS_NAMESPACE))

/** Mount the shipped settings row with the production settings provider and profile editor. */
async function bench(extraOverlays: PatchOptions[] = []) {
  const fixture = await configurationFixture({ hmr: false, rows: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    ...dramaRows.map(row => ({ ...row, name: 'cordis:drama' })),
  ], builtins: { drama: { Config: DramaSettingsSchema, apply } } })
  await fixture.ctx.fiber.dispose()
  Object.assign(fixture.profile, { overlays: [...dramaOverlays, ...extraOverlays] })
  const ctx = await fixture.start()
  return { ...fixture, ctx, controller: new SettingsController(ctx) }
}

it('declares one drama settings row below profile edits in the shipped Desktop layers', () => {
  expect(dramaRows).toEqual([{ id: DRAMA_SETTINGS_NAMESPACE, name: '@deepseek-ai/dsh-drama-settings' }])
  expect(dramaOverlays).toEqual([])
  const value = String.raw`D:\剪映用户\剪映草稿`
  const warnings: string[] = []
  const rows = composeEntries(
    [defaults, [{ id: DRAMA_SETTINGS_NAMESPACE, config: { jianyingDraftDir: value } }], product],
    message => warnings.push(message),
  )
  expect(rows.filter(row => row.id === DRAMA_SETTINGS_NAMESPACE)).toEqual([
    { id: DRAMA_SETTINGS_NAMESPACE, name: '@deepseek-ai/dsh-drama-settings', config: { jianyingDraftDir: value } },
  ])
  expect(warnings.filter(message => message.includes(DRAMA_SETTINGS_NAMESPACE))).toEqual([])
})

it.each([
  String.raw`C:\Users\mock-user\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft`,
  String.raw`D:\剪映用户\剪映草稿`,
  'D:/剪映用户/剪映草稿/',
])('saves the draft path through the real Host and reads it after restart: %s', async (value) => {
  const { ctx, profile, controller, start } = await bench()
  const view = controller.describe().namespaces.find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)!
  const saved = await controller.mutate(view.ns, [{ op: 'set', path: ['jianyingDraftDir'], value }], view.revision)
  expect(saved.value).toMatchObject({ jianyingDraftDir: value })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('jianyingDraftDir:')
  await ctx.fiber.dispose()
  const restarted = await start()
  expect(restarted.settings.describe().find(row => row.ns === view.ns)?.value).toMatchObject({ jianyingDraftDir: value })
})

it('saves from the rendered Client page into the actual profile and reads it after Host and Client restart', async () => {
  const { ctx, home, profile, controller, start } = await bench()
  const root = join(home, '剪映用户', '剪映草稿')
  mkdirSync(root, { recursive: true })
  const sentinel = join(root, 'existing-draft.json')
  writeFileSync(sentinel, '{"keep":"原始草稿"}\n')
  const before = readFileSync(sentinel)
  const first = await mountSettingsPage(pageTransport(controller))
  onTestFinished(first.dispose)
  const firstPage = within(first.container)
  await waitFor(() => { expect(firstPage.getByLabelText<HTMLInputElement>('JianyingPro draft root').value).toBe('') })
  fireEvent.change(firstPage.getByLabelText('JianyingPro draft root'), { target: { value: root } })
  fireEvent.click(firstPage.getByRole('button', { name: 'Save' }))
  await waitFor(() => { expect(firstPage.getByRole('status').textContent).toBe('Saved.') })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('jianyingDraftDir:')
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'ready', path: normalize(root) })
  await first.dispose()
  await ctx.fiber.dispose()
  const restarted = await start()
  const second = await mountSettingsPage(pageTransport(new SettingsController(restarted)))
  onTestFinished(second.dispose)
  await waitFor(() => { expect(within(second.container).getByLabelText<HTMLInputElement>('JianyingPro draft root').value).toBe(root) })
  expect(readFileSync(sentinel)).toEqual(before)
  expect(readdirSync(root)).toEqual(['existing-draft.json'])
})

it('shows an actual Host override refusal on the Client page and leaves the saved profile untouched', async () => {
  const pinned = 'D:/pinned-mock-drafts'
  const { profile, controller } = await bench([{ id: DRAMA_SETTINGS_NAMESPACE, config: { jianyingDraftDir: pinned } }])
  const before = readFileSync(profile.patchPath, 'utf8')
  const page = await mountSettingsPage(pageTransport(controller))
  onTestFinished(page.dispose)
  const rendered = within(page.container)
  await waitFor(() => { expect(rendered.getByLabelText<HTMLInputElement>('JianyingPro draft root').value).toBe(pinned) })
  fireEvent.change(rendered.getByLabelText('JianyingPro draft root'), { target: { value: 'D:/requested-mock-drafts' } })
  fireEvent.click(rendered.getByRole('button', { name: 'Save' }))
  await waitFor(() => {
    expect(rendered.getByRole('status').textContent).toBe('Could not save: the host refused this write.')
  })
  expect(rendered.queryByText('Saved.')).toBeNull()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  const readback = controller.describe().namespaces.find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)
  expect(readback?.value).toMatchObject({ jianyingDraftDir: pinned })
})

it.each(['home', 'overlay'] as const)('preserves an explicit %s override and refuses the profile write', async (layer) => {
  const pinned = { id: DRAMA_SETTINGS_NAMESPACE, config: { jianyingDraftDir: 'D:/pinned-mock-drafts' } }
  const { controller, home, profile } = await bench(layer === 'overlay' ? [pinned] : [])
  if (layer === 'home') writeFileSync(join(home, 'cordis.patch.yml'), JSON.stringify([pinned]))
  const before = readFileSync(profile.patchPath, 'utf8')
  await expect(controller.mutate(DRAMA_SETTINGS_NAMESPACE, [{ op: 'set', path: ['jianyingDraftDir'], value: 'D:/requested-mock-drafts' }], undefined))
    .rejects.toMatchObject({ code: 'settings/rejected', message: 'Configuration for "drama-settings" is overridden by a home patch or command-line overlay' })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(controller.describe().namespaces.find(row => row.ns === DRAMA_SETTINGS_NAMESPACE)?.value).toMatchObject(pinned.config)
})

it('saves and validates a Chinese mock editor root without changing its existing contents', async () => {
  const { ctx, home, controller } = await bench()
  const root = join(home, '剪映用户', '剪映草稿')
  mkdirSync(root, { recursive: true })
  const sentinel = join(root, 'existing-draft.json')
  writeFileSync(sentinel, '{"keep":"原始草稿"}\n')
  const before = readFileSync(sentinel)
  await controller.mutate(DRAMA_SETTINGS_NAMESPACE, [{ op: 'set', path: ['jianyingDraftDir'], value: root }], undefined)
  expect(await draftDirectory(ctx.settings)).toEqual({ status: 'ready', path: normalize(root) })
  expect(readFileSync(sentinel)).toEqual(before)
  expect(readdirSync(root)).toEqual(['existing-draft.json'])
})

it('keeps relative, missing and file roots out of the validated draft tool setting', async () => {
  const { ctx, home, profile } = await bench()
  const file = join(home, 'not-a-directory')
  writeFileSync(file, 'keep')
  const before = readFileSync(profile.patchPath, 'utf8')
  for (const value of ['relative', join(home, 'missing-剪映草稿'), file]) {
    await expect(draftDirectory(ctx.settings, value)).rejects.toThrow()
    expect(await draftDirectory(ctx.settings)).toEqual({ status: 'unconfigured', path: '' })
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  }
  expect(readFileSync(file, 'utf8')).toBe('keep')
})
