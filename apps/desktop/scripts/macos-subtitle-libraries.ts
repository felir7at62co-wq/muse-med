/** Build the static subtitle and H264 dependencies used by the Mac FFmpeg preparer. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { availableParallelism } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { obtain, verifyMediaResource, type MediaResource } from './media-resources.ts'

type MacArch = 'arm64' | 'x64'
type LibraryName = 'libass' | 'freetype' | 'harfbuzz' | 'fribidi' | 'pkgconf' | 'x264'
interface SubtitleNotice { name: string; path: string; bytes: number; sha256: string }
interface SubtitleLibrary {
  name: LibraryName
  release: string
  kind: 'archive' | 'git'
  source: MediaResource
  mirrors?: string[]
  notices: SubtitleNotice[]
}
interface MacSubtitleLock { version: 1; recipeVersion: 1; libraries: SubtitleLibrary[] }

const names = ['libass', 'freetype', 'harfbuzz', 'fribidi', 'pkgconf', 'x264'] as const
const hashPattern = /^[a-f0-9]{64}$/u

/**
 * Validate locked official sources and the notices copied alongside the executables.
 * @param value - Parsed dependency lock.
 * @returns The validated source and notice inventory.
 * @throws When versions, official URLs, names, sizes or hashes are invalid.
 */
export function validateMacSubtitleLock(value: unknown): MacSubtitleLock {
  if (typeof value !== 'object' || value === null) throw new Error('Mac subtitles: invalid lock')
  const lock = value as MacSubtitleLock
  if (lock.version !== 1 || lock.recipeVersion !== 1 || !Array.isArray(lock.libraries)
    || lock.libraries.length !== names.length) throw new Error('Mac subtitles: invalid lock version or libraries')
  const remaining = new Set<string>(names)
  const noticeNames = new Set<string>()
  for (const library of lock.libraries) {
    if (typeof library !== 'object' || library === null || !remaining.delete(library.name)
      || typeof library.release !== 'string') throw new Error('Mac subtitles: invalid library')
    const source = library.source
    if (typeof source !== 'object' || source === null || !Number.isSafeInteger(source.bytes)
      || source.bytes <= 0 || source.bytes > 40 * 1024 ** 2 || !hashPattern.test(source.sha256))
      throw new Error('Mac subtitles: invalid source identity')
    if (library.name === 'x264') {
      if (library.kind !== 'git' || !/^[a-f0-9]{40}$/u.test(library.release)
        || source.filename !== `x264-${library.release}.tar`
        || source.url !== 'https://code.videolan.org/videolan/x264.git')
        throw new Error('Mac subtitles: invalid official x264 source')
      if (!Array.isArray(library.mirrors) || library.mirrors.length !== 1
        || library.mirrors[0] !== 'https://github.com/mirror/x264.git') throw new Error('Mac subtitles: invalid x264 mirror')
    } else {
      const filename = `${library.name}-${library.release}.tar.xz`
      const tag = library.name === 'fribidi' ? `v${library.release}`
        : library.name === 'pkgconf' ? `pkgconf-${library.release}` : library.release
      const url = library.name === 'freetype'
        ? `https://download.savannah.gnu.org/releases/freetype/${filename}`
        : `https://github.com/${library.name}/${library.name}/releases/download/${tag}/${filename}`
      if (library.kind !== 'archive' || !/^\d+\.\d+\.\d+$/u.test(library.release)
        || source.filename !== filename || source.url !== url || library.mirrors !== undefined)
        throw new Error('Mac subtitles: invalid official archive')
    }
    if (!Array.isArray(library.notices) || library.notices.length === 0)
      throw new Error('Mac subtitles: missing notices')
    for (const notice of library.notices) {
      if (typeof notice !== 'object' || notice === null || typeof notice.name !== 'string'
        || !notice.name.startsWith(`${library.name}-`) || !/^[A-Za-z0-9_.-]+$/u.test(notice.name)
        || noticeNames.has(notice.name) || typeof notice.path !== 'string'
        || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(notice.path)
        || notice.path.split('/').some(part => part === '.' || part === '..')
        || !Number.isSafeInteger(notice.bytes) || notice.bytes <= 0 || notice.bytes > 512 * 1024
        || !hashPattern.test(notice.sha256)) throw new Error('Mac subtitles: invalid notice')
      noticeNames.add(notice.name)
    }
  }
  return lock
}

