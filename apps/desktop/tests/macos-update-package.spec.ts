/** Failed attachment and detach cleanup affects only this verification operation’s private image. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifyMacOSUpdatePackage, type MacOSUpdatePackage } from '../src/macos-update-package.ts'

const f = vi.hoisted(() => ({ image: '', mount: '', partial: false, alias: false, detachFailure: false, forceFailure: false,
  appId: 'cn.muse.med', version: '1.0.4', plistReads: [] as string[], signatureChecks: 0,
  devices: [] as string[], roots: [] as string[] }))
vi.mock('node:child_process', async (load) => {
  const original = await load<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execute = async (command: string, args: readonly string[]) => {
    if (command.endsWith('hdiutil') && args[0] === 'attach') {
      f.image = args[args.length - 1] ?? ''
      f.mount = args[args.indexOf('-mountpoint') + 1] ?? ''
      f.roots.push(dirname(f.mount))
      expect(args).toContain('-readonly')
      if (f.partial) throw new Error('partial attach failed')
      await mkdir(join(f.mount, 'muse-med.app'), { recursive: true })
    }
    if (command.endsWith('hdiutil') && args[0] === 'detach') {
      const target = args[args.length - 1] ?? ''
      f.devices.push(target)
      if ((!args.includes('-force') && f.detachFailure) || (args.includes('-force') && f.forceFailure)) throw new Error('detach refused')
    }
    if (command.endsWith('plutil')) return { stdout: JSON.stringify({ images: [
      { 'image-path': '/unrelated/image.dmg', 'system-entities': [{ 'dev-entry': '/dev/disk0' }] },
      { 'image-path': f.alias ? f.image.replace(/^\/private\/var\//u, '/var/') : f.image,
        'system-entities': [{ 'dev-entry': '/dev/disk777' }, { 'dev-entry': '/dev/disk777s1' }] },
    ] }), stderr: '' }
    if (command.endsWith('PlistBuddy')) {
      expect(args).toHaveLength(3)
      expect(args[0]).toBe('-c')
      expect(args[2]).toBe(join(f.mount, 'muse-med.app', 'Contents', 'Info.plist'))
      const key = args[1]
      f.plistReads.push(key!)
      if (key === 'Print :CFBundleIdentifier') return { stdout: `${f.appId}\n`, stderr: '' }
      if (key === 'Print :CFBundleShortVersionString') return { stdout: `${f.version}\n`, stderr: '' }
      throw new Error(`Unexpected plist field: ${String(key)}`)
    }
    if (command.endsWith('codesign') && args.includes('--verify')) f.signatureChecks++
    return { stdout: '', stderr: args.includes('--display') ? 'Identifier=cn.muse.med\nSealed Resources version=2 rules=13 files=2\n' : '' }
  }
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

const inputs: string[] = []
async function candidate(): Promise<MacOSUpdatePackage> {
  const root = await mkdtemp(join(tmpdir(), 'muse-macos-cleanup-test-'))
  inputs.push(root)
  const path = join(root, 'input.dmg')
  const body = Buffer.from('private image')
  await writeFile(path, body)
  return { path, version: '1.0.4', appId: 'cn.muse.med', arch: 'arm64', size: body.length,
    sha512: createHash('sha512').update(body).digest('base64') }
}
beforeEach(() => {
  f.partial = false; f.alias = false; f.detachFailure = false; f.forceFailure = false; f.devices = []
  f.appId = 'cn.muse.med'; f.version = '1.0.4'; f.plistReads = []; f.signatureChecks = 0
})
afterEach(async () => {
  await Promise.all([...inputs.splice(0), ...f.roots.splice(0)].map(root => rm(root, { recursive: true, force: true })))
})

it('recovers a partial attachment by the unique private image path without touching another disk', async () => {
  f.partial = true
  const source = await candidate()
  await expect(verifyMacOSUpdatePackage(source)).rejects.toThrow('partial attach failed')
  expect(f.image).not.toBe(source.path)
  expect(f.devices).toEqual(['/dev/disk777'])
  await expect(stat(dirname(f.mount))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.runIf(process.platform === 'darwin')('recognizes the /var alias of its canonical private image when recovering a partial attachment', async () => {
  f.partial = true
  f.alias = true
  await expect(verifyMacOSUpdatePackage(await candidate())).rejects.toThrow('partial attach failed')
  expect(f.image).toMatch(/^\/private\/var\//u)
  expect(f.devices).toEqual(['/dev/disk777'])
})

it('retries busy detach only for its owned mount and removes scratch files after cleanup', async () => {
  f.detachFailure = true
  await verifyMacOSUpdatePackage(await candidate())
  expect(f.devices).toEqual([f.mount, f.mount])
  await expect(stat(dirname(f.mount))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reads each application plist field separately before requiring the complete signature', async () => {
  await verifyMacOSUpdatePackage(await candidate())
  expect(f.plistReads).toEqual(['Print :CFBundleIdentifier', 'Print :CFBundleShortVersionString'])
  expect(f.signatureChecks).toBe(1)
})

it.each([
  ['cn.other.app', '1.0.4'], ['cn.muse.med', '1.0.5'], ['', '1.0.4'], ['cn.muse.med', ''],
])('rejects a separately read bundle identity %s and version %s before signature verification', async (appId, version) => {
  f.appId = appId; f.version = version
  const verification = verifyMacOSUpdatePackage(await candidate())
  await expect(verification).rejects.toThrow('identity or version')
  const expected = `observed id=${appId || '<invalid>'}, version=${version || '<invalid>'}`
    + '; expected id=cn.muse.med, version=1.0.4'
  await expect(verification).rejects.toThrow(expected)
  expect(f.signatureChecks).toBe(0)
  expect(f.devices).toEqual([f.mount])
  await expect(stat(dirname(f.mount))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not copy arbitrary plist content into verification diagnostics', async () => {
  f.appId = 'private/path\npassword=do-not-report'
  const verification = verifyMacOSUpdatePackage(await candidate())
  await expect(verification).rejects.toThrow('observed id=<invalid>, version=1.0.4')
  await expect(verification).rejects.not.toThrow('do-not-report')
  expect(f.signatureChecks).toBe(0)
})

it('preserves the private image and reports both detach failures when safe cleanup cannot complete', async () => {
  f.detachFailure = true
  f.forceFailure = true
  await expect(verifyMacOSUpdatePackage(await candidate())).rejects.toBeInstanceOf(AggregateError)
  expect(f.devices).toEqual([f.mount, f.mount])
  expect((await stat(f.image)).isFile()).toBe(true)
})
