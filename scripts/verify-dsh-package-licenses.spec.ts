import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDshPackageLicenses } from './verify-dsh-package-licenses.ts'

const roots: string[] = []
const discoveryDirectory = 'packages/core/tool-discovery'
const discoveryResources = {
  LICENSE: 'MIT License\nCopyright (c) 2026 DeepSeek\n',
  'LICENSE-Codex': 'Apache License\n                           Version 2.0, January 2004\n',
  NOTICE: 'The tool discovery instructions are adapted from OpenAI Codex under Apache-2.0.\n'
    + 'The Apache-2.0 license is reproduced in LICENSE-Codex.\n',
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function writeText(root: string, file: string, content: string): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-licenses-'))
  roots.push(root)
  writeManifest(root, 'package.json', {
    name: '@deepseek-ai/dsh-root',
    license: 'MIT',
    workspaces: ['apps/*', 'packages/*/*', 'vendor/*'],
  })
  return root
}

function writeDiscoveryFixture(root: string): { name: string; license: string; files: string[] } {
  const manifest = { name: '@deepseek-ai/dsh-tool-discovery', license: 'MIT AND Apache-2.0',
    files: ['lib/index.js', ...Object.keys(discoveryResources)] }
  writeManifest(root, `${discoveryDirectory}/package.json`, manifest)
  writeText(root, 'LICENSE', discoveryResources.LICENSE)
  for (const [file, content] of Object.entries(discoveryResources)) writeText(root, `${discoveryDirectory}/${file}`, content)
  return manifest
}

