/** Build Mac media inspection and download-verification tools from locked official FFmpeg source. */
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, dirname, posix, resolve, basename } from 'node:path'
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
 * @returns LGPL configuration using Apple system zlib without host package discovery.
 */
export function macMediaConfigureArguments(arch: 'arm64' | 'x64'): string[] {
  const machine = arch === 'arm64' ? 'arm64' : 'x86_64'
  return [
    '--disable-autodetect',
    '--enable-zlib',
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

function smokeCommand(binary: string, args: string[], input?: Buffer): { bytes: Buffer; diagnostic: string } {
  const result = spawnSync(binary, args, {
    timeout: 30_000,
    env: { PATH: '/usr/bin:/bin' },
    maxBuffer: 64 * 1024,
    ...(input === undefined ? {} : { input }),
  })
  const diagnostic = result.stderr?.toString('utf8') ?? ''
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error(`Mac media: ${basename(binary)} smoke failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? diagnostic}`)
  }
  return { bytes: result.stdout, diagnostic }
}

function checkSystemLibraries(binary: string): void {
  const { bytes } = smokeCommand('/usr/bin/otool', ['-L', binary])
  const libraries = bytes.toString('utf8').trimEnd().split('\n').slice(1).map((line) => {
    const match = /^\s+(.+?) \(compatibility version /u.exec(line)
    if (!match) throw new Error(`Mac media: ${basename(binary)} has invalid library diagnostics`)
    return match[1]!
  })
  // Mach-O library diagnostics contain POSIX paths on every test host.
  if (!libraries.includes('/usr/lib/libz.1.dylib') || libraries.some(path => posix.resolve(path) !== path
    || (!path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/Frameworks/')))) {
    throw new Error(`Mac media: ${basename(binary)} requires Apple system zlib and libraries: ${libraries.join(', ')}`)
  }
}

/**
 * @param output - Prepared media directory.
 * @returns After both tools execute, use only Apple libraries and produce a decodable, scaled PNG with a source timestamp.
 * @throws When execution, license options, library paths or PNG extraction fail; subprocess failures include diagnostics.
 */
export function smokeMacMedia(output: string): void {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = join(output, 'ffmpeg', 'bin', name)
    const version = smokeCommand(binary, ['-version']).bytes.toString('utf8')
    if (!version.startsWith(`${name} version `) || /--enable-(?:gpl|nonfree|version3)/u.test(version))
      throw new Error(`Mac media: ${name} failed standalone smoke`)
    checkSystemLibraries(binary)
  }
  const binary = join(output, 'ffmpeg', 'bin', 'ffmpeg')
  const frame = smokeCommand(binary, ['-nostdin', '-hide_banner', '-loglevel', 'info', '-protocol_whitelist', 'file,pipe',
    '-copyts', '-f', 'lavfi', '-i', 'testsrc=size=32x24:rate=2:duration=1,setpts=PTS+0.5/TB',
    '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
    '-vf', "scale=w='min(16,iw)':h='min(16,ih)':force_original_aspect_ratio=decrease,showinfo",
    '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
  const timestamp = /\bpts_time:([\d.e+-]+)/u.exec(frame.diagnostic)
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!timestamp || Number(timestamp[1]) !== 0.5 || frame.bytes.length < 24
    || !frame.bytes.subarray(0, pngSignature.length).equals(pngSignature)
    || frame.bytes.toString('ascii', 12, 16) !== 'IHDR'
    || frame.bytes.readUInt32BE(16) !== 16 || frame.bytes.readUInt32BE(20) !== 12) {
    throw new Error(`Mac media: PNG extraction did not return a scaled image and source timestamp: ${frame.diagnostic}`)
  }
  const decoded = smokeCommand(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe',
    '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], frame.bytes)
  if (decoded.bytes.length !== 16 * 12 * 3) throw new Error(`Mac media: extracted PNG did not decode completely: ${decoded.diagnostic}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' }, arch: { type: 'string' } } })
  if (!values.output || !values.cache || (values.arch !== 'arm64' && values.arch !== 'x64')) {
    throw new Error('Mac media: --output, --cache and --arch arm64|x64 are required')
  }
  await prepareMacMedia(values.output, values.cache, values.arch)
}
