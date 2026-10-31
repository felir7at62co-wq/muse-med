/** Final release recording compares the active archived parser with the patched source dependency. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { WriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { afterEach, expect, it } from 'vitest'
import { packagedPiAiArchive, sourcePiAiCompletionsModule, verifyPackagedPiAiPatch } from '../scripts/verify-packaged-pi-ai.mjs'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = builderRequire('@electron/asar') as {
  createPackageWithOptions: (source: string, destination: string, options: { unpack?: string }) => Promise<WriteStream>
}
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const activeModule = join('dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.js')

async function fixture(options: { changed?: boolean; missing?: boolean; unpack?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-packaged-pi-ai-'))
  roots.push(root)
  const source = join(root, 'source'), archive = join(root, 'app.asar')
  const original = await readFile(sourcePiAiCompletionsModule())
  await mkdir(dirname(join(source, activeModule)), { recursive: true })
  if (!options.missing) await writeFile(join(source, activeModule), options.changed ? '/* unpatched active module */\n' : original)
  await writeFile(join(source, 'unused-patched-copy.js'), original)
  const output = await createPackageWithOptions(source, archive, options.unpack ? { unpack: '**/openai-completions.js' } : {})
  await finished(output, { cleanup: true })
  return { archive, original, root }
}

it.each(['mac-arm64', 'win-x64'] as const)('selects the real %s application archive', (target) => {
  const root = join(tmpdir(), 'target-artifacts')
  expect(packagedPiAiArchive(target, root)).toBe(target === 'mac-arm64'
    ? join(root, 'mac-arm64', 'muse-med.app', 'Contents', 'Resources', 'app.asar')
    : join(root, 'win-unpacked', 'resources', 'app.asar'))
})

it.each([false, true])('accepts byte-identical patched source with unpack=%s', async (unpack) => {
  const f = await fixture({ unpack })
  await expect(verifyPackagedPiAiPatch(f.archive)).resolves.toEqual({ module: activeModule,
    sha256: createHash('sha256').update(f.original).digest('hex') })
})

it('rejects an unpatched active module even when another archived copy is patched', async () => {
  const f = await fixture({ changed: true })
  await expect(verifyPackagedPiAiPatch(f.archive)).rejects.toThrow('active module differs from the patched source dependency')
})

it('rejects a missing active module', async () => {
  const f = await fixture({ missing: true })
  await expect(verifyPackagedPiAiPatch(f.archive)).rejects.toThrow()
})

it('rejects absent source dependency bytes', async () => {
  const f = await fixture()
  await expect(verifyPackagedPiAiPatch(f.archive, join(f.root, 'missing-source.js'))).rejects.toThrow('ENOENT')
})
