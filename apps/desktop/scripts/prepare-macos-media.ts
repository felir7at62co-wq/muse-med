/** Build standalone Mac download-verification tools from the locked official FFmpeg source. */
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { obtain, verifyMediaResource, type MediaResource } from './media-resources.ts'

interface MacMediaLock {
  version: 1
  release: string
  source: MediaResource
  signer: string
}

/**
 * @param value - parsed source inventory.
 * @returns the hash-locked official release.
 * @throws When source identity or bounds are invalid.
 */
export function validateMacMediaLock(value: unknown): MacMediaLock {
  if (typeof value !== 'object' || value === null) throw new Error('Mac media: invalid lock')
  const lock = value as MacMediaLock
  if (
    lock.version !== 1 ||
    typeof lock.release !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(lock.release) ||
    lock.signer !== 'FCF986EA15E6E293A5644F10B4322F04D67658D8'
  )
    throw new Error('Mac media: invalid release')
  const resource = lock.source
  if (
    resource === null ||
    typeof resource !== 'object' ||
    resource.filename !== `ffmpeg-${lock.release}.tar.xz` ||
    !Number.isSafeInteger(resource.bytes) ||
    resource.bytes <= 0 ||
    resource.bytes > 40 * 1024 ** 2 ||
    typeof resource.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(resource.sha256) ||
    resource.url !== `https://ffmpeg.org/releases/${resource.filename}`
  )
    throw new Error('Mac media: invalid resource')
  return lock
}

/**
 * @param arch - Mac binary architecture.
 * @returns standalone LGPL configuration with no external libraries or host package discovery.
 */
export function macMediaConfigureArguments(arch: 'arm64' | 'x64'): string[] {
  const machine = arch === 'arm64' ? 'arm64' : 'x86_64'
  return [
    '--disable-autodetect',
    '--disable-shared',
    '--enable-static',
    '--disable-doc',
    '--disable-debug',
    '--disable-ffplay',
    '--disable-network',
    '--disable-x86asm',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--target-os=darwin',
    `--arch=${machine}`,
    '--cc=/usr/bin/clang',
    `--extra-cflags=-arch ${machine} -mmacosx-version-min=11.0`,
    `--extra-ldflags=-arch ${machine} -mmacosx-version-min=11.0`,
  ]
}

async function run(binary: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: 'inherit',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' },
    })
    child.once('error', reject)
    child.once('close', code =>
      code === 0 ? resolve() : reject(new Error(`Mac media: ${binary} failed (${String(code)})`)),
    )
  })
}

/**
 * Check the cached source and executable hashes before reusing a Mac media build.
 * @param output - Installed media directory.
 * @param lock - Validated source pin.
 * @param arch - Requested architecture.
 * @returns Whether the source, options and executable hashes match.
 */
export async function reusableMacMedia(output: string, lock: MacMediaLock, arch: 'arm64' | 'x64'): Promise<boolean> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(output, 'macos-media.json'), 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      return false
    throw error
  }
  if (typeof value !== 'object' || value === null) return false
  const manifest = value as { arch?: unknown; source?: unknown; configure?: unknown; binaries?: unknown }
  if (
    manifest.arch !== arch ||
    JSON.stringify(manifest.source) !== JSON.stringify(lock.source) ||
    JSON.stringify(manifest.configure) !== JSON.stringify(macMediaConfigureArguments(arch)) ||
    !Array.isArray(manifest.binaries) ||
    manifest.binaries.length !== 2
  )
    return false
  const names = new Set(['ffmpeg', 'ffprobe'])
  for (const binary of manifest.binaries) {
    if (typeof binary !== 'object' || binary === null) return false
    const record = binary as { name?: unknown; sha256?: unknown }
    if (typeof record.name !== 'string' || !names.delete(record.name) || typeof record.sha256 !== 'string') return false
    const digest = createHash('sha256')
      .update(await readFile(join(output, 'ffmpeg', 'bin', record.name)))
      .digest('hex')
    if (digest !== record.sha256) return false
  }
  await verifyMediaResource(join(output, 'sources', lock.source.filename), lock.source)
  return true
}

/**
 * @param output - runtime/media directory.
 * @param cache - immutable source cache.
 * @param arch - packaged Mac architecture.
 * @returns after building tools and including matching source and notices.
 */
export async function prepareMacMedia(output: string, cache: string, arch: 'arm64' | 'x64'): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Mac media: requires macOS')
  const lock = validateMacMediaLock(
    JSON.parse(await readFile(new URL('./macos-media-lock.json', import.meta.url), 'utf8')),
  )
  await mkdir(cache, { recursive: true })
  const source = await obtain(lock.source, resolve(cache))
  const destination = resolve(output)
  if (await reusableMacMedia(destination, lock, arch)) {
    smokeMacMedia(destination)
    return
  }
  await mkdir(dirname(destination), { recursive: true })
  const stage = await mkdtemp(join(dirname(destination), '.mac-media-'))
  try {
    await run('/usr/bin/tar', ['-xf', source, '-C', stage], stage)
    const build = join(stage, `ffmpeg-${lock.release}`)
    const args = macMediaConfigureArguments(arch)
    await run('/bin/sh', ['configure', ...args], build)
    await run('/usr/bin/make', ['-j', String(availableParallelism()), 'ffmpeg', 'ffprobe'], build)
    const payload = join(stage, 'payload')
    await mkdir(join(payload, 'ffmpeg', 'bin'), { recursive: true })
    await mkdir(join(payload, 'notices'), { recursive: true })
    await mkdir(join(payload, 'sources'), { recursive: true })
    const binaries = []
    for (const name of ['ffmpeg', 'ffprobe']) {
      const path = join(build, name)
      await copyFile(path, join(payload, 'ffmpeg', 'bin', name))
      binaries.push({
        name,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      })
    }
    for (const name of ['LICENSE.md', 'COPYING.LGPLv2.1'])
      await copyFile(join(build, name), join(payload, 'notices', name))
    await copyFile(source, join(payload, 'sources', lock.source.filename))
    await writeFile(
      join(payload, 'macos-media.json'),
      JSON.stringify(
        { version: 1, platform: 'darwin', arch, release: lock.release, source: lock.source, configure: args, binaries },
        null,
        2,
      ) + '\n',
    )
    smokeMacMedia(payload)
    await rm(destination, { recursive: true, force: true })
    await rename(payload, destination)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

/** @param output - prepared media directory. @returns after both tools execute without PATH, Homebrew or excluded license options. */
export function smokeMacMedia(output: string): void {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const result = spawnSync(join(output, 'ffmpeg', 'bin', name), ['-version'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: '/usr/bin:/bin' },
      maxBuffer: 64 * 1024,
    })
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      !result.stdout.startsWith(`${name} version `) ||
      /--enable-(?:gpl|nonfree|version3)/u.test(result.stdout)
    )
      throw new Error(`Mac media: ${name} failed standalone smoke`)
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' }, arch: { type: 'string' } } })
  if (!values.output || !values.cache || (values.arch !== 'arm64' && values.arch !== 'x64')) {
    throw new Error('Mac media: --output, --cache and --arch arm64|x64 are required')
  }
  await prepareMacMedia(values.output, values.cache, values.arch)
}
