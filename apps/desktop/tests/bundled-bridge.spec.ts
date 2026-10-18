/** Product bridge entry selection when a profile installs an upstream package with the same name. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { bundledBridgeModules, verifyBundledImClient } from '../../desktop-host/src/bundled-bridge.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(exports: Record<string, string> = { './remote': './remote.mjs' }, feishuExports: Record<string, string> = { '.': './index.js' }): {
  runtime: string
  bridge: string
  feishu: string
  profile: string
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'muse bundled bridge 中文-')))
  roots.push(root)
  const runtime = join(root, 'runtime')
  const bridge = join(runtime, 'node_modules', '@wenbin_wb', 'dsh-bridge')
  mkdirSync(bridge, { recursive: true })
  writeFileSync(join(bridge, 'package.json'), JSON.stringify({ name: '@wenbin_wb/dsh-bridge', exports }))
  writeFileSync(join(bridge, 'index.js'), '')
  writeFileSync(join(bridge, 'remote.mjs'), '')
  const feishu = join(runtime, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(feishu, { recursive: true })
  writeFileSync(join(feishu, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', exports: feishuExports }))
  writeFileSync(join(feishu, 'index.js'), '')
  const profile = join(root, 'profiles', 'desktop')
  const upstream = join(profile, 'node_modules', '@wenbin_wb', 'dsh-bridge')
  mkdirSync(upstream, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { '@wenbin_wb/dsh-bridge': '2.14.2' } }))
  writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: '@wenbin_wb/dsh-bridge', exports: { '.': './index.js' } }))
  writeFileSync(join(upstream, 'index.js'), 'throw new Error("upstream must not activate")\n')
  return { runtime, bridge, feishu, profile }
}

it('pins both entries to bundled exports without changing the installed profile', () => {
  const { runtime, bridge, feishu, profile } = fixture()
  const original = readFileSync(join(profile, 'package.json'), 'utf8')
  const profileRequire = createRequire(join(profile, 'package.json'))
  expect(profileRequire.resolve('@wenbin_wb/dsh-bridge')).not.toBe(join(bridge, 'index.js'))
  expect(() => profileRequire.resolve('@wenbin_wb/dsh-bridge/remote')).toThrow()
  expect(bundledBridgeModules(runtime)).toEqual({
    '@wenbin_wb/dsh-bridge/remote': pathToFileURL(join(bridge, 'remote.mjs')).href,
    '@wenbin_wb/dsh-bridge': pathToFileURL(join(feishu, 'index.js')).href,
    '@xmanrui/dsh-im': pathToFileURL(join(feishu, 'index.js')).href,
  })
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(original)
})

it.each(['root', 'remote'] as const)('refuses a runtime package missing its %s export', (name) => {
  const { runtime } = name === 'root' ? fixture(undefined, {}) : fixture({ '.': './index.js' })
  expect(() => bundledBridgeModules(runtime)).toThrow(/muse-med: bundled bridge entry .* is unavailable/u)
})

it.each(['bridge', 'feishu'] as const)('refuses a missing bundled %s package even when the profile has a working root export', (name) => {
  const paths = fixture()
  rmSync(paths[name], { recursive: true })
  const { runtime } = paths
  expect(() => bundledBridgeModules(runtime)).toThrow(/muse-med: bundled bridge entry .* is unavailable/u)
})

it('does not fall back to a package above the application runtime', () => {
  const { runtime, bridge } = fixture()
  const ancestor = join(runtime, '..', 'node_modules', '@wenbin_wb', 'dsh-bridge')
  mkdirSync(ancestor, { recursive: true })
  writeFileSync(join(ancestor, 'package.json'), JSON.stringify({ name: '@wenbin_wb/dsh-bridge', exports: { '.': './index.js', './remote': './index.js' } }))
  writeFileSync(join(ancestor, 'index.js'), '')
  rmSync(bridge, { recursive: true })
  expect(createRequire(join(runtime, 'package.json')).resolve('@wenbin_wb/dsh-bridge')).toBe(join(ancestor, 'index.js'))
  expect(() => bundledBridgeModules(runtime)).toThrow(/muse-med: bundled bridge entry .* is unavailable/u)
})

it('accepts an unlinked production profile without writing package links', () => {
  const { runtime, profile } = fixture()
  const manifest = readFileSync(join(profile, 'package.json'), 'utf8')
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  expect(() => createRequire(join(profile, 'package.json')).resolve('@xmanrui/dsh-im')).toThrow()
  verifyBundledImClient(runtime, profile)
  expect(existsSync(localIm)).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})

it('accepts a development profile link to the reviewed package', () => {
  const { runtime, feishu, profile } = fixture()
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(join(localIm, '..'), { recursive: true })
  symlinkSync(feishu, localIm, process.platform === 'win32' ? 'junction' : 'dir')
  verifyBundledImClient(runtime, profile)
  expect(realpathSync(localIm)).toBe(feishu)
})

it('rejects a profile IM copy that would supply different browser metadata', () => {
  const { runtime, profile } = fixture()
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(localIm, { recursive: true })
  writeFileSync(join(localIm, 'package.json'), JSON.stringify({
    name: '@xmanrui/dsh-im', exports: { '.': './index.js', './client': './client.js' },
  }))
  writeFileSync(join(localIm, 'index.js'), '')
  writeFileSync(join(localIm, 'client.js'), '')
  expect(() => { verifyBundledImClient(runtime, profile) }).toThrow(/conflicts with the bundled IM package/u)
})

it('rejects profile browser metadata even when its Host export forwards to the bundled entry', () => {
  const { runtime, feishu, profile } = fixture()
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(localIm, { recursive: true })
  writeFileSync(join(localIm, 'package.json'), JSON.stringify({
    name: '@xmanrui/dsh-im', exports: { '.': './forward/index.js', './client': './client.js' },
  }))
  symlinkSync(feishu, join(localIm, 'forward'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(localIm, 'client.js'), '')
  expect(realpathSync(createRequire(join(profile, 'package.json')).resolve('@xmanrui/dsh-im'))).toBe(join(feishu, 'index.js'))
  expect(() => { verifyBundledImClient(runtime, profile) }).toThrow(/conflicts with the bundled IM package/u)
})

it.each(['manifest', 'export', 'broken-link'] as const)('rejects an invalid profile IM %s instead of treating it as an unlinked profile', (kind) => {
  const { runtime, profile } = fixture()
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(join(localIm, '..'), { recursive: true })
  if (kind === 'broken-link') {
    symlinkSync(join(profile, 'missing-im'), localIm, process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    mkdirSync(localIm)
    writeFileSync(join(localIm, 'package.json'), kind === 'manifest' ? '{invalid' : JSON.stringify({
      name: '@xmanrui/dsh-im', exports: { './client': './client.js' },
    }))
  }
  expect(() => { verifyBundledImClient(runtime, profile) }).toThrow(/profile-installed IM package is invalid/u)
})

it.each(['missing', 'export'] as const)('requires the bundled IM package even when its %s case has a profile fallback', (kind) => {
  const { runtime, feishu, profile } = fixture(undefined, kind === 'export' ? {} : undefined)
  if (kind === 'missing') rmSync(feishu, { recursive: true })
  const localIm = join(profile, 'node_modules', '@xmanrui', 'dsh-im')
  mkdirSync(localIm, { recursive: true })
  writeFileSync(join(localIm, 'package.json'), JSON.stringify({ name: '@xmanrui/dsh-im', exports: './index.js' }))
  writeFileSync(join(localIm, 'index.js'), '')
  expect(() => { verifyBundledImClient(runtime, profile) }).toThrow(/bundled IM package is unavailable/u)
})
