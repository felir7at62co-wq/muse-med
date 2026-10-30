import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDshPackageLicenses } from './verify-dsh-package-licenses.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
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

describe('DSH package license gate', () => {
  it('accepts tool-discovery combined licensing only with its published attribution files', () => {
    const root = createWorkspace()
    const directory = 'packages/core/tool-discovery'
    const manifest = { name: '@deepseek-ai/dsh-tool-discovery', license: 'MIT AND Apache-2.0', files: ['NOTICE', 'LICENSE-Codex'] }
    writeManifest(root, `${directory}/package.json`, manifest)
    writeFileSync(join(root, directory, 'NOTICE'), 'OpenAI Codex attribution\n')
    writeFileSync(join(root, directory, 'LICENSE-Codex'), 'Apache License, Version 2.0\n')
    expect(inspectDshPackageLicenses(root)).toEqual({ packageCount: 2, failures: [] })
    for (const resource of manifest.files) {
      writeManifest(root, `${directory}/package.json`, { ...manifest, files: manifest.files.filter(file => file !== resource) })
      expect(inspectDshPackageLicenses(root).failures).toContainEqual(expect.stringContaining(`non-empty ${resource}`))
      writeManifest(root, `${directory}/package.json`, manifest)
      writeFileSync(join(root, directory, resource), '')
      expect(inspectDshPackageLicenses(root).failures).toContainEqual(expect.stringContaining(`non-empty ${resource}`))
      rmSync(join(root, directory, resource))
      expect(inspectDshPackageLicenses(root).failures).toContainEqual(expect.stringContaining(`non-empty ${resource}`))
      mkdirSync(join(root, directory, resource))
      expect(inspectDshPackageLicenses(root).failures).toContainEqual(expect.stringContaining(`non-empty ${resource}`))
      rmSync(join(root, directory, resource), { recursive: true })
      writeFileSync(join(root, directory, resource), 'Restored attribution resource\n')
    }
  })

  it('rejects the attribution license expression for another name, directory or expression', () => {
    const root = createWorkspace()
    const file = 'packages/core/tool-discovery/package.json'
    for (const manifest of [
      { name: '@deepseek-ai/dsh-tool-discovery', license: 'Apache-2.0' },
      { name: '@deepseek-ai/dsh-tool-discovery', license: 'MIT OR Apache-2.0' },
      { name: '@deepseek-ai/dsh-other', license: 'MIT AND Apache-2.0' },
    ]) {
      writeManifest(root, file, manifest)
      expect(inspectDshPackageLicenses(root).failures).toEqual([expect.stringContaining('must declare "license": "MIT"')])
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
})
