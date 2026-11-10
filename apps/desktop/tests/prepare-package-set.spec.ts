import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_CODEX_PACKAGE, DESKTOP_CODEX_RUNTIME_FILES, DESKTOP_FEISHU_PACKAGE, DESKTOP_FEISHU_RUNTIME_FILES, DESKTOP_DRAMA_SKILLS_PACKAGE, DESKTOP_DRAMA_SKILL_RUNTIME_FILES, DESKTOP_SOURCE_PLUGINS, DESKTOP_HOST_RUNTIME_FILES, DESKTOP_PACKAGES_DIR } from '../src/core-package-set.ts'
import { fileURLToPath } from 'node:url'
import {
  assertDesktopDramaSkillPackageFiles,
  assertDesktopCodexPackageFiles,
  assertDesktopFeishuPackageFiles,
  assertDesktopHostPackageFiles,
  prepareDesktopPackageSet,
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

function packed(name: string, manifest: Record<string, unknown> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', ...manifest } }
}

describe('desktop package-set selection', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('does not select a packaging target when imported as a library', async () => {
    vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'linux')
    vi.stubEnv('DSH_DESKTOP_TARGET_ARCH', 'x64')
    vi.resetModules()
    await expect(import('../scripts/prepare-package-set.ts')).resolves.toHaveProperty('prepareDesktopPackageSet')
  })

  it('includes only the available internal production closure', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { '@deepseek-ai/dsh-base': '^1.0.0', external: '^2.0.0' },
        optionalDependencies: { '@deepseek-ai/platform-package': '1.0.0', '@deepseek-ai/missing-platform': '1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-base', packed('@deepseek-ai/dsh-base', {
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
      })],
      ['@deepseek-ai/cordis', packed('@deepseek-ai/cordis')],
      ['@deepseek-ai/platform-package', packed('@deepseek-ai/platform-package')],
      ['@deepseek-ai/unused', packed('@deepseek-ai/unused')],
    ])
    expect(selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-desktop-host',
      '@deepseek-ai/platform-package',
    ])
  })

  it('requires drama skills, BGM and Muse account Host and UI packages in Desktop release inputs', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../desktop-host/package.json', import.meta.url)), 'utf8')) as { dependencies: Record<string, string> }
    const names = Object.keys(manifest.dependencies)
    const available = new Map(names.map(name => [name, packed(name)]))
    available.set('@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', manifest))
    for (const name of ['@deepseek-ai/dsh-drama-skills', '@deepseek-ai/dsh-perception-bgm', '@deepseek-ai/dsh-muse-account', '@deepseek-ai/dsh-client-ui-muse-account']) {
      expect(names).toContain(name)
      const requiredPackage = available.get(name)
      if (requiredPackage === undefined) throw new Error(`Missing Desktop dependency ${name}`)
      available.delete(name)
      expect(() => selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' })).toThrow(`requires unpacked package ${name}`)
      available.set(name, requiredPackage)
    }
    expect(selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }).map(entry => entry.manifest.name)).toEqual(expect.arrayContaining([
      '@deepseek-ai/dsh-tool-jubian', '@deepseek-ai/dsh-drama-skills', '@deepseek-ai/dsh-perception-bgm',
      '@deepseek-ai/dsh-muse-account', '@deepseek-ai/dsh-client-ui-muse-account',
    ]))
  })

  it.each([
    '@deepseek-ai/dsh-base', '@deepseek-ai/cordis', '@deepseek-ai/node-addon-system',
  ])('rejects required prepared package %s absent from the packed release inputs', (dependency) => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: { [dependency]: '^1.0.0' },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', {
        dependencies: { '@deepseek-ai/dsh': '^1.0.0' },
      })],
    ])
    expect(() => selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' })).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]), { platform: 'win32', arch: 'x64' })).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('refuses registry fallback when a source-owned plugin tarball is missing', () => {
    for (const name of ['dshmarket', 'dsh-ffmpeg', 'dsh-plugin-subscriptions', '@wenbin_wb/dsh-bridge', '@xmanrui/dsh-im', 'dsh-skill-mcp-panel', 'deep-view', '@nagi-ovo/dsh-visualize', 'muse-hongguo-search', 'muse-hongguo-download', 'muse-douyin-download', 'muse-qimao-data', 'muse-source-research', 'muse-skill-evolution']) {
      const available = new Map([
        ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
        ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', { dependencies: { [name]: '1.0.0' } })],
      ])
      expect(() => selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, [name])).toThrow(`packed inputs omit ${name}`)
      available.set(name, packed(name))
      expect(selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, [name]).some(entry => entry.manifest.name === name)).toBe(true)
    }
  })

  it('includes the source-built subscription providers in the Desktop package closure', () => {
    const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', ...DESKTOP_SOURCE_PLUGINS, 'dsh-codex-subscription']
    const available = new Map(names.map(name => [name, packed(name)]))
    const selected = selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, DESKTOP_SOURCE_PLUGINS).map(entry => entry.manifest.name)
    expect(selected).toContain('dsh-plugin-subscriptions')
    expect(selected).not.toContain('dsh-codex-subscription')
  })

  it('does not activate a packed optional Codex CLI peer solely for subscription OAuth', () => {
    const available = new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
      ['dsh-plugin-subscriptions', packed('dsh-plugin-subscriptions', {
        peerDependencies: { '@deepseek-ai/dsh-subagent-codex': '1.0.0', '@deepseek-ai/dsh-llm': '1.0.0' },
        peerDependenciesMeta: { '@deepseek-ai/dsh-subagent-codex': { optional: true } },
      })],
      ['@deepseek-ai/dsh-subagent-codex', packed('@deepseek-ai/dsh-subagent-codex')],
      ['@deepseek-ai/dsh-llm', packed('@deepseek-ai/dsh-llm')],
    ])
    const selected = selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, ['dsh-plugin-subscriptions']).map(entry => entry.manifest.name)
    expect(selected).toContain('dsh-plugin-subscriptions')
    expect(selected).toContain('@deepseek-ai/dsh-llm')
    expect(selected).not.toContain('@deepseek-ai/dsh-subagent-codex')
    expect(selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, ['dsh-plugin-subscriptions', '@deepseek-ai/dsh-subagent-codex'])
      .map(entry => entry.manifest.name)).toContain('@deepseek-ai/dsh-subagent-codex')
  })

  it('requires the subscription Host, login settings assets and notices in the release tarball', () => {
    const files = DESKTOP_CODEX_RUNTIME_FILES.map(file => `package/${file}`)
    expect(() => { assertDesktopCodexPackageFiles(files) }).not.toThrow()
    for (const file of files) {
      expect(() => { assertDesktopCodexPackageFiles(files.filter(value => value !== file)) }).toThrow(file.slice('package/'.length))
    }
  })

  it('leaves archived Bot tarballs outside the default product package closure', () => {
    const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', ...DESKTOP_SOURCE_PLUGINS, 'ds-bot', 'muse-bot']
    const available = new Map(names.map(name => [name, packed(name)]))
    const selected = selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, DESKTOP_SOURCE_PLUGINS).map(entry => entry.manifest.name)
    expect(selected).toContain('dsh-plugin-subscriptions')
    expect(selected).not.toContain('ds-bot')
    expect(selected).not.toContain('muse-bot')
    for (const name of ['ds-bot', 'muse-bot']) available.delete(name)
    expect(selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, DESKTOP_SOURCE_PLUGINS).map(entry => entry.manifest.name)).toEqual(selected)
  })

  it.each([null, [], { '@deepseek-ai/dsh-subagent-codex': 'optional' }])('rejects malformed optional-peer metadata: %j', (metadata) => {
    const available = new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
      ['dsh-plugin-subscriptions', packed('dsh-plugin-subscriptions', {
        peerDependencies: { '@deepseek-ai/dsh-subagent-codex': '1.0.0' }, peerDependenciesMeta: metadata,
      })],
    ])
    expect(() => selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, ['dsh-plugin-subscriptions'])).toThrow('invalid peer')
  })

  it('selects the IM package and account bridge without retaining the retired Feishu archive', () => {
    const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', ...DESKTOP_SOURCE_PLUGINS, '@dsh-feishu/dsh-feishu']
    const available = new Map(names.map(name => [name, packed(name)]))
    const selected = selectDesktopPackageClosure(available, { platform: 'darwin', arch: 'arm64' }, DESKTOP_SOURCE_PLUGINS).map(entry => entry.manifest.name)
    expect(selected).toContain('@xmanrui/dsh-im')
    expect(selected).toContain('@wenbin_wb/dsh-bridge')
    expect(selected).not.toContain('@dsh-feishu/dsh-feishu')
  })

  it('leaves independently published Office packages to npm resolution', () => {
    const available = new Map<string, PackedDesktopPackage>([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', {
        dependencies: {
          '@deepseek-ai/libreoffice-kit': '0.0.1',
          '@deepseek-ai/libreoffice-kit-wasm': '0.0.1',
        },
      })],
      ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
    ])
    expect(selectDesktopPackageClosure(available, { platform: 'win32', arch: 'x64' }).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires the Desktop Host entry, overlay and product preset', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/cli.js',
      'package/lib/approved-episode-render.js',
      'package/lib/episode-render-worker.js',
      'package/lib/workspace-owned-storage.js',
      'package/lib/retired-bot.js',
      'package/lib/delegation-policy.js',
      'package/config/desktop.cordis.patch.yml',
      'package/config/defaults.cordis.patch.yml',
      'package/presets/short-drama/agent.cordis.yml',
      'package/presets/short-drama/preset.yml',
      'package/lib/native-preset.js',
      'package/lib/computer-use.js',
      'package/lib/computer-input-worker.js',
      ...['standard', 'ptc', 'minimal', 'cordis'].flatMap(id => [
        `package/presets/${id}/agent.cordis.yml`, `package/presets/${id}/preset.yml`,
      ]),
      'package/presets/cordis/skills/cordis-plugin-development/SKILL.md',
      'package/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
      'package/skills/audio-transcribe/SKILL.md',
      'package/skills/audio-transcribe/scripts/transcribe.py',
      'package/skills/office-support/export_docx.py',
      'package/skills/media-link-import/scripts/import_media.py',
    ]
    for (const required of files.slice(1)) {
      expect(() => { assertDesktopHostPackageFiles(files.filter(file => file !== required)) }).toThrow(required)
    }
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 3)) }).toThrow(/short-drama/u)
    expect(() => {
      assertDesktopHostPackageFiles(files)
    }).not.toThrow()
    expect(() => {
      assertDesktopHostPackageFiles(files.slice(1))
    }).toThrow(/lib\/index\.js/u)
    expect(() => { assertDesktopHostPackageFiles(files.slice(0, 1)) }).toThrow(/lib\/cli\.js/u)
    const disabled = ['editing', 'transcript-to-novel', 'transcript-to-script', 'media-link-import']
      .map(name => `package/skills/${name}/SKILL.md.disabled`)
    expect(() => { assertDesktopHostPackageFiles([...files, ...disabled]) }).not.toThrow()
  })

  it('requires both shot-writing skills from the drama resource package', () => {
    const files = [
      'package/skills/shot-script-creator-16-9-3d/SKILL.md',
      'package/skills/shot-script-creator-9-16/SKILL.md',
    ]
    expect(() => { assertDesktopDramaSkillPackageFiles(files) }).not.toThrow()
    for (const required of files) {
      expect(() => { assertDesktopDramaSkillPackageFiles(files.filter(file => file !== required)) }).toThrow(required)
      expect(() => { assertDesktopDramaSkillPackageFiles(files.map(file => file === required ? `${file}.disabled` : file)) }).toThrow(required)
    }
  })

  it('requires the IM Host, native client, Session routing helpers, source record and license', () => {
    const files = [
      'package/lib/index.js',
      'package/lib/upstream.js',
      'package/lib/client.js',
      'package/lib/muse-im-migration.mjs',
      'package/lib/muse-im-admission.mjs',
      'package/lib/muse-im-workspace.mjs',
      'package/lib/muse-im-team.mjs',
      'package/cordis.patch.yml',
      'package/LICENSE',
      'package/SOURCE.json',
    ]
    expect(() => { assertDesktopFeishuPackageFiles(files) }).not.toThrow()
    for (const required of files) {
      expect(() => { assertDesktopFeishuPackageFiles(files.filter(file => file !== required)) }).toThrow(required)
    }
  })
})

