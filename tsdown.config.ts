import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 *
 * `packages/drama/skills` is a workspace package that ships static skill
 * resources and has no JavaScript entry at all, so the workspace-wide entry
 * glob cannot resolve it; exclude it rather than give it an empty build.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  const resourceOnly = '!packages/drama/skills'
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', resourceOnly, 'apps/cli']
      : ['vendor/*', 'packages/*/*', resourceOnly, 'apps/cli', 'apps/desktop', 'apps/desktop-host'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
