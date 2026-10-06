/**
 * Root tsdown workspace membership: the root config's wildcard patterns are the
 * build's inbox, and each directory they enumerate inherits the root `entry`
 * glob, which then resolves inside that directory.
 *
 * tsdown enumerates directories, not manifests. A package directory left behind
 * without its own `package.json` therefore still becomes a target, finds no
 * entry, and fails as `[@deepseek-ai/dsh-root]` — the nearest manifest above it,
 * naming a package this build never touched. Keeping the enumeration
 * manifest-backed keeps that failure naming the directory at fault.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Wildcard members of the root `workspace` list (`tsdown.config.ts`); the literal members are fixed application directories. */
const WORKSPACE_WILDCARDS = ['vendor/*', 'packages/*/*'] as const

/** The root config's ignore list, written without extglob because `node:fs` globs do not support it. */
const WORKSPACE_IGNORE = ['**/node_modules/**', '**/dist/**', '**/test/**', '**/tests/**', '**/temp/**', '**/tmp/**']

const repositoryRoot = resolve(import.meta.dirname, '..')

describe('root tsdown workspace', () => {
  it('bundles Desktop only after its workspace dependencies', () => {
    const config = readFileSync(join(repositoryRoot, 'tsdown.config.ts'), 'utf8')
    const workspace = config.match(/workspace: client\s*\?\s*\[([^\]]*)\]\s*:\s*\[([^\]]*)\]/u)
    expect(workspace).not.toBeNull()
    for (const face of workspace!.slice(1)) expect(face).not.toMatch(/['"]apps\/desktop['"]/u)
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(manifest.scripts['build:lib:host']).toContain('tsdown --config-loader native --env.DSH_BUILD_FACE host && pnpm --filter @deepseek-ai/dsh-desktop run bundle')
  })

  it('enumerates only directories that own a manifest', () => {
    const orphans = WORKSPACE_WILDCARDS.flatMap(pattern => globSync(pattern, {
      cwd: repositoryRoot,
      withFileTypes: true,
      exclude: WORKSPACE_IGNORE,
    }))
      // `packages/*/*` also matches files sitting directly in a group directory.
      .filter(entry => entry.isDirectory())
      .map(entry => join(entry.parentPath, entry.name))
      .filter(directory => !existsSync(join(directory, 'package.json')))
      .map(directory => directory.slice(repositoryRoot.length + 1).split('\\').join('/'))

    expect(orphans).toEqual([])
  })
})
