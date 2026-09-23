import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { c } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import type { DesktopRelease } from '../src/release.ts'

const roots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-development-test-'))
  roots.push(root)
  return root
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
  it('projects the built dsh and Desktop Host applications with their dependency graph', () => {
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
      release: release(), repositoryRoot: root, communityArtifactsDir: artifacts,
    })).toThrow(/community.*missing|missing.*community/u)
    expect(createRequire(join(project, 'package.json')).resolve('dsh-codex-subscription')).toContain('index.js')
    expect(manifest.dependencies['@deepseek-ai/dsh']).toBe('1.2.3')
    expect(manifest.dependencies['@deepseek-ai/dsh-desktop-host']).toBe('1.2.3')
    expect(manifest.dependencies['dsh-codex-subscription']).toBe('2.1.5')
    writeFileSync(join(packageDir, 'SOURCE.json'), JSON.stringify({ hostVersion: '0.0.1' }))
    c({ sync: true, gzip: true, cwd: root, file: join(artifacts, 'dsh-codex-subscription-2.1.5.tgz') }, ['package'])
    const options = {
      projectDir: project, cliDir: cli, hostDir: host, dependencyDir: dependencies,
      release: release(), repositoryRoot: root, communityArtifactsDir: artifacts,
    }
    expect(() => prepareDevelopmentProject(options)).toThrow(/incompatible community artifact/u)
    symlinkSync(dependencies, join(packageDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    c({ sync: true, gzip: true, cwd: root, file: join(artifacts, 'dsh-codex-subscription-2.1.5.tgz') }, ['package'])
    expect(() => prepareDevelopmentProject(options)).toThrow(/unsafe community archive/u)
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
    })).toThrow(/must be @deepseek-ai\/dsh@1\.2\.3/u)
  })
})
