/** Prepare the independently versioned Hongguo Java/Python payload from locked public inputs. */
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { extract } from 'tar'
import { assertMediaArchivePath, inventory, obtain, shortStage, unzip, verifyMediaResource, type MediaResource } from './media-resources.ts'
import type { DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'
import { desktopTargetPlatform } from './desktop-build-paths.mjs'

/** Static source files selected independently of a user's saved device or account state. */
export interface HongguoSourceFile { path: string; bytes: number; sha256: string }
/** Per-target binaries plus the minimal original-source inventory. */
export interface HongguoRuntimeLock {
  version: 1
  pythonVersion: string
  javaVersion: string
  cryptoVersion: string
  targets: Record<DesktopAutoUpdateTarget, { python: MediaResource; java: MediaResource; wheel: MediaResource }>
  javaSource: MediaResource
  source?: MediaResource
  sourceFiles: HongguoSourceFile[]
}

const sourcePaths = ['config.json', 'devicepool.pyc', 'sign/unidbg-sign.jar',
  'capture/fq_oversea/libmetasec_ml.so', 'capture/fq_oversea/ms_16777218.bin',
  ...['unwrap_spade', 'extract_keybox_pairs', 'offline_decrypt', 'oracle', 'decutil'].map(name => `frida/${name}.pyc`)]

function resource(value: MediaResource): void {
  if (!value || typeof value.filename !== 'string' || value.filename.includes('/')
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('Hongguo runtime: invalid resource identity')
  }
  assertMediaArchivePath(value.filename)
  const url = new URL(value.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Hongguo runtime: public HTTPS resource required')
  }
}

/** Reject unsupported interpreters, missing targets, private source files and unpinned inputs.
 * @param value - Parsed release lock.
 * @returns Validated release lock.
 */
export function validateHongguoRuntimeLock(value: unknown): HongguoRuntimeLock {
  if (typeof value !== 'object' || value === null) throw new Error('Hongguo runtime: expected lock object')
  const lock = value as HongguoRuntimeLock
  if (lock.version !== 1 || !/^3\.11\.\d+$/u.test(lock.pythonVersion)
    || !/^17\.\d+\.\d+(?:\.\d+)?$/u.test(lock.javaVersion) || !/^\d+\.\d+\.\d+$/u.test(lock.cryptoVersion)
    || !lock.targets || !Array.isArray(lock.sourceFiles)) throw new Error('Hongguo runtime: unsupported lock')
  for (const target of ['mac-arm64', 'mac-x64', 'win-x64'] as const) {
    const files = lock.targets[target]
    if (!files) throw new Error('Hongguo runtime: missing target')
    for (const file of [files.python, files.java, files.wheel]) resource(file)
    const machine = target === 'mac-arm64' ? 'aarch64-apple-darwin'
      : target === 'mac-x64' ? 'x86_64-apple-darwin' : 'x86_64-pc-windows-msvc'
    const javaMachine = target === 'mac-arm64' ? 'aarch64_mac' : target === 'mac-x64' ? 'x64_mac' : 'x64_windows'
    const wheelMachine = target === 'win-x64' ? 'win_amd64.whl' : 'macosx_10_9_universal2.whl'
    if (!files.python.filename.startsWith(`cpython-${lock.pythonVersion}+`)
      || !files.python.filename.endsWith(`-${machine}-install_only.tar.gz`)
      || !files.java.filename.startsWith(`OpenJDK17U-jre_${javaMachine}_hotspot_${lock.javaVersion}_`)
      || !files.wheel.filename.startsWith(`pycryptodome-${lock.cryptoVersion}-cp37-abi3-`)
      || !files.wheel.filename.endsWith(wheelMachine)) {
      throw new Error('Hongguo runtime: incompatible Python input')
    }
  }
  resource(lock.javaSource)
  if (lock.source !== undefined) resource(lock.source)
  if (lock.sourceFiles.length !== sourcePaths.length || sourcePaths.some(path =>
    lock.sourceFiles.filter(file => file.path === path).length !== 1)) throw new Error('Hongguo runtime: source allowlist changed')
  for (const file of lock.sourceFiles) {
    if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/u.test(file.sha256)) {
      throw new Error('Hongguo runtime: invalid source identity')
    }
  }
  return lock
}

