import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { disableRetiredBotProfilePatch, disableRetiredSubscriptionProfilePatch, retiredBotProfilePatch } from '../src/retired-bot-profile.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function profile(): string { const root = mkdtempSync(join(tmpdir(), 'desktop-retired-bot-')); roots.push(root); return root }

it('retains configuration and expressions while disabling all retired Bot insertions and later overrides', () => {
  const root = profile(), path = join(root, 'cordis.patch.yml')
  const original = `# private settings retained beside their owner
- insert:
    - id: named-bot
      name: ds-bot
      config:
        retained: true
      disabled: false
    - id: ordinary
      name: ordinary-plugin
      config:
        # This is data, not a composition row.
        id: muse-bot
        disabled: false
        value: !!js process.env.SYNTHETIC_PREFERENCE
- id: named-bot
  disabled: false
- id: muse-bot
  config:
    source: preserved
  disabled: !!js false
`
  writeFileSync(path, original)
  const backup = disableRetiredBotProfilePatch(root)
  expect(backup).toMatch(/cordis\.patch\.yml\.bot-retired-[a-f0-9-]+\.bak$/)
  expect(readFileSync(backup!, 'utf8')).toBe(original)
  const text = readFileSync(path, 'utf8')
  expect(text).toContain('# private settings retained beside their owner')
  expect(text).toContain('value: !!js process.env.SYNTHETIC_PREFERENCE')
  const warnings: string[] = []
  const entries = applyEntryPatches([], loadOptionalPatches('dsh', path), (message: string) => warnings.push(message))
  expect(warnings).toEqual([])
  expect(entries.find(entry => entry.id === 'named-bot')).toMatchObject({ name: 'ds-bot', disabled: true, config: { retained: true } })
  expect(entries.find(entry => entry.id === 'muse-bot')).toMatchObject({ name: 'ds-bot', disabled: true, config: { source: 'preserved' } })
  expect(entries.find(entry => entry.id === 'ordinary')?.config).toMatchObject({ id: 'muse-bot', disabled: false })
  expect(disableRetiredBotProfilePatch(root)).toBeUndefined()
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(readdirSync(root).filter(name => name.endsWith('.bak'))).toHaveLength(1)
  if (process.platform !== 'win32') for (const file of [path, backup!]) expect(statSync(file).mode & 0o777).toBe(0o600)
})

it('disables retired Bot entries inside groups without editing unrelated plugin configuration', () => {
  const text = '- insert:\n    - id: group\n      name: group\n      group: true\n      config:\n        - id: archived\n          name: ds-bot/client\n          disabled: false\n        - id: muse-bot\n          name: unrelated-plugin\n          disabled: false\n'
  const next = retiredBotProfilePatch(text)
  expect(next).toContain('name: ds-bot/client\n          disabled: true')
  expect(next).toContain('name: unrelated-plugin\n          disabled: false')
  expect(retiredBotProfilePatch(next!)).toBeUndefined()
})

it('disables Bot entries referenced through a YAML alias', () => {
  const text = '- id: ordinary\n  config:\n    template: &archived\n      id: aliased-bot\n      name: ds-bot\n      disabled: false\n- insert: [*archived]\n- id: aliased-bot\n  disabled: false\n'
  const next = retiredBotProfilePatch(text)
  expect(next).toContain('name: ds-bot\n      disabled: true')
  expect(next).toContain('- id: aliased-bot\n  disabled: true')
  expect(retiredBotProfilePatch(next!)).toBeUndefined()
})

it('leaves ordinary, empty and already disabled profile files byte-for-byte unchanged', () => {
  for (const text of ['# retained\n', '[]\n', '- id: user-plugin\n  disabled: false\n', '- insert:\n    - id: muse-bot\n      name: ds-bot\n      disabled: true\n']) expect(retiredBotProfilePatch(text)).toBeUndefined()
})

it('rejects malformed YAML before writing a backup or changing the original', () => {
  const root = profile(), path = join(root, 'cordis.patch.yml'), text = '- id: muse-bot\n  config: [\n'
  writeFileSync(path, text)
  expect(() => disableRetiredBotProfilePatch(root)).toThrow('invalid profile patch')
  expect(readFileSync(path, 'utf8')).toBe(text)
  expect(readdirSync(root)).toEqual(['cordis.patch.yml'])
})

