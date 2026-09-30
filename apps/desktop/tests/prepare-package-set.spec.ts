import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertDesktopHostPackageFiles,
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
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
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
      expect(() => selectDesktopPackageClosure(available)).toThrow(`requires unpacked package ${name}`)
      available.set(name, requiredPackage)
    }
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual(expect.arrayContaining([
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
    expect(() => selectDesktopPackageClosure(available)).toThrow(/unpacked package/u)
    expect(() => selectDesktopPackageClosure(new Map([
      ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
    ]))).toThrow(/omit @deepseek-ai\/dsh-desktop-host/u)
  })

  it('refuses registry fallback when a source-owned plugin tarball is missing', () => {
    for (const name of ['dshmarket', 'dsh-codex-subscription', 'dsh-ffmpeg', '@mengyuly/dsh-ponytail', '@wenbin_wb/dsh-bridge', 'dsh-skill-mcp-panel']) {
      const available = new Map([
        ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
        ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', { dependencies: { [name]: '1.0.0' } })],
      ])
      expect(() => selectDesktopPackageClosure(available, [name])).toThrow(`packed inputs omit ${name}`)
      available.set(name, packed(name))
      expect(selectDesktopPackageClosure(available, [name]).some(entry => entry.manifest.name === name)).toBe(true)
    }
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
    expect(selectDesktopPackageClosure(available).map(entry => entry.manifest.name)).toEqual([
      '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
    ])
  })

  it('requires the Desktop Host entry, overlay and product preset', () => {
    const files = [
      'package/lib/index.js',
      'package/config/desktop.cordis.patch.yml',
      'package/config/defaults.cordis.patch.yml',
      'package/presets/short-drama/agent.cordis.yml',
      'package/presets/short-drama/preset.yml',
      'package/lib/native-preset.js',
      ...['standard', 'ptc', 'minimal', 'cordis', 'editing'].flatMap(id => [
        `package/presets/${id}/agent.cordis.yml`, `package/presets/${id}/preset.yml`,
      ]),
      'package/presets/cordis/skills/cordis-plugin-development/SKILL.md',
      'package/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
      'package/skills/editing/SKILL.md',
      'package/skills/audio-transcribe/SKILL.md',
      'package/skills/audio-transcribe/scripts/transcribe.py',
      'package/skills/transcript-to-novel/SKILL.md',
      'package/skills/transcript-to-script/SKILL.md',
      'package/skills/media-link-import/SKILL.md',
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
  })
})