/** Extract a trusted, hash-checked distribution while materializing only internal regular-file links.
 * @param archive - Verified TAR archive.
 * @param output - Empty destination.
 */
export async function extractHongguoArchive(archive: string, output: string): Promise<void> {
  const links: Array<{ path: string; target: string }> = []
  const names = new Set<string>()
  let invalid: Error | undefined
  await mkdir(output, { recursive: true })
  await extract({ file: archive, cwd: output, filter(path, entry) {
    if (invalid !== undefined) return false
    try {
      assertMediaArchivePath(path)
      const key = path.replace(/\/$/u, '').toLowerCase()
      if (names.has(key)) throw new Error('Hongguo archive: duplicate member')
      names.add(key)
      if (!('type' in entry)) throw new Error('Hongguo archive: read entry required')
      if (entry.type === 'File' || entry.type === 'Directory') return true
      if (entry.type !== 'SymbolicLink' && entry.type !== 'Link') throw new Error('Hongguo archive: special member refused')
      const linkpath = entry.linkpath
      if (typeof linkpath !== 'string' || isAbsolute(linkpath) || /[\\:\u0000-\u001f]/u.test(linkpath)) {
        throw new Error('Hongguo archive: unsafe link')
      }
      const target = entry.type === 'Link' ? resolve(output, linkpath) : resolve(output, dirname(path), linkpath)
      const destination = relative(resolve(output), target)
      if (destination === '' || destination.startsWith('..') || isAbsolute(destination)) throw new Error('Hongguo archive: escaping link')
      links.push({ path: join(output, path), target })
    } catch (error) {
      invalid = error instanceof Error ? error : new Error('Hongguo archive: invalid member')
    }
    return false
  } })
  if (invalid !== undefined) throw invalid
  while (links.length) {
    let copied = false
    for (let index = links.length - 1; index >= 0; index--) {
      const link = links[index]!
      let target
      try { target = await lstat(link.target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!target.isFile()) throw new Error('Hongguo archive: link target must be a regular file')
      await cp(link.target, link.path, { errorOnExist: true, force: false })
      links.splice(index, 1)
      copied = true
    }
    if (!copied) throw new Error('Hongguo archive: unresolved link')
  }
}

/** Check only the immutable source subset; config contains generic flags and no saved identity.
 * @param root - Selected source app directory.
 * @param files - Exact allowlisted source identities.
 */
export async function verifyHongguoSource(root: string, files: HongguoSourceFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path)
    if (!(await lstat(path)).isFile()) throw new Error('Hongguo source: regular files required')
    await verifyMediaResource(path, { ...file, filename: file.path, url: 'https://example.invalid/' })
  }
  const config: unknown = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
  if (typeof config !== 'object' || config === null || !('base_query' in config)
    || typeof config.base_query !== 'object' || config.base_query === null || !('session_headers' in config)
    || typeof config.session_headers !== 'object' || config.session_headers === null
    || Object.keys(config.base_query).some(name => /(?:device_id|iid|cdid|token|cookie)/iu.test(name))
    || Object.keys(config.session_headers).some(name => !['passport-sdk-version', 'sdk-version', 'x-tt-store-region', 'x-tt-store-region-src'].includes(name))) {
    throw new Error('Hongguo source: private identifiers or headers refused')
  }
}

/** Paths inside a relocatable prepared payload.
 * @param root - Payload directory.
 * @param target - Binary target.
 * @returns Exact Java and Python executables.
 */
