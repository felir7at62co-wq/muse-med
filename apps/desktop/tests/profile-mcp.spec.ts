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
    const pins = JSON.parse(readFileSync(join(sourceRoot, 'sources.json'), 'utf8')) as Record<string, { version: string; desktop?: boolean }>
    const version = (JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string }).version
    const artifacts = join(home, 'artifacts')
    mkdirSync(artifacts)
    for (const [directory, pin] of Object.entries({ ...pins, ...JSON.parse(readFileSync(join(sourceRoot, 'owned-downloads.json'), 'utf8')) as Record<string, { version: string; desktop?: boolean }> })) {
      if (pin.desktop === false) continue
      const source = join(sourceRoot, directory)
      const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; version: string; main: string; dependencies?: unknown; dsh?: { bundle?: { patch: string } } }
      const fixture = join(home, directory)
      const pkg = join(fixture, 'package')
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ ...manifest, main: 'lib/index.js', dependencies: {}, peerDependencies: { '@deepseek-ai/dsh': version } }))
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
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(host, 'lib/index.js'), '')
    const defaults = loadOverlayPatches('muse-med', join(repositoryRoot, 'apps/desktop-host/config/defaults.cordis.patch.yml'))
    writeFileSync(join(host, 'cordis.patch.yml'), JSON.stringify(defaults.filter(patch => patch.insert?.some(row => row.id === 'drama-settings'))))
    const project = prepareDevelopmentProject({
      repositoryRoot, communityArtifactsDir: artifacts, projectDir: join(home, 'project'),
      cliDir: join(repositoryRoot, 'apps/cli'), hostDir: host,
      dependencyDir: join(repositoryRoot, 'node_modules/.pnpm/node_modules'),
      release: { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node, pnpmVersion: '11.7.0' },
      // The composed rows are this case's subject; nothing here compares the
      // descriptor's platform or architecture.
      target: 'mac-x64',
    })
    const installAnchor = join(project, 'package.json')
    const profile = loadProfileDirectory('muse-med', profileDir, installAnchor)
    // The running Host applies its own overlay above the bundle and user layers
    // (the product row set below lives there), so composing the profile without
    // it tests a tree no Desktop launch ever mounts.
    const overlay = fileURLToPath(new URL('../../desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
    expect(profile.skippedBundles).toEqual([])
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      loadOverlayPatches('muse-med', overlay),
    ], message => warnings.push(message))

    for (const id of ['agent-notes', 'ui-settings-agent-notes']) {
      expect(rows.find(row => row.id === id), id).toMatchObject({ disabled: true })
    }
    for (const id of ['ui-agent-preset', 'ui-permission', 'ui-plugin-manager', 'ui-settings-plugins', 'ui-settings-plugin-inventory']) {
      expect(rows.find(row => row.id === id), id).toMatchObject({ disabled: true })
    }
    expect(rows.find(row => row.id === 'permission')?.config).toMatchObject({ defaultPreset: 'danger-full-access', registerCommand: false })
    expect(rows.find(row => row.id === 'sandbox-policy')?.config).toMatchObject({ mode: 'danger-full-access' })
    expect(rows.find(row => row.id === 'approval')?.config).toEqual({ policy: 'never' })
    expect(rows.find(row => row.id === 'ui-settings-models')?.config).toEqual({ welcomeNotice: false })
    for (const id of ['agent-team', 'tool-agent-team', 'ui-agent-team', 'auto-review',
      'experimental-inspector', 'session-inspector', 'speech-to-text', 'ui-voice-input']) {
      expect(rows.find(row => row.id === id), id).toBeUndefined()
    }
    expect(rows.find(row => row.id === 'codex-subscription')?.disabled ?? true).toBe(true)
    expect(profile.layers.map(layer => layer.packageName)).not.toContain('dsh-codex-subscription')
    expect(readFileSync(join(project, 'package.json'), 'utf8')).not.toContain('dsh-codex-subscription')
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-resources')).toEqual([
      { id: 'mcp-resources', name: '@deepseek-ai/dsh-mcp-resources' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-mcp-client')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')).toMatchObject({ name: '@deepseek-ai/dsh-host-webserver' })
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-muse-account')).toEqual([
      { id: 'muse-account', name: '@deepseek-ai/dsh-muse-account', inject: ['tools', 'llm', 'sessionProjections', 'agentDefaultModel', 'museDesktopBridge', 'connection', 'webServer'], config: {
        remoteAccess: true, excludedModelPrefixes: [], excludedProviderIds: ['aa'], hiddenProviderIds: ['yunying'], requestTimeoutMs: 60000,
        excludedModels: [
          { providerId: 'yunying', modelId: 'claude-opus-5-5' },
          { providerId: 'yunying', modelId: 'claude-fable-5-1' },
          { providerId: 'yunying', modelId: 'gpt-6-astra' },
          { providerId: 'yunying', modelId: 'glm-5.3-flash' },
        ],
        baseUrl: { __jsExpr: "process.env.MUSE_BASE_URL || 'https://muse.aigc-pipeline.cn'" },
      } },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-client-ui-muse-account')).toEqual([
      { id: 'ui-muse-account', name: '@deepseek-ai/dsh-client-ui-muse-account', config: {
        feedbackUrl: { __jsExpr: "new URL('/feedback', process.env.MUSE_BASE_URL || 'https://muse.aigc-pipeline.cn').href" },
      } },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-drama-settings')).toEqual([
      { id: 'drama-settings', name: '@deepseek-ai/dsh-drama-settings' },
    ])
    expect(rows.filter(row => row.name === 'dsh-skill-mcp-panel')).toEqual([
      { id: 'skill-mcp-panel', name: 'dsh-skill-mcp-panel' },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-tool-jubian')).toEqual([
      { id: 'tool-jubian', name: '@deepseek-ai/dsh-tool-jubian', config: { imagePlatformId: 'KU_AI' } },
    ])
    expect(rows.filter(row => row.name === '@deepseek-ai/dsh-tool-audio-transcribe')).toEqual([])
    expect(rows.find(row => row.id === 'webserver')?.disabled).toBe(false)
    expect(warnings).toEqual([])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