const macProvider = '@deepseek-ai/dsh-experimental-cua-macos'
const cuaBundle = '@deepseek-ai/dsh-cua-bundle'
const targetManifests = () => new Map<string, PackedDesktopPackage>([
  ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh', { dependencies: { [cuaBundle]: '1.0.0' } })],
  ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host')],
  [cuaBundle, packed(cuaBundle, {
    optionalDependencies: { [macProvider]: '1.0.0' }, dependencies: { '@deepseek-ai/dsh-cua': '1.0.0' },
  })],
  ['@deepseek-ai/dsh-cua', packed('@deepseek-ai/dsh-cua')],
  [macProvider, packed(macProvider, { os: ['darwin'] })],
])

it.each([
  ['darwin', 'arm64', true], ['darwin', 'x64', true], ['win32', 'x64', false],
] as const)('selects the CUA native tarball for target %s/%s independently of the host', (platform, arch, included) => {
  const selected = selectDesktopPackageClosure(targetManifests(), { platform, arch }).map(entry => entry.manifest.name)
  expect(selected.includes(macProvider)).toBe(included)
  expect(selected).toContain('@deepseek-ai/dsh-cua')
  expect(selected).toContain(cuaBundle)
})

it.each([
  [{ cpu: ['arm64'] }, false], [{ os: ['!win32'] }, false], [{ os: ['!linux'] }, true],
  [{ os: [] }, true], [{ os: ['any'] }, true], [{ os: ['any', '!win32'] }, false],
  [{ cpu: ['x64'] }, true],
])('honors optional package platform constraints %j', (constraints, included) => {
  const packages = targetManifests()
  packages.set(macProvider, packed(macProvider, constraints))
  expect(selectDesktopPackageClosure(packages, { platform: 'win32', arch: 'x64' })
    .some(entry => entry.manifest.name === macProvider)).toBe(included)
})