it('keeps old subscription preference overrides addressable and inactive after removing their bundle', () => {
  const root = profile(), path = join(root, 'cordis.patch.yml')
  const original = `# Original subscription preferences
- id: codex-subscription
  config:
    imageViewer: true
    imageAnnotate: true
    retained: !!js process.env.SYNTHETIC_PREFERENCE
- id: llm-subscriptions
  config:
    providers: [codex]
`
  writeFileSync(path, original)
  const current = [{ id: 'llm-subscriptions', name: 'dsh-plugin-subscriptions' }]
  const oldWarnings: string[] = []
  applyEntryPatches(current, loadOptionalPatches('dsh', path), (message: string) => oldWarnings.push(message))
  expect(oldWarnings.some(message => message.includes('not found'))).toBe(true)

  const backup = disableRetiredSubscriptionProfilePatch(root)
  expect(backup).toMatch(/\.subscription-retired-[a-f0-9-]+\.bak$/)
  expect(readFileSync(backup!, 'utf8')).toBe(original)
  const text = readFileSync(path, 'utf8')
  expect(text).toContain('# Original subscription preferences')
  expect(text).toContain('retained: !!js process.env.SYNTHETIC_PREFERENCE')
  const warnings: string[] = []
  const entries = applyEntryPatches(current, loadOptionalPatches('dsh', path), (message: string) => warnings.push(message))
  expect(warnings).toEqual([])
  expect(entries.find(entry => entry.id === 'codex-subscription')).toMatchObject({
    name: 'dsh-codex-subscription', disabled: true, config: { imageViewer: true, imageAnnotate: true },
  })
  expect(entries.find(entry => entry.id === 'llm-subscriptions')).toMatchObject({ name: 'dsh-plugin-subscriptions', config: { providers: ['codex'] } })
  expect(disableRetiredSubscriptionProfilePatch(root)).toBeUndefined()
  expect(readFileSync(path, 'utf8')).toBe(text)
  if (process.platform !== 'win32') for (const file of [path, backup!]) expect(statSync(file).mode & 0o777).toBe(0o600)
})

it('disables custom subscription insertions, client subpaths and later id overrides while retaining unrelated data', () => {
  const root = profile(), path = join(root, 'cordis.patch.yml')
  const original = `- insert:
    - id: custom-subscription
      name: dsh-codex-subscription
      config:
        imageViewer: true
      disabled: false
    - id: group
      name: group
      group: true
      config:
        - id: old-client
          name: dsh-codex-subscription/client
          disabled: false
    - id: ordinary
      name: ordinary-plugin
      config:
        id: codex-subscription
        name: dsh-codex-subscription
        disabled: false
- id: custom-subscription
  disabled: false
`
  writeFileSync(path, original)
  disableRetiredSubscriptionProfilePatch(root)
  const warnings: string[] = []
  const entries = applyEntryPatches([], loadOptionalPatches('dsh', path), (message: string) => warnings.push(message))
  expect(warnings).toEqual([])
  expect(entries.find(entry => entry.id === 'custom-subscription')).toMatchObject({ disabled: true, config: { imageViewer: true } })
  expect(entries.find(entry => entry.id === 'group')).toMatchObject({ config: [{ id: 'old-client', disabled: true }] })
  expect(entries.find(entry => entry.id === 'ordinary')).toMatchObject({ config: { id: 'codex-subscription', name: 'dsh-codex-subscription', disabled: false } })
  expect(readFileSync(readdirSync(root).filter(file => file.endsWith('.bak')).map(file => join(root, file))[0]!, 'utf8')).toBe(original)
  expect(disableRetiredSubscriptionProfilePatch(root)).toBeUndefined()
})

it('boots the replacement provider without importing the retired subscription module for saved preferences', async () => {
  const root = profile(), patchPath = join(root, 'cordis.patch.yml'), basePath = join(root, 'cordis.yml')
  writeFileSync(patchPath, '- id: codex-subscription\n  config:\n    imageViewer: true\n')
  writeFileSync(basePath, JSON.stringify([{ id: 'llm-subscriptions', name: 'dsh-plugin-subscriptions' }]))
  const currentModule = join(root, 'current.mjs'), retiredModule = join(root, 'retired.mjs')
  writeFileSync(currentModule, 'export function apply(ctx) { ctx.provide("fixtureSubscription", { active: true }) }\n')
  writeFileSync(retiredModule, 'throw new Error("Retired subscription module must not be imported")\n')
  disableRetiredSubscriptionProfilePatch(root)
  const ctx = await boot('dsh', basePath, loadOptionalPatches('dsh', patchPath), undefined, undefined, {
    'dsh-plugin-subscriptions': pathToFileURL(currentModule).href,
    'dsh-codex-subscription': pathToFileURL(retiredModule).href,
  })
  try {
    await ctx.loader.await()
    expect(ctx.get('fixtureSubscription')).toEqual({ active: true })
    const retired = [...ctx.loader.entries()].find(entry => entry.options.id === 'codex-subscription')
    expect(retired?.disabled).toBe(true)
    expect(retired?.fiber).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})