export function hongguoRuntimeExecutables(root: string, target: DesktopAutoUpdateTarget): { java: string; python: string } {
  return target === 'win-x64'
    ? { java: join(root, 'java', 'bin', 'java.exe'), python: join(root, 'python', 'python.exe') }
    : { java: join(root, 'java', 'Contents', 'Home', 'bin', 'java'), python: join(root, 'python', 'bin', 'python3.11') }
}

/** Execute native-target Java and isolated Python/AES checks without creating device state.
 * @param root - Complete payload directory, including an installed resources directory.
 * @param target - Recorded binary target.
 */
export function smokeHongguoRuntime(root: string, target: DesktopAutoUpdateTarget): void {
  const platform = desktopTargetPlatform(target)
  if (platform.platform !== process.platform || platform.arch !== process.arch) return
  const executables = hongguoRuntimeExecutables(root, target)
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SystemRoot|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/iu.test(key)))
  const pythonSmoke = ['import sys,importlib.util', 'from Crypto.Cipher import AES', 'assert sys.version_info[:2] == (3,11)',
    'assert importlib.util.MAGIC_NUMBER.hex() == "a70d0d0a"',
    'assert AES.new(bytes(16), AES.MODE_ECB).decrypt(AES.new(bytes(16), AES.MODE_ECB).encrypt(bytes(16))) == bytes(16)',
    'print("HONGGUO_RUNTIME_OK")'].join('; ')
  for (const [binary, args, expression] of [
    [executables.java, ['-version'], /version "17\./u],
    [executables.python, ['-I', '-B', '-c', pythonSmoke], /HONGGUO_RUNTIME_OK/u],
  ] as const) {
    const outcome = spawnSync(binary, [...args], { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true })
    if (outcome.error || outcome.signal || outcome.status !== 0 || !expression.test(outcome.stdout + outcome.stderr)) {
      throw new Error('Hongguo runtime: executable smoke failed')
    }
  }
}

/** Validate every file of an existing payload without repairing or replacing it.
 * @param root - Existing payload directory.
 * @param lock - Expected public inputs.
 * @param target - Expected binary target.
 */
export async function verifyPreparedHongguoRuntime(root: string, lock: HongguoRuntimeLock, target: DesktopAutoUpdateTarget): Promise<void> {
  const descriptor = JSON.parse(await readFile(join(root, 'hongguo-runtime.json'), 'utf8')) as { version: number; target: string; lockHash: string; files: unknown }
  const lockHash = createHash('sha256').update(JSON.stringify(lock)).digest('hex')
  if (descriptor.version !== 1 || descriptor.target !== target || descriptor.lockHash !== lockHash
    || JSON.stringify((await inventory(root)).filter(file => file.path !== 'hongguo-runtime.json')) !== JSON.stringify(descriptor.files)) {
    throw new Error('Hongguo runtime: payload changed; prepare a fresh output')
  }
  await verifyHongguoSource(join(root, 'app'), lock.sourceFiles)
}

/** Publish a complete verified payload exclusively; existing mismatched data remains untouched.
 * @param options - Target, locked cache, output and an optional already-reviewed source app.
 * @returns Final payload directory.
 */
