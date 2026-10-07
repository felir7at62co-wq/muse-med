/** Inspect a downloaded macOS DMG without executing or modifying its application. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

async function detach(target: string): Promise<void> {
  try { await execute('/usr/bin/hdiutil', ['detach', target]) }
  catch (detachError) {
    try { await execute('/usr/bin/hdiutil', ['detach', '-force', target]) }
    catch (forceError) {
      throw new AggregateError([detachError, forceError], `desktop macOS update: could not detach owned verification device ${target}`)
    }
  }
}

async function detachPartialImage(root: string, image: string): Promise<void> {
  const info = await execute('/usr/bin/hdiutil', ['info', '-plist'])
  const path = join(root, 'attached-images.plist')
  await writeFile(path, info.stdout, { mode: 0o600 })
  const converted = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])
  const value: unknown = JSON.parse(converted.stdout)
  if (typeof value !== 'object' || value === null || !('images' in value) || !Array.isArray(value.images)) {
    throw new Error('desktop macOS update: cannot inspect partial verification image attachments')
  }
  const images: readonly unknown[] = value.images
  for (const item of images) {
    if (typeof item !== 'object' || item === null || !('image-path' in item) || typeof item['image-path'] !== 'string') continue
    const actual = item['image-path']
    if (basename(actual) !== basename(image) || basename(dirname(actual)) !== basename(root)) continue
    if (await realpath(actual) !== image) continue
    if (!('system-entities' in item) || !Array.isArray(item['system-entities'])) {
      throw new Error('desktop macOS update: owned partial image has no device inventory')
    }
    const entities: readonly unknown[] = item['system-entities']
    const device = entities.find(entity => typeof entity === 'object' && entity !== null
      && 'dev-entry' in entity && typeof entity['dev-entry'] === 'string' && /^\/dev\/disk\d+$/u.test(entity['dev-entry']))
    if (typeof device !== 'object' || device === null || !('dev-entry' in device) || typeof device['dev-entry'] !== 'string') {
      throw new Error('desktop macOS update: owned partial image has no whole-device identifier')
    }
    await detach(device['dev-entry'])
  }
}

/** Confirmed feed identity for a single downloaded disk image. */
export interface MacOSUpdatePackage {
  readonly path: string
  readonly version: string
  readonly appId: string
  readonly arch: 'arm64' | 'x64'
  readonly sha512: string
  readonly size: number
}

/**
 * Recheck the complete downloaded bytes before mounting or opening an installer.
 * @param candidate - Main-owned file and SHA-512 from the confirmed feed.
 * @returns Resolves for the exact regular file; links, missing hashes, and changed bytes reject.
 */
export async function verifyMacOSUpdateBytes(candidate: MacOSUpdatePackage): Promise<void> {
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(candidate.sha512) || !Number.isSafeInteger(candidate.size) || candidate.size < 1) {
    throw new Error('desktop macOS update: disk image metadata requires SHA-512 and size')
  }
  const details = await lstat(candidate.path)
  if (!details.isFile() || details.size !== candidate.size) throw new Error('desktop macOS update: disk image changed')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(candidate.path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('desktop macOS update: disk image reader returned non-binary data')
    hash.update(chunk)
  }
  if (hash.digest('base64') !== candidate.sha512) throw new Error('desktop macOS update: disk image SHA-512 differs from the confirmed release')
}

/**
 * Mount read-only, verify the exact app identity/version and full signature, then detach.
 * @param candidate - Main-owned downloaded artifact and confirmed release identity.
 * @returns Resolves only after verification and detach; no application code is executed.
 */
export async function verifyMacOSUpdatePackage(candidate: MacOSUpdatePackage): Promise<void> {
  await verifyMacOSUpdateBytes(candidate)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-update-dmg-')))
  const mount = join(root, 'mount')
  const image = join(root, 'verification.dmg')
  let attached = false
  let attempted = false
  let failure: unknown
  try {
    await mkdir(mount)
    await copyFile(candidate.path, image, constants.COPYFILE_FICLONE)
    await verifyMacOSUpdateBytes({ ...candidate, path: image })
    attempted = true
    await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, image])
    attached = true
    const application = join(mount, 'muse-med.app')
    if (!(await lstat(application)).isDirectory()) throw new Error('desktop macOS update: disk image application is missing or linked')
    const plist = join(application, 'Contents', 'Info.plist')
    const identity = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', '-c', 'Print :CFBundleShortVersionString', plist])
    if (identity.stdout.trim() !== `${candidate.appId}\n${candidate.version}`) {
      throw new Error('desktop macOS update: application identity or version differs from the confirmed release')
    }
    await execute('/usr/bin/lipo', [join(application, 'Contents', 'MacOS', 'muse-med'), '-verify_arch',
      candidate.arch === 'arm64' ? 'arm64' : 'x86_64'])
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', application])
    const signature = await execute('/usr/bin/codesign', ['--display', '--verbose=4', application])
    const fields = `${signature.stdout}${signature.stderr}`.split(/\r?\n/u).map(line => line.trim())
    if (!fields.includes(`Identifier=${candidate.appId}`)
      || !fields.some(line => /^Sealed Resources version=2 rules=\d+ files=\d+$/u.test(line))) {
      throw new Error('desktop macOS update: application signature must bind its identity and sealed resources')
    }
    await verifyMacOSUpdateBytes(candidate)
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      if (attached) await detach(mount)
      else if (attempted) await detachPartialImage(root, image)
    } catch (cleanupError) {
      throw failure === undefined ? cleanupError
        : new AggregateError([failure, cleanupError], 'desktop macOS update: verification and owned-device cleanup failed')
    }
    await rm(root, { recursive: true, force: true })
  }
}
