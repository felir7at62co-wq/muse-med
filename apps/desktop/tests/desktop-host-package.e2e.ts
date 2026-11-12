/** Real private Host tarball admission using the built Desktop runtime files. */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { list } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { resolvePnpmEntrypoint } from '../../../scripts/pnpm-entrypoint.mjs'
import { assertDesktopHostPackageFiles } from '../scripts/prepare-package-set.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const host = join(root, 'apps/desktop-host')

// The mandatory built-bin gate selects lib; the real-API lane runs from source.
it.skipIf(process.env.DSH_EXAMPLE_MODE !== 'lib')('packs the independently loaded Workspace storage entry and refuses a tarball without it', async () => {
  expect(existsSync(join(host, 'lib/workspace-owned-storage.js')), 'Run build:artifacts before this built-package check').toBe(true)
  const directory = await mkdtemp(join(tmpdir(), 'desktop-host-package-'))
  onTestFinished(async () => { await rm(directory, { recursive: true, force: true }) })
  const pnpm = resolvePnpmEntrypoint(join(root, 'node_modules/pnpm/package.json'))
  const packed = await execa(process.execPath, [pnpm, '--dir', host, 'pack', '--pack-destination', directory], {
    cwd: root, timeout: 90_000, killDescendants: true, reject: false,
  })
  expect(packed.timedOut).toBe(false)
  expect(packed.isCanceled).toBe(false)
  expect(packed.signal).toBeUndefined()
  expect(packed.exitCode, packed.stderr).toBe(0)
  const tarballs = (await readdir(directory)).filter(file => file.endsWith('.tgz'))
  expect(tarballs).toHaveLength(1)
  const files: string[] = []
  await list({ file: join(directory, tarballs[0]!), onReadEntry: (entry) => { files.push(entry.path) } })
  expect(() => { assertDesktopHostPackageFiles(files) }).not.toThrow()
  const storage = 'package/lib/workspace-owned-storage.js'
  expect(files).toContain(storage)
  expect(() => { assertDesktopHostPackageFiles(files.filter(file => file !== storage)) }).toThrow(storage)
  for (const helper of ['workspace-owner-lease', 'workspace-storage-composition', 'workspace-handoff',
    'workspace-process-snapshot', 'generation-loop-composition', 'episode-source-authority']) {
    expect(files).not.toContain(`package/lib/${helper}.js`)
  }
})