describe('DSH package license gate', () => {
  it('accepts tool-discovery combined licensing only with its published attribution files', () => {
    const root = createWorkspace()
    const directory = discoveryDirectory
    const manifest = writeDiscoveryFixture(root)
    expect(inspectDshPackageLicenses(root)).toEqual({ packageCount: 2, failures: [] })
    for (const [resource, content] of Object.entries(discoveryResources)) {
      writeManifest(root, `${directory}/package.json`, { ...manifest, files: manifest.files.filter(file => file !== resource) })
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('ship LICENSE, LICENSE-Codex, and NOTICE')])
      writeManifest(root, `${directory}/package.json`, manifest)
      writeFileSync(join(root, directory, resource), '')
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('ship LICENSE, LICENSE-Codex, and NOTICE')])
      rmSync(join(root, directory, resource))
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('ship LICENSE, LICENSE-Codex, and NOTICE')])
      mkdirSync(join(root, directory, resource))
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('ship LICENSE, LICENSE-Codex, and NOTICE')])
      rmSync(join(root, directory, resource), { recursive: true })
      writeFileSync(join(root, directory, resource), content)
      expect(inspectDshPackageLicenses(root)).toEqual({ packageCount: 2, failures: [] })
    }
  })

  it('rejects the attribution license expression for another name, directory or expression', () => {
    const root = createWorkspace()
    const file = 'packages/core/tool-discovery/package.json'
    const original = writeDiscoveryFixture(root)
    for (const manifest of [
      { name: '@deepseek-ai/dsh-tool-discovery', license: 'Apache-2.0' },
      { name: '@deepseek-ai/dsh-tool-discovery', license: 'MIT OR Apache-2.0' },
      { name: '@deepseek-ai/dsh-other', license: 'MIT AND Apache-2.0' },
    ]) {
      writeManifest(root, file, { ...original, ...manifest })
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('ship LICENSE, LICENSE-Codex, and NOTICE')])
    }
    rmSync(join(root, 'packages/core/tool-discovery'), { recursive: true })
    writeManifest(root, 'packages/core/other/package.json', { name: '@deepseek-ai/dsh-tool-discovery', license: 'MIT AND Apache-2.0' })
    expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('must declare "license": "MIT"')])
  })
  it('checks root, unhyphenated CLI, and dsh-prefixed package names while ignoring other families', () => {
    const root = createWorkspace()
    writeManifest(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', license: 'MIT' })
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@deepseek-ai/dsh-agent',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'vendor/cordis/package.json', {
      name: '@deepseek-ai/cordis',
      license: 'BSD-3-Clause',
    })

    expect(inspectDshPackageLicenses(root)).toEqual({
      packageCount: 3,
      failures: [
        'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare "license": "MIT"; found "BSD-3-Clause".',
      ],
    })
  })

  it('rejects a missing license declaration', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', { name: '@deepseek-ai/dsh-agent' })

    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare "license": "MIT"; found undefined.',
    ])
  })

  it('accepts UNLICENSED only for the private drama skill resource package', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/drama/skills/package.json', {
      name: '@deepseek-ai/dsh-drama-skills', private: true, license: 'UNLICENSED',
    })
    expect(inspectDshPackageLicenses(root)).toEqual({ packageCount: 2, failures: [] })
    writeManifest(root, 'packages/drama/skills/package.json', {
      name: '@deepseek-ai/dsh-drama-skills', private: false, license: 'UNLICENSED',
    })
    expect(inspectDshPackageLicenses(root).failures)
      .toContainEqual(expect.stringContaining('must declare "license": "MIT"'))
    writeManifest(root, 'packages/drama/other/package.json', {
      name: '@deepseek-ai/dsh-drama-skills', private: true, license: 'UNLICENSED',
    })
    expect(inspectDshPackageLicenses(root).failures)
      .toContainEqual(expect.stringContaining('packages/drama/other/package.json'))
  })

  it('keeps the Codex-derived mixed license narrow and requires both packaged licenses and attribution', () => {
    const root = createWorkspace()
    const directory = discoveryDirectory
    const manifest = writeDiscoveryFixture(root)
    expect(inspectDshPackageLicenses(root)).toEqual({ packageCount: 2, failures: [] })

    writeManifest(root, `${directory}/package.json`, { ...manifest, files: ['lib/index.js', 'LICENSE', 'NOTICE'] })
    expect(inspectDshPackageLicenses(root).failures).toEqual([
      `${directory}/package.json: @deepseek-ai/dsh-tool-discovery must declare "license": "MIT AND Apache-2.0" and ship LICENSE, LICENSE-Codex, and NOTICE with Codex attribution.`,
    ])
    writeManifest(root, `${directory}/package.json`, manifest)
    writeText(root, `${directory}/NOTICE`, 'OpenAI Codex\n')
    expect(inspectDshPackageLicenses(root).failures).toHaveLength(1)
    writeText(root, `${directory}/NOTICE`, discoveryResources.NOTICE)
    writeText(root, `${directory}/LICENSE`, 'changed MIT text')
    expect(inspectDshPackageLicenses(root).failures).toHaveLength(1)
    writeText(root, `${directory}/LICENSE`, discoveryResources.LICENSE)
    writeManifest(root, `${directory}/package.json`, { ...manifest, license: 'MIT' })
    expect(inspectDshPackageLicenses(root).failures).toHaveLength(1)
    writeManifest(root, `${directory}/package.json`, manifest)
    writeManifest(root, 'packages/core/other/package.json', manifest)
    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/other/package.json: @deepseek-ai/dsh-tool-discovery must declare "license": "MIT"; found "MIT AND Apache-2.0".',
    ])
  })
})


describe('Codex-derived tool discovery notices', () => {
  it.each([
    ['packages/core/other', '@deepseek-ai/dsh-tool-discovery', 'MIT AND Apache-2.0', ['NOTICE', 'LICENSE-Codex']],
    ['packages/core/tool-discovery', '@deepseek-ai/dsh-other', 'MIT AND Apache-2.0', ['NOTICE', 'LICENSE-Codex']],
    ['packages/core/tool-discovery', '@deepseek-ai/dsh-tool-discovery', 'MIT OR Apache-2.0', ['NOTICE', 'LICENSE-Codex']],
    ['packages/core/tool-discovery', '@deepseek-ai/dsh-tool-discovery', 'MIT AND Apache-2.0', ['NOTICE']],
  ])('rejects a changed package identity, license or omitted published notice', (directory, name, license, files) => {
    const root = createWorkspace()
    writeDiscoveryFixture(root)
    if (directory !== discoveryDirectory) rmSync(join(root, discoveryDirectory), { recursive: true })
    writeManifest(root, `${directory}/package.json`, { name, license, files })
    for (const [file, content] of Object.entries(discoveryResources)) writeText(root, `${directory}/${file}`, content)
    expect(inspectDshPackageLicenses(root).failures).toHaveLength(1)
  })
})
