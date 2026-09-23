/** MCP resource ownership in the shipped Desktop composition. */

import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from 'node:fs'
import { c } from 'tar'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { createPluginProfile } from '../src/project-manager.ts'

it('retains shared resources and one drama budget namespace after the Desktop host overlay', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-desktop-profile-mcp-'))
  try {
    const profileDir = join(home, 'profiles', 'desktop')
    createPluginProfile(profileDir)
    const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const sourceRoot = join(repositoryRoot, 'third_party', 'plugins')
    const pins = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8')) as Record<string, { version: string }>
    const version = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version
    const artifacts = join(home, 'artifacts')
    mkdirSync(artifacts)
    for (const [directory, pin] of Object.entries(pins)) {
      const source = join(sourceRoot, directory)
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; version: string; main: string; dependencies?: unknown; dsh?: { bundle?: { patch: string } } }
      const fixture = join(home, directory)
      const pkg = join(fixture, 'package')
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, main: 'lib/index.js', dependencies: {} }))
      writeFileSync(join(pkg, 'lib/index.js'), '')
      writeFileSync(join(pkg, 'SOURCE.json'), JSON.stringify({ hostVersion: version }))
      const patch = manifest.dsh?.bundle?.patch
      if (patch) {
        mkdirSync(join(pkg, patch, '..'), { recursive: true })
        cpSync(join(source, patch), join(pkg, patch))
      }
      c({ sync: true, gzip: true, cwd: fixture, file: join(artifacts, `${manifest.name.replace('@', '').replace('/', '-')}-${pin.version}.tgz`) }, ['package'])
    }
    const host = join(home, 'host')
    mkdirSync(join(host, 'lib'), { recursive: true })
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version }))
    writeFileSync(join(host, 'lib/index.js'), '')
    const project = prepareDevelopmentProject({
      repositoryRoot, communityArtifactsDir: artifacts, projectDir: join(home, 'project'),
      cliDir: join(repositoryRoot, 'apps/cli'), hostDir: host,
      dependencyDir: join(repositoryRoot, 'node_modules/.pnpm/node_modules'),
      release: { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node, pnpmVersion: '11.7.0' },
    })
    const installAnchor = join(project, 'package.json')
    const profile = loadProfileDirectory('dsh desktop', profileDir, installAnchor)
    const overlay = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      loadOverlayPatches('dsh desktop', overlay),
    ], message => warnings.push(message))

    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-drama-settings')).toEqual([
      { id: 'drama-settings', name: '@deepseek-ai/dsh-drama-settings' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-tool-jubian')).toEqual([
      { id: 'tool-jubian', name: '@deepseek-ai/dsh-tool-jubian' },
    ])
    expect(rows.find(row => row.id === 'webserver')?.disabled).toBe(true)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
