/** Per-user immutable Hongguo source installation; device creation remains lazy in the tool provider. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

interface SourceFile { path: string; bytes: number; sha256: string }
interface Descriptor { version: 1; target: 'mac-arm64' | 'mac-x64' | 'win-x64'; sourceFiles: SourceFile[] }
const sourcePaths = ['config.json', 'devicepool.pyc', 'sign/unidbg-sign.jar',
  'capture/fq_oversea/libmetasec_ml.so', 'capture/fq_oversea/ms_16777218.bin',
  ...['unwrap_spade', 'extract_keybox_pairs', 'offline_decrypt', 'oracle', 'decutil'].map(name => `frida/${name}.pyc`)]

function sourceFile(value: unknown): SourceFile {
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string'
    || !('bytes' in value) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0
    || !('sha256' in value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('Hongguo runtime: invalid source inventory')
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256 }
}

function descriptor(value: unknown): Descriptor {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
    || !('target' in value) || (value.target !== 'mac-arm64' && value.target !== 'mac-x64' && value.target !== 'win-x64')
    || !('sourceFiles' in value) || !Array.isArray(value.sourceFiles) || value.sourceFiles.length !== sourcePaths.length) {
    throw new Error('Hongguo runtime: invalid installed descriptor')
  }
  const parsed: Descriptor = { version: 1, target: value.target, sourceFiles: value.sourceFiles.map((file: unknown) => sourceFile(file)) }
  if (sourcePaths.some(path => parsed.sourceFiles.filter(file => file.path === path).length !== 1)) {
    throw new Error('Hongguo runtime: invalid source inventory')
  }
  return parsed
}

async function regularTree(root: string, path: string): Promise<void> {
  const parts = relative(resolve(root), resolve(path)).split(/[\\/]/u)
  let current = root
  if (!(await lstat(root)).isDirectory()) throw new Error('Hongguo runtime: real directory required')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const entry = await lstat(current)
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error('Hongguo runtime: linked or special source member refused')
    }
  }
}

async function verifySources(root: string, files: SourceFile[]): Promise<void> {
  for (const file of files) {
    const path = join(root, file.path)
    await regularTree(root, path)
    if ((await lstat(path)).size !== file.bytes) throw new Error('Hongguo runtime: source size mismatch')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Hongguo runtime: invalid source bytes')
      hash.update(chunk)
    }
    if (hash.digest('hex') !== file.sha256) throw new Error('Hongguo runtime: source checksum mismatch')
  }
}

/** Resolve bundled executables and exclusively install the generic source files into private product data.
 * @param options - Installed payload and product home; target comes from the payload descriptor.
 * @returns Environment entries for the local Hongguo provider, without changing general Java or Python lookup.
 */
export async function prepareDesktopHongguoEnvironment(options: { runtime: string; productHome: string }): Promise<NodeJS.ProcessEnv> {
  const runtime = resolve(options.runtime), productHome = resolve(options.productHome)
  const metadataPath = join(runtime, 'hongguo-runtime.json')
  await regularTree(runtime, metadataPath)
  if ((await lstat(metadataPath)).size > 2 * 1024 ** 2) throw new Error('Hongguo runtime: descriptor too large')
  const metadata = descriptor(JSON.parse(await readFile(metadataPath, 'utf8')))
  const source = join(runtime, 'app')
  await verifySources(source, metadata.sourceFiles)
  const identity = createHash('sha256').update(JSON.stringify(metadata.sourceFiles)).digest('hex')
  const parent = join(productHome, 'hongguo')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) throw new Error('Hongguo runtime: linked user directory refused')
  const app = join(parent, `source-${identity}`)
  let exists = false
  try { await lstat(app); exists = true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (exists) await verifySources(app, metadata.sourceFiles)
  else {
    const stage = await mkdtemp(join(parent, '.source-'))
    try {
      for (const file of metadata.sourceFiles) {
        await mkdir(dirname(join(stage, file.path)), { recursive: true, mode: 0o700 })
        await cp(join(source, file.path), join(stage, file.path), { errorOnExist: true, force: false })
        if (process.platform !== 'win32') await chmod(join(stage, file.path), 0o600)
      }
      await verifySources(stage, metadata.sourceFiles)
      try { await rename(stage, app) } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(code))) throw error
        try { await verifySources(app, metadata.sourceFiles) } catch (verificationError) {
          // Windows reports EPERM for an existing directory; incomplete targets retain the rename failure.
          if (code === 'EPERM') throw error
          throw verificationError
        }
      }
    } finally { await rm(stage, { recursive: true, force: true }) }
  }
  const windows = metadata.target === 'win-x64'
  const java = windows ? join(runtime, 'java', 'bin', 'java.exe') : join(runtime, 'java', 'Contents', 'Home', 'bin', 'java')
  const python = windows ? join(runtime, 'python', 'python.exe') : join(runtime, 'python', 'bin', 'python3.11')
  await regularTree(runtime, java)
  await regularTree(runtime, python)
  return { MUSE_HONGGUO_JAVA_PATH: java, MUSE_HONGGUO_PYTHON_PATH: python, MUSE_HONGGUO_LEGACY_APP_DIR: app,
    MUSE_HONGGUO_BOOTSTRAP_DEVICES: '1' }
}