export async function prepareHongguoRuntime(options: {
  output: string
  cache: string
  target: DesktopAutoUpdateTarget
  lock: HongguoRuntimeLock
  sourceDirectory?: string
}): Promise<string> {
  const lock = validateHongguoRuntimeLock(options.lock), output = resolve(options.output), files = lock.targets[options.target]
  let exists = false
  try { await lstat(output); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) {
    await verifyPreparedHongguoRuntime(output, lock, options.target)
    smokeHongguoRuntime(output, options.target)
    return output
  }
  if (options.sourceDirectory === undefined && lock.source === undefined) {
    throw new Error('Hongguo runtime: locked source archive required')
  }
  await mkdir(options.cache, { recursive: true })
  await mkdir(dirname(output), { recursive: true })
  const stage = await shortStage(output)
  try {
    const inputs = new Map<string, string>()
    for (const file of [files.python, files.java, files.wheel, lock.javaSource]) {
      inputs.set(file.filename, await obtain(file, options.cache))
    }
    await extractHongguoArchive(inputs.get(files.python.filename)!, join(stage, '_python'))
    await rename(join(stage, '_python', 'python'), join(stage, 'python'))
    await rm(join(stage, '_python'), { recursive: true })
    const javaExtract = join(stage, '_java')
    if (files.java.filename.endsWith('.zip')) await unzip(inputs.get(files.java.filename)!, javaExtract)
    else await extractHongguoArchive(inputs.get(files.java.filename)!, javaExtract)
    const roots = await readdir(javaExtract)
    if (roots.length !== 1) throw new Error('Hongguo runtime: Java archive must have one root')
    await rename(join(javaExtract, roots[0]!), join(stage, 'java'))
    await rm(javaExtract, { recursive: true })
    const site = options.target === 'win-x64' ? join(stage, 'python', 'Lib', 'site-packages') : join(stage, 'python', 'lib', 'python3.11', 'site-packages')
    // This interpreter uses the standard library and Crypto; package-installation helpers are excluded.
    await rm(site, { recursive: true, force: true })
    await unzip(inputs.get(files.wheel.filename)!, site)
    if ((await readdir(site)).some(name => name.endsWith('.pth'))) throw new Error('Hongguo runtime: executable wheel path files refused')
    let source = options.sourceDirectory
    if (source === undefined) {
      await extractHongguoArchive(await obtain(lock.source!, options.cache), join(stage, '_source'))
      source = join(stage, '_source', 'app')
    }
    await verifyHongguoSource(source, lock.sourceFiles)
    for (const file of lock.sourceFiles) {
      await mkdir(dirname(join(stage, 'app', file.path)), { recursive: true })
      await cp(join(source, file.path), join(stage, 'app', file.path))
    }
    await rm(join(stage, '_source'), { recursive: true, force: true })
    await mkdir(join(stage, 'licenses'))
    await cp(inputs.get(lock.javaSource.filename)!, join(stage, 'licenses', lock.javaSource.filename))
    await writeFile(join(stage, 'resources.lock.json'), JSON.stringify(lock, null, 2) + '\n')
    await writeFile(join(stage, 'licenses', 'REDISTRIBUTION.txt'), 'Eclipse Temurin is GPLv2 with the Classpath Exception. Its unmodified notices and corresponding source archive are retained.\nPython standalone and PyCryptodome license notices remain beside their code. Hongguo source resources are the user-supplied originals; embedded META-INF notices remain in the unmodified JAR. Saved device IDs, account headers and devices.json are excluded.\n')
    smokeHongguoRuntime(stage, options.target)
    await writeFile(join(stage, 'hongguo-runtime.json'), JSON.stringify({ version: 1, target: options.target,
      lockHash: createHash('sha256').update(JSON.stringify(lock)).digest('hex'), sourceFiles: lock.sourceFiles,
      files: await inventory(stage) }, null, 2) + '\n')
    await verifyPreparedHongguoRuntime(stage, lock, options.target)
    await rename(stage, output)
    return output
  } finally { await rm(stage, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, cache: { type: 'string' }, target: { type: 'string' }, 'source-dir': { type: 'string' } } })
  if (!values.output || !values.cache || !['mac-arm64', 'mac-x64', 'win-x64'].includes(values.target ?? '')) throw new Error('Hongguo runtime: output, cache and target required')
  const lock = validateHongguoRuntimeLock(JSON.parse(await readFile(new URL('./hongguo-runtime.lock.json', import.meta.url), 'utf8')))
  await prepareHongguoRuntime({ output: values.output, cache: values.cache, target: values.target as DesktopAutoUpdateTarget, lock,
    ...(values['source-dir'] === undefined ? {} : { sourceDirectory: values['source-dir'] }) })
}
