/** Desktop-owned dependencies must participate in preset discovery outside the checkout. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { createProfileResolutionGeneration, PluginPackages } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'

it('routes product preset packages from the complete runtime dependency closure, not a CLI or Host subgraph', async () => {
  const source = readFileSync(new URL('../../desktop-host/src/index.ts', import.meta.url), 'utf8')
  expect(source).toMatch(/createProfileResolutionGeneration\(\{\s*installAnchor: join\(absoluteRuntime, 'package.json'\)/u)
  const root = mkdtempSync(join(tmpdir(), 'desktop-resolution-'))
  try {
    const host = JSON.parse(readFileSync(new URL('../../desktop-host/package.json', import.meta.url), 'utf8')) as { name: string; dependencies: Record<string, string> }
    const community = ['dsh-codex-subscription', 'dsh-ffmpeg', '@mengyuly/dsh-ponytail']
    for (const name of [host.name, ...Object.keys(host.dependencies), ...community]) {
      const dir = join(root, 'runtime/node_modules', name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify(name === host.name ? host : { name, version: '1.0.0' }))
    }
    writeFileSync(join(root, 'runtime/package.json'), JSON.stringify({ name: 'desktop-runtime', dependencies: Object.fromEntries([host.name, ...community].map(name => [name, '1.0.0'])) }))
    const home = join(root, 'home')
    const cli = await createProfileResolutionGeneration({ installAnchor: join(root, 'runtime/node_modules/@deepseek-ai/dsh/package.json'), home })
    const generation = await createProfileResolutionGeneration({ installAnchor: join(root, 'runtime/package.json'), home })
    const ctx = new Context()
    await ctx.plugin(PluginPackages, { generation })
    try {
      const profileBase = pathToFileURL(join(home, 'profiles/desktop/')).href
      for (const name of [...community, ...['guard-drama', 'tool-drama-assets', 'tool-shot-script', 'tool-episode-render', 'perception-bgm'].map(suffix => `@deepseek-ai/dsh-${suffix}`)]) {
        expect(cli.entries.some(entry => entry.name === name)).toBe(false)
        expect(ctx.get('pluginPackages')?.packageOf(name, profileBase)?.dir).toBe(join(root, 'runtime/node_modules', name))
      }
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
