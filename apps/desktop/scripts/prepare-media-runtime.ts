/** Build a relocatable Windows media payload from hash-locked public inputs; never copy a user environment. */
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'
import extractZip from 'extract-zip'
import { shortStage } from './media-resources.ts'
import { type BgmRuntimeLock, prepareBgmRuntime, smokeBgmRuntime, validateBgmRuntimeLock, verifyPreparedBgmRuntime } from './prepare-bgm-runtime.ts'
import { extract } from 'tar'

/** One public resource accepted only with the recorded size and SHA-256. */
export interface MediaResource { filename: string; url: string; bytes: number; sha256: string }
/** Audited Windows x64 inputs, including source-only zhconv and model notices. */
export interface MediaLock {
  version: 1
  pythonVersion: string
  python: MediaResource
  ffmpeg: MediaResource
  model: MediaResource
  vcRedist: MediaResource & { productVersion: string }
  peInspector: MediaResource
  font: MediaResource
  zhconv?: MediaResource
  wheels: MediaResource[]
  notices: MediaResource[]
}

/** Reject paths that escape or alias installation files on Windows.
 * @param name - Archive member with POSIX separators.
 */
export function assertMediaArchivePath(name: string): void {
  const parts = name.replace(/\/$/u, '').split('/')
  if (name === '' || /[\\:\u0000-\u001f]/u.test(name) || parts.some(part =>
    part === '' || part === '.' || part === '..' || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error('media archive: unsafe member path')
  }
}

/** Validate a resource lock before it can select network sources or local destinations.
 * @param value - Parsed JSON document.
 * @returns Validated media lock.
 */
export function validateMediaLock(value: unknown): MediaLock {
  if (typeof value !== 'object' || value === null) throw new Error('media lock: expected object')
  const lock = value as MediaLock
  if (lock.version !== 1 || !/^3\.\d+\.\d+$/u.test(lock.pythonVersion)
    || !Array.isArray(lock.wheels) || lock.wheels.length === 0 || !Array.isArray(lock.notices)) {
    throw new Error('media lock: unsupported format')
  }
  const vcVersion = lock.vcRedist?.productVersion
  if (typeof vcVersion !== 'string' || !/^14\.\d+\.\d+\.\d+$/u.test(vcVersion)) {
    throw new Error('media lock: exact Visual C++ product version required')
  }
  for (const resource of [lock.python, lock.ffmpeg, lock.model, lock.vcRedist, lock.peInspector, lock.font,
    ...lock.wheels, ...lock.notices,
    ...(lock.zhconv === undefined ? [] : [lock.zhconv])]) {
    if (typeof resource !== 'object' || resource === null || typeof resource.filename !== 'string'
      || typeof resource.url !== 'string' || !/^[a-f0-9]{64}$/u.test(resource.sha256)
      || !Number.isSafeInteger(resource.bytes) || resource.bytes <= 0) throw new Error('media lock: invalid resource')
    assertMediaArchivePath(resource.filename)
    if (resource.filename.includes('/')) throw new Error('media lock: resource filename must be a basename')
    const url = new URL(resource.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('media lock: public HTTPS URL required')
    }
  }
  return lock
}

/** Check cached or downloaded bytes without modifying the file.
 * @param path - File to verify.
 * @param resource - Expected size and SHA-256.
 */
export async function verifyMediaResource(path: string, resource: MediaResource): Promise<void> {
  if ((await stat(path)).size !== resource.bytes) throw new Error(`media size mismatch: ${resource.filename}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== resource.sha256) throw new Error(`media checksum mismatch: ${resource.filename}`)
}

async function obtain(resource: MediaResource, cache: string): Promise<string> {
  const path = join(cache, resource.filename)
  try { await stat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temporary = `${path}.${randomUUID()}.part`
    try {
      const response = await fetch(resource.url, { signal: AbortSignal.timeout(30 * 60_000) })
      if (!response.ok || response.body === null) throw new Error(`media download failed: ${resource.filename}, HTTP ${response.status}`)
      let bytes = 0
      const source = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > resource.bytes) source.destroy(new Error(`media download exceeds locked size: ${resource.filename}`))
      })
      await pipeline(source, createWriteStream(temporary, { flags: 'wx' }))
      await verifyMediaResource(temporary, resource)
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  await verifyMediaResource(path, resource)
  return path
}

async function unzip(path: string, target: string): Promise<void> {
  const names = new Set<string>()
  await mkdir(target, { recursive: true })
  await extractZip(path, { dir: target, onEntry(entry) {
    assertMediaArchivePath(entry.fileName)
    const mode = (entry.externalFileAttributes >>> 16) & 0o170000
    if (mode !== 0 && mode !== 0o100000 && mode !== 0o040000) throw new Error('media archive: links and special files refused')
    const key = entry.fileName.toLowerCase()
    if (names.has(key)) throw new Error('media archive: duplicate Windows member')
    names.add(key)
  } })
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(binary, args, { env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', code => code === 0 ? accept() : reject(new Error(`media command failed (${String(code)}): ${binary}`)))
  })
}

async function inventory(root: string, relative = ''): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const output: Array<{ path: string; bytes: number; sha256: string }> = []
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error('media payload: symbolic links refused')
    if (entry.isDirectory()) output.push(...await inventory(root, name))
    else if (entry.isFile()) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(join(root, name))) hash.update(chunk)
      output.push({ path: name, bytes: (await stat(join(root, name))).size, sha256: hash.digest('hex') })
    } else throw new Error('media payload: special files refused')
  }
  return output.sort((a, b) => a.path.localeCompare(b.path))
}

/** The BGM section every descriptor carries, so a reuse verifies the same facts it was built with.
 * @param lock - Validated BGM runtime lock.
 * @returns Descriptor fields for the bundled emotion runtime.
 */
export function bgmDescriptorSection(lock: BgmRuntimeLock): {
  mertRevision: string
  license: string
  restriction: string
} {
  return {
    mertRevision: lock.mertRevision,
    license: lock.license,
    restriction: 'NONCOMMERCIAL use only; no commercial use or commercial redistribution',
  }
}

/** Redistribution notice for the payload, including the bundled emotion runtime's limit. */
export const REDISTRIBUTION_NOTICE = 'Python and wheel licenses are retained beside their code. The complete FFmpeg distribution retains its LICENSE and README.\n'
  + 'FFmpeg is GPLv3; public binary distribution additionally requires corresponding source for all linked libraries and build scripts. A URL to FFmpeg alone is insufficient. Release owner must complete source-compliance review before publication.\n'
  + 'zhconv source archive and model license are included. The bundled MERT-v1-95M backbone in the bgm payload is CC-BY-NC-4.0 and is authorized for NONCOMMERCIAL use only; its model card, attribution and license notices ship beside it. Both bundled interpreters come from hash-locked public builds: no personal Python environment or user cache is copied.\n'

/** Verify every existing payload file and the exact input lock without repairing or deleting anything.
 * @param root - Existing media payload directory.
 * @param lock - Expected release input lock.
 * @param bgmLock - Expected emotion-runtime input lock.
 */
export async function verifyPreparedMediaRuntime(root: string, lock: MediaLock, bgmLock: BgmRuntimeLock): Promise<void> {
  if (!(await lstat(root)).isDirectory()) throw new Error('media reuse: expected a real directory')
  for (const name of ['resources.lock.json', 'media-runtime.json']) {
    if (!(await lstat(join(root, name))).isFile()) throw new Error('media reuse: metadata must be regular files')
  }
  const priorLock: unknown = JSON.parse(await readFile(join(root, 'resources.lock.json'), 'utf8'))
  if (JSON.stringify(priorLock) !== JSON.stringify(lock)) throw new Error('media reuse: input lock changed; select a fresh output')
  const descriptor: unknown = JSON.parse(await readFile(join(root, 'media-runtime.json'), 'utf8'))
  if (typeof descriptor !== 'object' || descriptor === null || !('version' in descriptor) || descriptor.version !== 1
    || !('files' in descriptor) || !Array.isArray(descriptor.files)) throw new Error('media reuse: invalid inventory')
  const actual = (await inventory(root)).filter(file => file.path !== 'media-runtime.json')
  const notice = await readFile(new URL('./pyav-source-bundle/SOURCE-NOTICES.txt', import.meta.url))
  const bundledNotice = actual.find(file => file.path === 'licenses/PYAV-SOURCE-NOTICES.txt')
  if (bundledNotice?.bytes !== notice.length || bundledNotice.sha256 !== createHash('sha256').update(notice).digest('hex')) {
    throw new Error('media reuse: PyAV source notice missing or changed; select a fresh output')
  }
  const font = actual.find(file => file.path === `fonts/${lock.font.filename}`)
  if (font?.bytes !== lock.font.bytes || font.sha256 !== lock.font.sha256) {
    throw new Error('media reuse: locked CJK font missing or changed; select a fresh output')
  }
  if (JSON.stringify(actual) !== JSON.stringify(descriptor.files)) throw new Error('media reuse: payload inventory or checksum changed')
  const bgm = (descriptor as { bgm?: unknown }).bgm
  if (JSON.stringify(bgm) !== JSON.stringify(bgmDescriptorSection(bgmLock))) throw new Error('media reuse: BGM descriptor changed')
  await verifyPreparedBgmRuntime(join(root, 'bgm'), bgmLock)
}

async function verifyVisualCpp(path: string, version: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot) throw new Error('media: Windows SystemRoot is required for Authenticode verification')
  await run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', [
    "$ErrorActionPreference = 'Stop'",
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:DSH_MEDIA_VC_FILE',
    "if ($signature.Status -ne 'Valid') { throw 'VC runtime Authenticode verification failed' }",
    "if ($signature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Corporation(,|$)') { throw 'VC runtime is not Microsoft signed' }",
    '$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($env:DSH_MEDIA_VC_FILE).ProductVersion',
    "if ($version -ne $env:DSH_MEDIA_VC_VERSION) { throw 'VC runtime product version mismatch' }",
    "Write-Output 'media: official Microsoft VC signature and version verified; installer not executed'",
  ].join('; ')], { ...environment, DSH_MEDIA_VC_FILE: path, DSH_MEDIA_VC_VERSION: version })
}

async function smoke(root: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await run(join(root, 'python', 'python.exe'), ['-B', resolve(import.meta.dirname, 'smoke-media-runtime.py'), root], {
    ...environment, PATH: `${join(root, 'ffmpeg', 'bin')};${environment.PATH ?? ''}`, HF_HUB_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1',
    OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
  })
  await smokeBgmRuntime(join(root, 'bgm'), join(root, 'ffmpeg', 'bin', 'ffmpeg.exe'))
}

/** Reuse a verified payload or build and smoke an exclusive staging directory without replacing existing data.
 * @param options - Output/cache paths, the BGM cache, and a build-only Python executable with pip.
 * @returns Final runtime directory.
 */
export async function prepareMediaRuntime(options: {
  output: string
  cache: string
  buildPython: string
  lock: MediaLock
  bgmLock: BgmRuntimeLock
  bgmCache: string
  modelCache?: string
}): Promise<string> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('media preparation requires Windows x64')
  const lock = validateMediaLock(options.lock)
  const bgmLock = validateBgmRuntimeLock(options.bgmLock)
  const output = resolve(options.output)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|USERPROFILE|LOCALAPPDATA)$/iu.test(key)))
  let exists = false
  try { await lstat(output); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    await verifyPreparedMediaRuntime(output, lock, bgmLock)
    await verifyVisualCpp(join(output, 'prerequisites', lock.vcRedist.filename), lock.vcRedist.productVersion, environment)
    await smoke(output, environment)
    await verifyPreparedMediaRuntime(output, lock, bgmLock)
    process.stdout.write('media: existing payload verified and reused\n')
    return output
  }
  await mkdir(options.cache, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const stage = await shortStage(output)
  try {
    if (options.modelCache !== undefined) {
      await verifyMediaResource(options.modelCache, lock.model)
      const destination = join(options.cache, lock.model.filename)
      if (resolve(options.modelCache) !== resolve(destination)) {
        try { await verifyMediaResource(destination, lock.model) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await cp(options.modelCache, destination, { errorOnExist: true, force: false })
        }
      }
    }
    const files = new Map<string, string>()
    for (const resource of [lock.python, lock.ffmpeg, lock.model, lock.vcRedist, lock.peInspector, lock.font,
      ...lock.wheels, ...lock.notices,
      ...(lock.zhconv === undefined ? [] : [lock.zhconv])]) {
      process.stdout.write(`media: verify ${resource.filename}\n`)
      files.set(resource.filename, await obtain(resource, options.cache))
    }
    await mkdir(join(stage, 'fonts'))
    await cp(files.get(lock.font.filename)!, join(stage, 'fonts', lock.font.filename))
    await mkdir(join(stage, 'prerequisites'))
    const vcInstaller = join(stage, 'prerequisites', lock.vcRedist.filename)
    await cp(files.get(lock.vcRedist.filename)!, vcInstaller)
    await verifyVisualCpp(vcInstaller, lock.vcRedist.productVersion, environment)
    const python = join(stage, 'python')
    await unzip(files.get(lock.python.filename)!, python)
    await unzip(files.get(lock.ffmpeg.filename)!, join(stage, '_ffmpeg'))
    const ffmpegRoots = await readdir(join(stage, '_ffmpeg'))
    if (ffmpegRoots.length !== 1) throw new Error('media: FFmpeg archive must have one root')
    await rename(join(stage, '_ffmpeg', ffmpegRoots[0]!), join(stage, 'ffmpeg'))
    await rm(join(stage, '_ffmpeg'), { recursive: true })
    // The emotion runtime has its own interpreter, model cache and smoke; it is
    // prepared from the payload's own FFmpeg, before the shared inventory runs.
    await prepareBgmRuntime({ output: join(stage, 'bgm'), cache: options.bgmCache,
      ffmpegPath: join(stage, 'ffmpeg', 'bin', 'ffmpeg.exe'), lock: bgmLock })
    await unzip(files.get(lock.model.filename)!, join(stage, 'models', 'faster-whisper-small'))
    const site = join(python, 'Lib', 'site-packages')
    const requirements = lock.wheels.map((wheel) => {
      const match = /^([\w.]+)-([\w.+!]+)-.*\.whl$/u.exec(wheel.filename)
      if (match === null) throw new Error('media: invalid wheel filename')
      return `${match[1]}==${match[2]} --hash=sha256:${wheel.sha256}`
    }).join('\n')
    const requirementsFile = join(stage, 'requirements.lock')
    await writeFile(requirementsFile, requirements + '\n')
    await run(options.buildPython, ['-B', '-m', 'pip', '--isolated', 'install', '--no-index', '--no-deps', '--no-compile', '--only-binary=:all:',
      '--platform', 'win_amd64', '--implementation', 'cp', '--python-version', lock.pythonVersion.split('.').slice(0, 2).join('.'),
      '--target', site, '--find-links', resolve(options.cache), '--require-hashes', '-r', requirementsFile], environment)
    if (lock.zhconv !== undefined) {
      const source = files.get(lock.zhconv.filename)!
      await mkdir(join(stage, '_zhconv'))
      await extract({ file: source, cwd: join(stage, '_zhconv'), filter(path, entry) {
        assertMediaArchivePath(path)
        if (!('type' in entry) || (entry.type !== 'File' && entry.type !== 'Directory')) throw new Error('media source archive: links refused')
        return true
      } })
      const roots = await readdir(join(stage, '_zhconv'))
      if (roots.length !== 1) throw new Error('media: zhconv archive must have one root')
      await cp(join(stage, '_zhconv', roots[0]!, 'zhconv'), join(site, 'zhconv'), { recursive: true })
      await rm(join(stage, '_zhconv'), { recursive: true })
      await mkdir(join(stage, 'licenses'), { recursive: true })
      await cp(source, join(stage, 'licenses', lock.zhconv.filename))
    }
    for (const name of await readdir(site)) {
      if (name.endsWith('.pth')) throw new Error('media: wheel executable/path .pth requires explicit review')
    }
    const tag = lock.pythonVersion.split('.').slice(0, 2).join('')
    await writeFile(join(python, `python${tag}._pth`), `python${tag}.zip\n.\nLib/site-packages\nimport site\n`)
    await mkdir(join(stage, 'licenses'), { recursive: true })
    for (const notice of lock.notices) await cp(files.get(notice.filename)!, join(stage, 'licenses', notice.filename))
    await cp(new URL('./pyav-source-bundle/SOURCE-NOTICES.txt', import.meta.url), join(stage, 'licenses', 'PYAV-SOURCE-NOTICES.txt'))
    await writeFile(join(stage, 'resources.lock.json'), JSON.stringify(lock, null, 2) + '\n')
    await writeFile(join(stage, 'licenses', 'REDISTRIBUTION.txt'), REDISTRIBUTION_NOTICE)
    await run(options.buildPython, ['-I', '-B', resolve(import.meta.dirname, 'audit-media-pe.py'), '--root', stage,
      '--pefile-wheel', files.get(lock.peInspector.filename)!, '--report', join(stage, 'native-dependencies.json')], environment)
    await writeFile(join(stage, 'licenses', 'MICROSOFT-REDISTRIBUTION.txt'), [
      'The bundled unmodified Microsoft Visual C++ Redistributable is an OFFLINE INSTALLER, not an app-local DLL set.',
      'Its hash, Microsoft Authenticode signer, and exact product version were checked without executing the installer.',
      'Installation changes the Windows shared runtime and must be handled by the application installer with administrator consent.',
      'Distribution requires a licensed Visual Studio distributor grant and compliance with its Distributable Code terms.',
      'The retained end-user license does not itself grant redistribution rights; publisher eligibility is not established by this build.',
      'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files',
      'https://visualstudio.microsoft.com/license-terms/',
      'Native import auditing and a developer-machine smoke do not replace clean-Windows installation testing.',
      '',
    ].join('\n'))
    await smoke(stage, environment)
    await writeFile(join(stage, 'media-runtime.json'), JSON.stringify({ version: 1, pythonVersion: lock.pythonVersion,
      prerequisites: { visualCpp: { path: `prerequisites/${lock.vcRedist.filename}`, productVersion: lock.vcRedist.productVersion,
        sha256: lock.vcRedist.sha256, authenticode: 'Valid Microsoft Corporation signature', installationRequired: true } },
      redistributionReviewRequired: ['FFmpeg corresponding source and static dependencies',
        'PyAV vendor GPL combination corresponding-source distribution; source collection is not a wheel rebuild or legal clearance',
        'BGM native libraries (libsndfile, libsoxr, Intel MKL/OpenMP/TBB) corresponding source and notices'],
      bgm: bgmDescriptorSection(bgmLock),
      files: await inventory(stage) }, null, 2) + '\n')
    await rename(stage, output)
    return output
  } finally { await rm(stage, { recursive: true, force: true }) }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' },
    'build-python': { type: 'string', default: 'python' }, 'model-cache': { type: 'string' }, 'bgm-cache': { type: 'string' } } })
  if (!values.output || !values.cache || !values['bgm-cache']) {
    throw new Error('Required: --output <new directory> --cache <download directory> --bgm-cache <bgm download directory>')
  }
  const lock = validateMediaLock(JSON.parse(await readFile(new URL('./media-runtime.lock.json', import.meta.url), 'utf8')))
  const bgmLock = validateBgmRuntimeLock(JSON.parse(await readFile(new URL('./bgm-runtime.lock.json', import.meta.url), 'utf8')))
  await prepareMediaRuntime({ output: values.output, cache: values.cache, bgmCache: resolve(values['bgm-cache']),
    buildPython: values['build-python'], lock, bgmLock,
    ...(values['model-cache'] === undefined ? {} : { modelCache: values['model-cache'] }) })
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main()
