import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { expect, it } from 'vitest'

const patchPath = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))

it('keeps the harness identity line out of every product agent prompt', () => {
  // The model repeats its own system prompt to the team, so the product must not
  // tell it that it is powered by the upstream harness.
  const patch = loadOverlayPatches('muse-med', patchPath).find(row => row.id === 'system-prompt')
  expect(patch?.config).toMatchObject({ includeHarnessIdentity: false })
  // A patch replaces the whole config, so the base bundle's own persona prefix has
  // to be restated rather than silently dropped.
  expect(patch?.config).toHaveProperty('personaPrefix')
})

it('ships discoverable computer controls only on the qualified Windows target', () => {
  const patches = loadOverlayPatches('muse-med', patchPath)
  const entries = patches.flatMap(patch => patch.insert ?? [])
  const registry = entries.find(row => row.id === 'computer-use')
  const provider = entries.find(row => row.id === 'muse-computer-use')
  const unavailable = { __jsExpr: "process.platform !== 'win32' || process.arch !== 'x64'" }
  expect(registry?.name).toBe('@deepseek-ai/dsh-computer-use')
  expect(registry?.disabled).toEqual(unavailable)
  expect(provider?.name).toBe('@deepseek-ai/dsh-desktop-host/computer-use')
  expect(provider?.disabled).toEqual(unavailable)
  expect(provider?.config).toMatchObject({ args: ['mcp'] })
  const discovery: unknown = entries.find(row => row.id === 'tool-discovery')?.config
  const capability: unknown = expect.objectContaining({ id: 'computer-use', tools: ['mcp__muse-computer__*'] })
  const capabilities: unknown = expect.arrayContaining([capability])
  expect(discovery).toMatchObject({ capabilities })
  expect(discovery).toHaveProperty('keywords.mcp__muse-computer__list_windows',
    ['操作电脑', '操作软件', '查找窗口', '桌面操作', '点击按钮', '帮我操作', 'computer use'])
  expect(discovery).toHaveProperty('keywords.mcp__muse-computer__launch_app', ['打开软件', '启动应用', '打开程序', 'launch app'])
  expect(discovery).not.toHaveProperty('keywords.mcp__muse-computer__list_apps')
})
