/** Build standalone Mac H264/AAC and subtitle tools from locked FFmpeg and dependency sources. */
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, posix, resolve, basename } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { availableParallelism, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { obtain, verifyMediaResource, type MediaResource } from './media-resources.ts'
import {
  macSubtitleBuildIdentity, prepareMacSubtitleLibraries, verifyMacSubtitleSources,
} from './macos-subtitle-libraries.ts'

interface MacMediaLock {
  version: 1
  release: string
  source: MediaResource
  signer: string
  notices: Array<{ filename: string; bytes: number; sha256: string }>
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
  const notices = new Set(['LICENSE.md', 'COPYING.LGPLv2.1', 'COPYING.GPLv2'])
  if (!Array.isArray(lock.notices) || lock.notices.length !== notices.size
    || lock.notices.some(notice => typeof notice !== 'object' || notice === null || !notices.delete(notice.filename)
      || !Number.isSafeInteger(notice.bytes) || notice.bytes <= 0 || notice.bytes > 128 * 1024
      || !/^[a-f0-9]{64}$/u.test(notice.sha256))) throw new Error('Mac media: invalid notices')
  return lock
}

/**
 * @param arch - Mac binary architecture.
 * @returns Static GPL configuration with subtitle libraries and system zlib, without host package discovery.
 */
export function macMediaConfigureArguments(arch: 'arm64' | 'x64'): string[] {
  const machine = arch === 'arm64' ? 'arm64' : 'x86_64'
  return [
    '--disable-autodetect',
    '--enable-zlib',
    '--enable-libass',
    '--enable-libfreetype',
    '--enable-libharfbuzz',
    '--enable-libfribidi',
    '--enable-libx264',
    '--pkg-config=pkgconf',
    '--pkg-config-flags=--static',
    '--disable-shared',
    '--enable-static',
    '--disable-doc',
    '--disable-debug',
    '--disable-ffplay',
    '--disable-network',
    '--disable-x86asm',
    '--enable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--target-os=darwin',
    `--arch=${machine}`,
    '--cc=/usr/bin/clang',
    `--extra-cflags=-arch ${machine} -mmacosx-version-min=11.0`,
    `--extra-ldflags=-arch ${machine} -mmacosx-version-min=11.0`,
  ]
}

async function run(binary: string, args: string[], cwd: string,
  env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: 'inherit',
      env,
    })
    child.once('error', reject)
    child.once('close', (code, signal) =>
      code === 0 && signal === null ? resolve() : reject(new Error(`Mac media: ${binary} failed (${String(code)}, signal ${String(signal)})`)),
    )
  })
}

const RECIPE_FILES = ['prepare-macos-media.ts', 'macos-subtitle-libraries.ts', 'media-resources.ts',
  'macos-media-lock.json', 'macos-subtitle-lock.json']

/**
 * Identify the complete static-link recipe, excluding disposable staging paths.
 * @param arch - Target Mac architecture.
 * @returns Hash of the source locks, build scripts and target configuration.
 */
