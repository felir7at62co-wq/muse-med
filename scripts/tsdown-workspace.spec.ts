/** Manifest-backed workspace selection and the Desktop bundle's artifact prerequisites. */
import { execFileSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsdown'
import { describe, expect, it, onTestFinished } from 'vitest'
import { buildGates } from './build.ts'
import { workspacePackageGlobs } from './workspace-package-globs.ts'

const repositoryRoot = resolve(import.meta.dirname, '..')
const manifestPatterns = ['vendor/*/package.json', 'packages/*/*/package.json']

describe('root tsdown workspace', () => {
  it('keeps Desktop outside concurrent workspace bundles and waits for the Host artifact graph', async () => {
    const packages = workspacePackageGlobs(globSync(manifestPatterns, { cwd: repositoryRoot }))
    // Keep the compiler config outside the aggregate program and use the generator's source face in this child.
    const inspect = `
      import { registerHooks } from 'node:module'
      const configUrl = ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'tsdown.config.ts')).href)}
      const pluginUrl = ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'packages/typert/generator/src/tsdown-plugin.ts')).href)}
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL === configUrl && specifier === './packages/typert/generator/lib/types/tsdown-plugin.js') {
          return { url: pluginUrl, shortCircuit: true }
        }
        return nextResolve(specifier, context)
      } })
      const { default: config } = await import(configUrl)
      const host = await config({ env: { DSH_BUILD_FACE: 'host' } }, { ci: false })
      const client = await config({ env: { DSH_BUILD_FACE: 'client' } }, { ci: false })
      let invalidFace = null
      try { await config({ env: { DSH_BUILD_FACE: 'unsupported' } }, { ci: false }) }
      catch (error) { invalidFace = error instanceof Error ? error.message : String(error) }
      process.stdout.write(JSON.stringify({ host: host.workspace, client: client.workspace, invalidFace }))
    `
    const actual: unknown = JSON.parse(execFileSync(process.execPath,
      ['--import', 'tsx/esm', '--input-type=module', '-e', inspect],
      { cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000 }))
    expect(actual).toEqual({
      host: [...packages, '!packages/drama/skills', 'apps/cli', 'apps/desktop-host'],
      client: [...packages, '!packages/drama/skills', 'apps/cli'],
      invalidFace: 'tsdown: --env.DSH_BUILD_FACE must be host or client, received unsupported',
    })
    for (const scope of ['complete', 'artifacts'] as const) {
      const gates = new Map(buildGates(repositoryRoot, scope).map(gate => [gate.id, gate]))
      expect(gates.get('host-src')?.needs).toEqual(['native', 'host-typert'])
      expect(gates.get('host-bundle')?.needs).toEqual(['host-src'])
      expect(gates.get('host-bundle')?.args.slice(-6)).toEqual(['exec', 'tsdown', '--config-loader', 'native',
        '--env.DSH_BUILD_FACE', 'host'])
      expect(gates.get('desktop-bundle')?.needs).toEqual(['host-bundle'])
      expect(gates.get('desktop-bundle')?.args.slice(-4)).toEqual(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'bundle'])
      expect(gates.get('client-src')?.needs).toEqual(['desktop-bundle'])
    }
  })

  it('builds manifest owners while excluding a retained directory without a manifest', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-tsdown-manifests-'))
    onTestFinished(() => rm(cwd, { recursive: true, force: true }))
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture-root', type: 'module' }))
    for (const [directory, name] of [['packages/util/owned', 'fixture-owned'], ['vendor/owned', 'fixture-vendor']] as const) {
      const path = join(cwd, directory)
      await mkdir(join(path, 'src'), { recursive: true })
      await writeFile(join(path, 'package.json'), JSON.stringify({ name, type: 'module' }))
      await writeFile(join(path, 'src/index.ts'), 'export const retained = true\n')
    }
    await mkdir(join(cwd, 'packages/util/retired'), { recursive: true })
    const workspace = workspacePackageGlobs(globSync(manifestPatterns, { cwd }))
    expect(workspace.sort()).toEqual(['packages/util/owned', 'vendor/owned'])
    const options = { cwd, config: false as const, entry: ['src/index.ts'], write: false, dts: false, logLevel: 'silent' as const }
    const selected = await build({ ...options, workspace })
    expect(selected.map(bundle => bundle.config.name).sort()).toEqual(['fixture-owned', 'fixture-vendor'])
    await expect(build({ ...options, workspace: ['packages/*/*', 'vendor/*'] })).rejects.toThrow(/entry|input/iu)
  })
})