it.each([{ os: 'darwin' }, { cpu: [42] }])('rejects malformed platform constraints %j', (constraints) => {
  const packages = targetManifests()
  packages.set(macProvider, packed(macProvider, constraints))
  expect(() => selectDesktopPackageClosure(packages, { platform: 'win32', arch: 'x64' })).toThrow(/has invalid/u)
})

it('copies no macOS tarball into the Windows package set', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-platform-packages-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const inputs = join(root, 'inputs')
  mkdirSync(inputs)
  const inputsByName = targetManifests()
  inputsByName.set('@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', { dependencies: { [DESKTOP_DRAMA_SKILLS_PACKAGE]: '1.0.0' } }))
  for (const name of [...DESKTOP_SOURCE_PLUGINS, DESKTOP_DRAMA_SKILLS_PACKAGE]) inputsByName.set(name, packed(name))
  for (const [name, entry] of inputsByName) {
    const stem = name.replaceAll('@', '').replaceAll('/', '-')
    const folder = join(root, stem, 'package')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'package.json'), JSON.stringify(entry.manifest))
    const required = name === '@deepseek-ai/dsh-desktop-host' ? DESKTOP_HOST_RUNTIME_FILES
      : name === DESKTOP_DRAMA_SKILLS_PACKAGE ? DESKTOP_DRAMA_SKILL_RUNTIME_FILES
        : name === DESKTOP_CODEX_PACKAGE ? DESKTOP_CODEX_RUNTIME_FILES : name === DESKTOP_FEISHU_PACKAGE ? DESKTOP_FEISHU_RUNTIME_FILES : []
    {
      for (const file of required) {
        mkdirSync(join(folder, file, '..'), { recursive: true })
        writeFileSync(join(folder, file), '')
      }
    }
    execFileSync('tar', ['-czf', join(inputs, `${stem}.tgz`), '-C', join(folder, '..'), 'package'])
  }
  const output = join(root, 'output')
  prepareDesktopPackageSet([inputs], output, { platform: 'win32', arch: 'x64' })
  expect(readdirSync(join(output, DESKTOP_PACKAGES_DIR))).not.toContain('deepseek-ai-dsh-experimental-cua-macos.tgz')
  prepareDesktopPackageSet([inputs], output, { platform: 'darwin', arch: 'arm64' })
  expect(readFileSync(join(output, DESKTOP_PACKAGES_DIR, 'deepseek-ai-dsh-experimental-cua-macos.tgz')))
    .toEqual(readFileSync(join(inputs, 'deepseek-ai-dsh-experimental-cua-macos.tgz')))
})