export function macMediaRecipeIdentity(arch: 'arm64' | 'x64'): string {
  return createHash('sha256').update(JSON.stringify({ arch, configure: macMediaConfigureArguments(arch),
    subtitles: macSubtitleBuildIdentity(arch), files: RECIPE_FILES.map(name => ({ name,
      sha256: createHash('sha256').update(readFileSync(new URL(name, import.meta.url))).digest('hex') })) })).digest('hex')
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
  const manifest = value as { arch?: unknown; source?: unknown; configure?: unknown; binaries?: unknown; recipeIdentity?: unknown }
  if (
    manifest.arch !== arch ||
    manifest.recipeIdentity !== macMediaRecipeIdentity(arch) ||
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
  for (const notice of lock.notices) await verifyMediaResource(join(output, 'notices', notice.filename), { ...notice, url: '' })
  await verifyMacSubtitleSources(output, arch)
  for (const file of RECIPE_FILES) {
    if (!(await readFile(join(output, 'sources', 'recipe', file))).equals(readFileSync(new URL(file, import.meta.url)))) {
      throw new Error(`Mac media: retained build recipe differs: ${file}`)
    }
  }
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
  const stage = await mkdtemp(join(tmpdir(), 'muse-mac-media-build-'))
  let publication: string | undefined
  try {
    publication = await mkdtemp(join(dirname(destination), '.mac-media-'))
    await run('/usr/bin/tar', ['-xf', source, '-C', stage], stage)
    const libraries = await prepareMacSubtitleLibraries(stage, resolve(cache), arch)
    const build = join(stage, `ffmpeg-${lock.release}`)
    const args = macMediaConfigureArguments(arch)
    await run('/bin/sh', ['configure', ...args], build, libraries.env)
    const jobs = process.env.MUSE_MAC_MEDIA_JOBS === undefined ? availableParallelism() : Number(process.env.MUSE_MAC_MEDIA_JOBS)
    if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('Mac media: MUSE_MAC_MEDIA_JOBS must be a positive integer')
    await run('/usr/bin/make', ['-j', String(jobs), 'ffmpeg', 'ffprobe'], build, libraries.env)
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
    for (const notice of lock.notices) {
      await verifyMediaResource(join(build, notice.filename), { ...notice, url: '' })
      await copyFile(join(build, notice.filename), join(payload, 'notices', notice.filename))
    }
    await copyFile(source, join(payload, 'sources', lock.source.filename))
    for (const entry of libraries.sources) await copyFile(entry.path, join(payload, 'sources', entry.resource.filename))
    for (const entry of libraries.notices) await copyFile(entry.path, join(payload, 'notices', entry.name))
    await mkdir(join(payload, 'sources', 'recipe'), { recursive: true })
    for (const file of RECIPE_FILES) await copyFile(new URL(file, import.meta.url), join(payload, 'sources', 'recipe', file))
    await writeFile(
      join(payload, 'macos-media.json'),
      JSON.stringify(
        { version: 1, platform: 'darwin', arch, release: lock.release, source: lock.source, configure: args, binaries,
          recipeIdentity: macMediaRecipeIdentity(arch), subtitleBuild: libraries.identity },
        null,
        2,
      ) + '\n',
    )
    await cp(payload, publication, { recursive: true })
    smokeMacMedia(publication)
    await rm(destination, { recursive: true, force: true })
    await rename(publication, destination)
  } finally {
    await rm(stage, { recursive: true, force: true })
    if (publication !== undefined) await rm(publication, { recursive: true, force: true })
  }
}

function smokeCommand(binary: string, args: string[], input?: Buffer, cwd?: string): { bytes: Buffer; diagnostic: string } {
  const result = spawnSync(binary, args, {
    timeout: 30_000,
    env: { PATH: '/usr/bin:/bin' },
    maxBuffer: 1024 * 1024,
    ...(cwd === undefined ? {} : { cwd }),
    ...(input === undefined ? {} : { input }),
  })
  const diagnostic = result.stderr?.toString('utf8') ?? ''
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error(`Mac media: ${basename(binary)} smoke failed (exit ${String(result.status)}, signal ${String(result.signal)}): ${result.error?.message ?? diagnostic}`)
  }
  return { bytes: result.stdout, diagnostic }
}

/**
 * Reject a media build that cannot execute the existing subtitle and H264/AAC pipelines.
 * @param version - FFmpeg version and configure output.
 * @param filters - FFmpeg's filter inventory.
 * @param encoders - FFmpeg's encoder inventory.
 */