function readLock(): MacSubtitleLock {
  return validateMacSubtitleLock(JSON.parse(readFileSync(new URL('./macos-subtitle-lock.json', import.meta.url), 'utf8')))
}

/**
 * Identify the exact static dependency recipe without temporary build paths.
 * @param arch - Requested Mac binary architecture.
 * @returns A JSON-serializable cache identity covering sources, notices and the build script.
 */
export function macSubtitleBuildIdentity(arch: MacArch): object {
  return { arch, lock: readLock(), recipeSha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex') }
}

/**
 * Verify corresponding dependency source archives and licenses in a prepared payload.
 * @param payload - Media directory containing sources and notices.
 * @param arch - Requested Mac binary architecture.
 * @returns After every locked source and notice has passed its size and SHA-256 check.
 */
export async function verifyMacSubtitleSources(payload: string, arch: MacArch): Promise<void> {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('Mac subtitles: unsupported architecture')
  for (const library of readLock().libraries) {
    await verifyMediaResource(join(payload, 'sources', library.source.filename), library.source)
    for (const notice of library.notices)
      await verifyMediaResource(join(payload, 'notices', notice.name), { ...notice, filename: notice.name, url: '' })
  }
}

async function run(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && signal === null ? accept()
      : reject(new Error(`Mac subtitles: ${binary} failed (exit ${String(code)}, signal ${String(signal)})`)))
  })
}

class SourceFetchFailure extends Error {
  constructor(readonly networkFailure: boolean, code: number | null, signal: NodeJS.Signals | null) {
    super(`Mac subtitles: git source fetch failed (exit ${String(code)}, signal ${String(signal)})`)
  }
}

async function fetchSource(url: string, commit: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  console.info(`Mac subtitles: fetching x264 ${commit} from ${url}`)
  await new Promise<void>((accept, reject) => {
    const child = spawn('/usr/bin/git', ['-c', 'credential.helper=', 'fetch', '--quiet', '--depth=1', url, commit],
      { cwd, env, stdio: ['ignore', 'inherit', 'pipe'] })
    let diagnostic = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { diagnostic = (diagnostic + chunk).slice(-8192); process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null) { accept(); return }
      const networkFailure = signal === null && [
        /could not resolve (?:host|proxy)|failed to connect|could(?:n't| not) connect/iu,
        /connection (?:timed out|reset|was reset)|network is unreachable/iu,
        /ssl(?:_| )connect error|ssl_error_syscall|gnutls (?:recv|handshake) error|tls connect error/iu,
        /requested url returned error: 5\d\d/iu,
      ].some(pattern => pattern.test(diagnostic))
      reject(new SourceFetchFailure(networkFailure, code, signal))
    })
  })
}

async function findCmake(): Promise<string> {
  const configured = process.env.MUSE_MEDIA_CMAKE
  if (configured !== undefined && !isAbsolute(configured)) throw new Error('MUSE_MEDIA_CMAKE must be an absolute path')
  const candidates = configured === undefined
    ? (process.env.PATH ?? '').split(delimiter).filter(path => isAbsolute(path)).map(path => join(path, 'cmake'))
    : [configured]
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK) } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) continue
      throw error
    }
    return realpath(candidate)
  }
  throw new Error('Mac subtitles: CMake is required on the build machine; set MUSE_MEDIA_CMAKE to its absolute path')
}

/**
 * Acquire one locked source, allowing only declared x264 mirrors after a primary network failure.
 * @param library - Source and mirrors from the validated lock.
 * @param cache - Directory holding immutable verified source archives.
 * @param env - Scrubbed compiler environment with Git user configuration disabled.
 * @returns The cached archive after its original size and SHA-256 pass, regardless of transport.
 */
