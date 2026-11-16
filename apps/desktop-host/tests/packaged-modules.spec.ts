/** Packaged plugin overrides remain importable from native installation paths. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { packagedModuleOverrides } from '../src/packaged-modules.ts'

it('imports packaged overrides from a directory containing spaces and Chinese characters', async ({ onTestFinished }) => {
  const root = await mkdtemp(join(tmpdir(), 'muse packaged 插件 '))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'workspace-owned-storage.js'), 'export const plugin = "workspace"\n'),
    writeFile(join(root, 'retired-bot.js'), 'export const plugin = "retired"\n'),
  ])
  const overrides = packagedModuleOverrides(pathToFileURL(join(root, 'index.js')).href)

  for (const [name, url] of Object.entries(overrides)) {
    expect(new URL(url).protocol).toBe('file:')
    await expect(import(url)).resolves.toMatchObject({ plugin: name === 'muse-workspace-owned-storage' ? 'workspace' : 'retired' })
  }
})
