/** Prepare the pinned upstream ByteVC2 decoder with its exact corresponding source and notices. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { inventory, obtain, shortStage, verifyMediaResource, type MediaResource } from './media-resources.ts'

/** Supported Desktop payload architectures. */
export type Bytevc2Target = 'mac-arm64' | 'mac-x64' | 'win-x64'
/** Fixed upstream release inputs, with a source archive for every binary. */
export interface Bytevc2RuntimeLock {
  version: 1
  release: string
  helperRevision: string
  targets: Record<Bytevc2Target, {
    archive: MediaResource
    source: MediaResource
    helper: Pick<MediaResource, 'filename' | 'bytes' | 'sha256'>
  }>
}
const notices = ['LIBREMPEG-COPYING.AGPLv3', 'LIBREMPEG-COPYING.GPLv3', 'LIBREMPEG-LICENSE.md',
  'LIBREMPEG-NOTICE.txt', 'LIBREMPEG-X264-LICENSE.txt']
const targets: readonly Bytevc2Target[] = ['mac-arm64', 'mac-x64', 'win-x64']
const releaseBase = 'https://github.com/jackotom/hongguo-drama/releases/download/'

/** Validate public release URLs, source identity and bounded resource sizes before preparation.
 * @param value - Parsed lock document.
 * @returns Validated immutable release inputs.
 */
export function validateBytevc2RuntimeLock(value: unknown): Bytevc2RuntimeLock {
  if (typeof value !== 'object' || value === null) throw new Error('ByteVC2 runtime: invalid lock')
  const lock = value as Bytevc2RuntimeLock
  if (lock.version !== 1 || lock.release !== '8.5'
    || lock.helperRevision !== 'cb1f8f3eef84999e61b27e2d44664858179bc240'
    || typeof lock.targets !== 'object' || lock.targets === null
    || Object.keys(lock.targets).length !== targets.length) throw new Error('ByteVC2 runtime: invalid release')
  for (const target of targets) {
    const entry = lock.targets[target]
    const archiveName = `hongguo-downloader-${lock.release}-${target === 'win-x64' ? 'win-x64-setup.exe' : `${target}.zip`}`
    const sourceName = `librempeg-cb1f8f3-x264-b35605a-${target.replace('mac-', '')}-corresponding-source.tar.gz`
    if (typeof entry !== 'object' || entry === null) throw new Error('ByteVC2 runtime: missing target')
    if (typeof entry.helper !== 'object' || entry.helper === null
      || entry.helper.filename !== bytevc2RuntimeFilename(target)
      || !Number.isSafeInteger(entry.helper.bytes) || entry.helper.bytes <= 0 || entry.helper.bytes > 64 * 1024 ** 2
      || typeof entry.helper.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.helper.sha256)) {
      throw new Error('ByteVC2 runtime: invalid helper identity')
    }
    for (const [resource, filename] of [[entry.archive, archiveName], [entry.source, sourceName]] as const) {
      if (typeof resource !== 'object' || resource === null || resource.filename !== filename
        || resource.url !== `${releaseBase}v${lock.release}/${filename}`
        || !Number.isSafeInteger(resource.bytes) || resource.bytes <= 0 || resource.bytes > 256 * 1024 ** 2
        || typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(resource.sha256)) {
        throw new Error('ByteVC2 runtime: invalid resource')
      }
    }
  }
  return lock
}

/** Resolve the helper filename from the selected payload architecture.
 * @param target - Supported Desktop target.
 * @returns Payload-relative executable filename.
 */
export function bytevc2RuntimeFilename(target: Bytevc2Target): string {
  return target === 'win-x64' ? 'librempeg.exe' : 'librempeg'
}

async function verifyArchitecture(root: string, target: Bytevc2Target): Promise<void> {
  const path = join(root, bytevc2RuntimeFilename(target))
  const file = await lstat(path)
  if (!file.isFile() || file.isSymbolicLink() || file.size < 256 || file.size > 64 * 1024 ** 2) {
    throw new Error('ByteVC2 runtime: regular helper required')
  }
  const bytes = await readFile(path)
  if (target === 'win-x64') {
    const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length
    if (bytes.toString('ascii', 0, 2) !== 'MZ' || peOffset + 6 > bytes.length
      || bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0' || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
      throw new Error('ByteVC2 runtime: Windows x64 helper required')
    }
  } else if (bytes.readUInt32LE(0) !== 0xfeedfacf
    || bytes.readUInt32LE(4) !== (target === 'mac-arm64' ? 0x0100000c : 0x01000007)) {
    throw new Error('ByteVC2 runtime: matching Mach-O helper required')
  }
  for (const name of notices) {
    const file = await lstat(join(root, name))
    if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > 128 * 1024) {
      throw new Error('ByteVC2 runtime: original notices required')
    }
  }
}

/** Run native decoder and encoder checks without fetching any media or using user credentials.
 * @param root - Prepared decoder directory.
 * @param target - Payload architecture; foreign operating systems are checked structurally only.
 */
