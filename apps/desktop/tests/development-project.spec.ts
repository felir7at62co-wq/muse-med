import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { c } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import type { DesktopRelease } from '../src/release.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-development-test-'))
  roots.push(root)
  return root
}

/** The checkout and artifact directories a development project reads its community pins from. */
function communityFixture(root: string): { repositoryRoot: string; communityArtifactsDir: string } {
  const repositoryRoot = join(root, 'repository')
  mkdirSync(join(repositoryRoot, 'third_party', 'plugins'), { recursive: true })
  writeFileSync(join(repositoryRoot, 'third_party', 'plugins', 'sources.json'), '{}\n')
  const communityArtifactsDir = join(root, 'community')
  mkdirSync(communityArtifactsDir, { recursive: true })
  return { repositoryRoot, communityArtifactsDir }
}

function release(version = '1.2.3'): DesktopRelease {
  return {
    schemaVersion: 1,
    version,
    hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.17.0',
    pnpmVersion: '11.7.0',
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop development project', () => {
  it('includes declared workspace packages missing from the hoist directory in the runtime inventory', () => {
    const root = temporaryRoot()
    const cli = join(root, 'cli')
    const host = join(root, 'host')
    const dependency = join(root, 'unhoisted')
    const hoisted = join(root, 'hoisted')
    mkdirSync(join(cli, 'node_modules'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(dependency)
    mkdirSync(hoisted)
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.2.3', dependencies: { unhoisted: 'workspace:^' } }))
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '1.2.3' }))
    writeFileSync(join(host, 'lib/index.js'), '')
    writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'unhoisted', version: '1.2.3' }))
    symlinkSync(dependency, join(cli, 'node_modules/unhoisted'), process.platform === 'win32' ? 'junction' : 'dir')
    const project = prepareDevelopmentProject({ ...communityFixture(root),
      projectDir: join(root, 'runtime'), cliDir: cli, hostDir: host, dependencyDir: hoisted, release: release(), target: 'mac-arm64' })
    expect(realpathSync(join(project, 'node_modules/unhoisted'))).toBe(realpathSync(dependency))
    const descriptor = JSON.parse(readFileSync(join(project, 'desktop-runtime.json'), 'utf8')) as { platform: string; arch: string; sharedPackages: unknown[] }
    expect(descriptor).toMatchObject({ platform: 'darwin', arch: 'arm64' })
    expect(descriptor.sharedPackages).toContainEqual({ name: 'unhoisted', version: '1.2.3', path: 'node_modules/unhoisted' })
  })

  it('manages development plugins without modifying the linked workspace packages', async () => {
    const root = temporaryRoot()
    const cli = join(root, 'apps', 'cli')
    const host = join(root, 'apps', 'desktop-host')
    const dependencies = join(root, 'workspace-dependencies')
    mkdirSync(join(cli, 'lib'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(join(dependencies, '@scope'), { recursive: true })
    mkdirSync(join(dependencies, '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(join(cli, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.2.3"}\n')
    writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.2.3"}\n')
    writeFileSync(join(host, 'lib', 'index.js'), '')
    writeFileSync(join(dependencies, '@deepseek-ai', 'dsh', 'package.json'), '{}\n')
    mkdirSync(join(dependencies, 'plain-dependency'))
    writeFileSync(join(dependencies, 'plain-dependency', 'package.json'), '{"version":"1.0.0"}\n')
    mkdirSync(join(dependencies, '@scope', 'dependency'))
    writeFileSync(join(dependencies, '@scope', 'dependency', 'package.json'), '{}\n')

    const source = join(root, 'third_party', 'plugins')
    const artifacts = join(root, 'community')
    mkdirSync(join(source, 'dsh-codex-subscription'), { recursive: true })
    mkdirSync(artifacts)
    const packageDir = join(root, 'package')
    mkdirSync(join(packageDir, 'lib'), { recursive: true })
    const pluginManifest = { name: 'dsh-codex-subscription', version: '2.1.5', main: 'lib/index.js', dependencies: { 'plain-dependency': '1.0.0' } }
    writeFileSync(join(source, 'sources.json'), JSON.stringify({ 'dsh-codex-subscription': { version: '2.1.5' } }))
    writeFileSync(join(source, 'dsh-codex-subscription', 'package.json'), JSON.stringify(pluginManifest))
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify(pluginManifest))
    writeFileSync(join(packageDir, 'SOURCE.json'), JSON.stringify({ hostVersion: '1.2.3' }))
    writeFileSync(join(packageDir, 'lib/index.js'), 'module.exports = 42')
    c({ sync: true, gzip: true, cwd: root, file: join(artifacts, 'dsh-codex-subscription-2.1.5.tgz') }, ['package'])
    const project = prepareDevelopmentProject({
      repositoryRoot: root,
      communityArtifactsDir: artifacts,
      projectDir: join(root, 'development'),
      cliDir: cli,
      hostDir: host,
      dependencyDir: dependencies,
      release: release(),
      target: 'win-x64',
    })
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh'))).toBe(realpathSync(cli))
    expect(realpathSync(join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'))).toBe(realpathSync(host))
    expect(realpathSync(join(project, 'node_modules', 'plain-dependency')))
      .toBe(realpathSync(join(dependencies, 'plain-dependency')))
    expect(realpathSync(join(project, 'node_modules', '@scope', 'dependency')))
      .toBe(realpathSync(join(dependencies, '@scope', 'dependency')))
    const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(createRequire(join(project, 'package.json'))('dsh-codex-subscription')).toBe(42)
    expect(realpathSync(join(project, 'node_modules/dsh-codex-subscription/node_modules/plain-dependency'))).toBe(realpathSync(join(dependencies, 'plain-dependency')))
    rmSync(join(artifacts, 'dsh-codex-subscription-2.1.5.tgz'))
    expect(() => prepareDevelopmentProject({
      projectDir: project, cliDir: cli, hostDir: host, dependencyDir: dependencies,
      release: release(), repositoryRoot: root, communityArtifactsDir: artifacts, target: 'win-x64',
    })).toThrow(/community.*missing|missing.*community/u)
    expect(createRequire(join(project, 'package.json')).resolve('dsh-codex-subscription')).toContain('index.js')
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('1.2.3')
    expect(manifest.dependencies['@deepseek-ai/dsh-desktop-host']).toBe('1.2.3')
    expect(manifest.dependencies['dsh-codex-subscription']).toBe('2.1.5')
    writeFileSync(join(packageDir, 'SOURCE.json'), JSON.stringify({ hostVersion: '0.0.1' }))
    c({ sync: true, gzip: true, cwd: root, file: join(artifacts, 'dsh-codex-subscription-2.1.5.tgz') }, ['package'])
    const options = {
      projectDir: project, cliDir: cli, hostDir: host, dependencyDir: dependencies,
      release: release(), repositoryRoot: root, communityArtifactsDir: artifacts, target: 'win-x64',
    } as const
    expect(() => prepareDevelopmentProject(options)).toThrow(/incompatible community artifact/u)
    symlinkSync(dependencies, join(packageDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    c({ sync: true, gzip: true, cwd: root, file: join(artifacts, 'dsh-codex-subscription-2.1.5.tgz') }, ['package'])
    expect(() => prepareDevelopmentProject(options)).toThrow(/unsafe community archive/u)
    const descriptor = JSON.parse(readFileSync(join(project, 'desktop-runtime.json'), 'utf8')) as { platform: string; arch: string }
    expect(descriptor).toMatchObject({ platform: 'win32', arch: 'x64' })
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, 'home')), {
      // This project carries no installed plugins, so neither executable runs.
      node: process.execPath, pnpm: join(root, 'pnpm.cjs'), dsh: project,
    })
    await manager.applyRelease()
    await manager.disableAllPlugins()
    expect(readFileSync(join(cli, 'package.json'), 'utf8')).toBe('{"name":"@deepseek-ai/dsh","version":"1.2.3"}\n')
    expect(readFileSync(join(host, 'lib', 'index.js'), 'utf8')).toBe('')
  })

  it('rejects a CLI package from another release', () => {
    const root = temporaryRoot()
    const cli = join(root, 'apps', 'cli')
    const host = join(root, 'apps', 'desktop-host')
    const dependencies = join(root, 'workspace-dependencies')
    mkdirSync(join(cli, 'lib'), { recursive: true })
    mkdirSync(join(host, 'lib'), { recursive: true })
    mkdirSync(dependencies, { recursive: true })
    writeFileSync(join(cli, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"2.0.0"}\n')
    writeFileSync(join(host, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","version":"1.2.3"}\n')
    writeFileSync(join(host, 'lib', 'index.js'), '')
    expect(() => prepareDevelopmentProject({
      repositoryRoot: root,
      communityArtifactsDir: join(root, 'community'),
      projectDir: join(root, 'development'),
      cliDir: cli,
      hostDir: host,
      dependencyDir: dependencies,
      release: release(),
      target: 'mac-x64',
    })).toThrow(/must be @deepseek-ai\/dsh@1\.2\.3/u)
  })
})