export async function obtainMacSubtitleSource(library: SubtitleLibrary, cache: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (library.kind === 'archive') return obtain(library.source, cache)
  const source = join(cache, library.source.filename)
  try { await access(source) } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    const temporary = await mkdtemp(join(cache, '.x264-source-'))
    const archive = join(temporary, library.source.filename)
    try {
      await run('/usr/bin/git', ['init', '--template=', '--quiet'], temporary, env)
      try { await fetchSource(library.source.url, library.release, temporary, env) }
      catch (error) {
        if (!(error instanceof SourceFetchFailure) || !error.networkFailure || library.mirrors?.length !== 1) throw error
        console.info('Mac subtitles: primary x264 network fetch failed; using the locked GitHub mirror')
        await fetchSource(library.mirrors[0]!, library.release, temporary, env)
      }
      await run('/usr/bin/git', ['-c', 'tar.umask=0002', '-c', 'core.attributesFile=/dev/null',
        'archive', '--format=tar', `--prefix=x264-${library.release}/`, `--output=${archive}`, 'FETCH_HEAD'], temporary, env)
      await verifyMediaResource(archive, library.source)
      await rename(archive, source)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  await verifyMediaResource(source, library.source)
  return source
}

/**
 * Build static libass, its text dependencies, x264 and a host-native pkgconf in a disposable stage.
 * @param stage - Disposable build directory; no system package is installed.
 * @param cache - Immutable cache of hash-locked corresponding source archives.
 * @param arch - Target FFmpeg architecture; pkgconf runs on the build host.
 * @returns Prefix, scrubbed FFmpeg build environment, matching sources and notices, and cache identity.
 */
export async function prepareMacSubtitleLibraries(stage: string, cache: string, arch: MacArch): Promise<{
  prefix: string
  env: NodeJS.ProcessEnv
  sources: Array<{ resource: MediaResource; path: string }>
  notices: Array<{ name: string; path: string }>
  identity: object
}> {
  if (process.platform !== 'darwin') throw new Error('Mac subtitles: requires macOS')
  const jobs = process.env.MUSE_MAC_MEDIA_JOBS === undefined ? availableParallelism() : Number(process.env.MUSE_MAC_MEDIA_JOBS)
  if (!Number.isSafeInteger(jobs) || jobs <= 0) throw new Error('MUSE_MAC_MEDIA_JOBS must be a positive integer')
  const lock = readLock()
  const cmake = await findCmake()
  const base = resolve(stage, 'subtitle-libraries')
  if (/\s/u.test(base)) throw new Error('Mac subtitles: compiler staging paths must not contain whitespace; use a system temporary directory')
  const prefix = join(base, 'prefix')
  await mkdir(prefix, { recursive: true })
  await mkdir(cache, { recursive: true })
  const hostEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  await run(cmake, ['--version'], base, hostEnv)
  const machine = arch === 'arm64' ? 'arm64' : 'x86_64'
  const flags = `-O2 -fPIC -arch ${machine} -mmacosx-version-min=11.0`
  const env: NodeJS.ProcessEnv = { ...hostEnv, PATH: `${prefix}/bin:${hostEnv.PATH}`,
    CC: '/usr/bin/clang', CXX: '/usr/bin/clang++', CFLAGS: flags, CXXFLAGS: flags,
    LDFLAGS: `-arch ${machine} -mmacosx-version-min=11.0`,
    PKG_CONFIG: join(prefix, 'bin', 'pkgconf'), PKG_CONFIG_LIBDIR: join(prefix, 'lib', 'pkgconfig'),
    PKG_CONFIG_PATH: '', PKG_CONFIG_TOP_BUILD_DIR: '', MACOSX_DEPLOYMENT_TARGET: '11.0' }
  const sources: Array<{ resource: MediaResource; path: string }> = []
  const notices: Array<{ name: string; path: string }> = []
  const builds = new Map<LibraryName, string>()
  for (const library of lock.libraries) {
    const source = await obtainMacSubtitleSource(library, resolve(cache), hostEnv)
    const build = join(base, library.name)
    await mkdir(build)
    await run('/usr/bin/tar', ['-xf', source, '--strip-components=1', '-C', build], base, hostEnv)
    builds.set(library.name, build)
    sources.push({ resource: library.source, path: source })
    for (const notice of library.notices) {
      const path = join(build, notice.path)
      await verifyMediaResource(path, { ...notice, filename: notice.name, url: '' })
      notices.push({ name: notice.name, path })
    }
  }
  async function autotools(name: LibraryName, args: string[], buildEnv = env): Promise<void> {
    const build = builds.get(name)!
    await run('/bin/sh', ['configure', `--prefix=${prefix}`, '--disable-shared', '--enable-static', ...args], build, buildEnv)
    const directory = name === 'fribidi' ? ['-C', 'lib'] : []
    await run('/usr/bin/make', [...directory, '-j', String(jobs)], build, buildEnv)
    await run('/usr/bin/make', [...directory, 'install'], build, buildEnv)
    if (name === 'fribidi') await run('/usr/bin/make', ['install-pkgconfigDATA'], build, buildEnv)
  }
  await autotools('pkgconf', ['--with-pkg-config-dir=', '--with-system-libdir=/usr/lib', '--with-system-includedir=/usr/include'], hostEnv)
  async function cmakeLibrary(name: LibraryName, args: string[]): Promise<void> {
    const build = builds.get(name)!
    const output = join(build, 'build')
    await run(cmake, ['-S', build, '-B', output, '-G', 'Unix Makefiles',
      '-DCMAKE_MAKE_PROGRAM=/usr/bin/make', '-DCMAKE_C_COMPILER=/usr/bin/clang', '-DCMAKE_CXX_COMPILER=/usr/bin/clang++',
      `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib', '-DCMAKE_BUILD_TYPE=Release',
      `-DCMAKE_OSX_ARCHITECTURES=${machine}`, '-DCMAKE_OSX_DEPLOYMENT_TARGET=11.0', '-DBUILD_SHARED_LIBS=OFF',
      '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DCMAKE_FIND_USE_PACKAGE_REGISTRY=OFF',
      '-DCMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY=OFF', ...args], build, env)
    await run(cmake, ['--build', output, '--parallel', String(jobs)], build, env)
    await run(cmake, ['--install', output], build, env)
  }
  await cmakeLibrary('freetype', ['-DFT_DISABLE_ZLIB=ON', '-DFT_DISABLE_BZIP2=ON', '-DFT_DISABLE_PNG=ON',
    '-DFT_DISABLE_HARFBUZZ=ON', '-DFT_DISABLE_BROTLI=ON', '-DFT_DISABLE_HVF=ON'])
  await cmakeLibrary('harfbuzz', ['-DHB_HAVE_CAIRO=OFF', '-DHB_HAVE_FREETYPE=ON',
    `-DFREETYPE_LIBRARY=${join(prefix, 'lib', 'libfreetype.a')}`,
    `-DFREETYPE_INCLUDE_DIR_ft2build=${join(prefix, 'include', 'freetype2')}`,
    `-DFREETYPE_INCLUDE_DIR_freetype2=${join(prefix, 'include', 'freetype2')}`, '-DHB_HAVE_GRAPHITE2=OFF',
    '-DHB_HAVE_GLIB=OFF', '-DHB_HAVE_ICU=OFF', '-DHB_HAVE_CORETEXT=OFF', '-DHB_HAVE_GOBJECT=OFF',
    '-DHB_HAVE_INTROSPECTION=OFF', '-DHB_BUILD_UTILS=OFF', '-DHB_BUILD_SUBSET=OFF', '-DHB_BUILD_RASTER=OFF',
    '-DHB_BUILD_VECTOR=OFF', '-DHB_BUILD_GPU=OFF', '-DHB_BUILD_GPU_DEMO=OFF', '-DBUILD_TESTING=OFF'])
  await autotools('fribidi', ['--disable-dependency-tracking'])
  await autotools('libass', ['--disable-dependency-tracking', '--disable-fontconfig', '--disable-directwrite',
    '--enable-coretext', '--disable-libunibreak', '--disable-asm'])
  const x264 = builds.get('x264')!
  await run('/bin/sh', ['configure', `--prefix=${prefix}`, '--enable-static', '--disable-cli', '--disable-opencl',
    '--disable-asm', '--enable-pic', `--host=${machine}-apple-darwin`, '--extra-cflags=-mmacosx-version-min=11.0',
    '--extra-ldflags=-mmacosx-version-min=11.0'], x264, env)
  await run('/usr/bin/make', ['-j', String(jobs)], x264, env)
  await run('/usr/bin/make', ['install-lib-static'], x264, env)
  return { prefix, env, sources, notices, identity: macSubtitleBuildIdentity(arch) }
}