export function smokeBytevc2Runtime(root: string, target: Bytevc2Target): void {
  if ((target === 'win-x64') !== (process.platform === 'win32') || (target !== 'win-x64' && process.platform !== 'darwin')) return
  const executable = join(root, bytevc2RuntimeFilename(target))
  for (const [flag, required] of [['-decoders', /^\s*V\S*\s+bvc2\s/mu],
    ['-encoders', /^\s*V\S*\s+libx264\s/mu]] as const) {
    const result = spawnSync(executable, ['-hide_banner', flag], { encoding: 'utf8', timeout: 30_000,
      maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } })
    if (result.error !== undefined || result.signal !== null || result.status !== 0 || !required.test(result.stdout)) {
      throw new Error('ByteVC2 runtime: required decoder or encoder unavailable')
    }
  }
}

/** Verify preserved payload bytes and corresponding source against the preparation record.
 * @param root - Existing payload directory.
 * @param target - Expected target.
 * @param lock - Expected locked release.
 */
export async function verifyPreparedBytevc2Runtime(root: string, target: Bytevc2Target, lock: Bytevc2RuntimeLock): Promise<void> {
  const directory = await lstat(root)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('ByteVC2 runtime: real directory required')
  const metadataPath = join(root, 'bytevc2-runtime.json')
  const metadata = await lstat(metadataPath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 ** 2) {
    throw new Error('ByteVC2 runtime: invalid payload record')
  }
  const descriptor = JSON.parse(await readFile(metadataPath, 'utf8')) as {
    version: number
    target: string
    lockHash: string
    files: unknown
  }
  if (descriptor.version !== 1 || descriptor.target !== target
    || descriptor.lockHash !== createHash('sha256').update(JSON.stringify(lock)).digest('hex')
    || JSON.stringify((await inventory(root)).filter(file => file.path !== 'bytevc2-runtime.json')) !== JSON.stringify(descriptor.files)) {
    throw new Error('ByteVC2 runtime: payload changed; prepare a fresh output')
  }
  await verifyArchitecture(root, target)
  await verifyMediaResource(join(root, lock.targets[target].helper.filename), lock.targets[target].helper)
  await verifyMediaResource(join(root, lock.targets[target].source.filename), lock.targets[target].source)
}

/** Publish only the decoder, notices and exact source from hash-locked upstream release artifacts.
 * @param options - Selected target, new output directory, cache and public release lock.
 * @returns Absolute decoder runtime directory; existing changed outputs are never replaced.
 */
export async function prepareBytevc2Runtime(options: {
  target: Bytevc2Target
  output: string
  cache: string
  lock: Bytevc2RuntimeLock
}): Promise<string> {
  const lock = validateBytevc2RuntimeLock(options.lock), output = resolve(options.output)
  if (!targets.includes(options.target)) throw new Error('ByteVC2 runtime: unsupported target')
  let exists = false
  try { await lstat(output); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    await verifyPreparedBytevc2Runtime(output, options.target, lock)
    smokeBytevc2Runtime(output, options.target)
    return output
  }
  const cache = join(options.cache, `v${lock.release}`)
  await mkdir(cache, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const entry = lock.targets[options.target]
  const archive = await obtain(entry.archive, cache)
  const source = await obtain(entry.source, cache)
  const stage = await shortStage(output)
  try {
    const require = createRequire(import.meta.url)
    const { path7za } = require('7zip-bin') as { path7za: string }
    const extractor = join(stage, process.platform === 'win32' ? 'extractor.exe' : 'extractor')
    await copyFile(path7za, extractor)
    await chmod(extractor, 0o755)
    const memberRoot = options.target === 'win-x64' ? 'resources/bin/' : '红果短剧.app/Contents/Resources/bin/'
    for (const name of [bytevc2RuntimeFilename(options.target), ...notices]) {
      const bytes = execFileSync(extractor, ['e', '-so', options.target === 'win-x64' ? '-t7z' : '-tzip', archive, `${memberRoot}${name}`],
        { timeout: 120_000, maxBuffer: 64 * 1024 ** 2, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      await writeFile(join(stage, name), bytes, { flag: 'wx', mode: 0o644 })
    }
    await rm(extractor)
    await chmod(join(stage, bytevc2RuntimeFilename(options.target)), 0o755)
    await copyFile(source, join(stage, entry.source.filename))
    await writeFile(join(stage, 'resources.lock.json'), JSON.stringify(lock, null, 2) + '\n')
    await verifyArchitecture(stage, options.target)
    await verifyMediaResource(join(stage, entry.helper.filename), entry.helper)
    smokeBytevc2Runtime(stage, options.target)
    await writeFile(join(stage, 'bytevc2-runtime.json'), JSON.stringify({ version: 1, target: options.target,
      lockHash: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), files: await inventory(stage),
    }, null, 2) + '\n')
    await verifyPreparedBytevc2Runtime(stage, options.target, lock)
    await rename(stage, output)
    return output
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' } } })
  if (!values.output || !values.cache || !targets.includes(values.target as Bytevc2Target)) {
    throw new Error('ByteVC2 runtime: target, output and cache required')
  }
  const lock = validateBytevc2RuntimeLock(JSON.parse(await readFile(new URL('./bytevc2-runtime.lock.json', import.meta.url), 'utf8')))
  await prepareBytevc2Runtime({ target: values.target as Bytevc2Target, output: values.output, cache: values.cache, lock })
}