export function requireMacMediaCapabilities(version: string, filters: string, encoders: string): void {
  if (!version.startsWith('ffmpeg version ') || !version.includes('--enable-gpl')
    || /--enable-(?:nonfree|version3)/u.test(version)) throw new Error('Mac media: invalid standalone licensing configuration')
  const names = (text: string): Set<string> => new Set(text.split('\n').flatMap((line) => {
    const name = line.trim().split(/\s+/u)[1]
    return name === undefined ? [] : [name]
  }))
  const availableFilters = names(filters), availableEncoders = names(encoders)
  for (const filter of ['ass', 'subtitles', 'drawtext', 'loudnorm']) {
    if (!availableFilters.has(filter)) throw new Error(`Mac media: missing required ${filter} filter`)
  }
  for (const encoder of ['libx264', 'aac']) {
    if (!availableEncoders.has(encoder)) throw new Error(`Mac media: missing required ${encoder} encoder`)
  }
}

function smokeSubtitlePixels(binary: string, directory: string): void {
  writeFileSync(join(directory, 'captions.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 160\nPlayResY: 96\n'
    + '[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n'
    + 'Style: Default,Helvetica,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,5,5,5,1\n'
    + '[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\nDialogue: 0,0:00:00.25,0:00:00.75,Default,,0,0,0,,Muse\n')
  writeFileSync(join(directory, 'captions.srt'), '1\n00:00:00,250 --> 00:00:00,750\nMuse\n')
  const frameBytes = 160 * 96 * 3
  for (const filter of ['ass=captions.ass', 'subtitles=captions.srt']) {
    const frames = smokeCommand(binary, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x96:r=4:d=1.25',
      '-vf', filter, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], undefined, directory).bytes
    if (frames.length !== frameBytes * 5 || frames.subarray(0, frameBytes).some(value => value > 16)
      || !frames.subarray(frameBytes * 2, frameBytes * 3).some(value => value > 16)
      || frames.subarray(frameBytes * 4).some(value => value > 16)) {
      throw new Error(`Mac media: ${filter} did not paint subtitles only inside the cue interval`)
    }
  }
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
 * @returns After both tools execute, use only Apple libraries, paint timed subtitles and fully decode H264/AAC output.
 * @throws When capabilities, license options, library paths, subtitle pixels or media encoding fail.
 */
export function smokeMacMedia(output: string): void {
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = join(output, 'ffmpeg', 'bin', name)
    const version = smokeCommand(binary, ['-version']).bytes.toString('utf8')
    if (!version.startsWith(`${name} version `) || /--enable-(?:nonfree|version3)/u.test(version))
      throw new Error(`Mac media: ${name} failed standalone smoke`)
    checkSystemLibraries(binary)
  }
  const binary = join(output, 'ffmpeg', 'bin', 'ffmpeg')
  requireMacMediaCapabilities(smokeCommand(binary, ['-version']).bytes.toString('utf8'),
    smokeCommand(binary, ['-hide_banner', '-filters']).bytes.toString('utf8'),
    smokeCommand(binary, ['-hide_banner', '-encoders']).bytes.toString('utf8'))
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
  const directory = mkdtempSync(join(tmpdir(), 'muse-mac-media-'))
  try {
    smokeSubtitlePixels(binary, directory)
    smokeCommand(binary, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x96:r=10:d=1',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', '-movflags', '+faststart', 'encoded.mp4'], undefined, directory)
    const codecs = smokeCommand(join(output, 'ffmpeg', 'bin', 'ffprobe'), ['-v', 'error', '-show_entries',
      'stream=codec_name', '-of', 'csv=p=0', 'encoded.mp4'], undefined, directory).bytes.toString('utf8').trim().split(/\s+/u).sort()
    if (codecs.join(',') !== 'aac,h264') throw new Error('Mac media: H264/AAC smoke output has unexpected codecs')
    smokeCommand(binary, ['-nostdin', '-v', 'error', '-xerror', '-i', 'encoded.mp4', '-f', 'null', '-'], undefined, directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' }, arch: { type: 'string' } } })
  if (!values.output || !values.cache || (values.arch !== 'arm64' && values.arch !== 'x64')) {
    throw new Error('Mac media: --output, --cache and --arch arm64|x64 are required')
  }
  await prepareMacMedia(values.output, values.cache, values.arch)
}
