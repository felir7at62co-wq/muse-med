import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareDesktopHongguoEnvironment } from '../src/hongguo-runtime.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const paths = ['config.json', 'devicepool.pyc', 'sign/unidbg-sign.jar',
  'capture/fq_oversea/libmetasec_ml.so', 'capture/fq_oversea/ms_16777218.bin',
  ...['unwrap_spade', 'extract_keybox_pairs', 'offline_decrypt', 'oracle', 'decutil'].map(name => `frida/${name}.pyc`)]

async function fixture(target: 'mac-arm64' | 'win-x64' = 'mac-arm64') {
  const root = await mkdtemp(join(tmpdir(), 'muse-hongguo-payload-'))
  roots.push(root)
  const runtime = join(root, 'runtime'), productHome = join(root, 'home')
  const files = paths.map(path => ({ path, bytes: Buffer.byteLength(path), sha256: createHash('sha256').update(path).digest('hex') }))
  for (const file of files) {
    await mkdir(dirname(join(runtime, 'app', file.path)), { recursive: true })
    await writeFile(join(runtime, 'app', file.path), file.path)
  }
  for (const path of target === 'win-x64' ? ['java/bin/java.exe', 'python/python.exe'] : ['java/Contents/Home/bin/java', 'python/bin/python3.11']) {
    await mkdir(dirname(join(runtime, path)), { recursive: true })
    await writeFile(join(runtime, path), 'binary')
  }
  await writeFile(join(runtime, 'hongguo-runtime.json'), JSON.stringify({ version: 1, target, sourceFiles: files }))
  return { runtime, productHome, files }
}

it('installs only immutable sources and retains a lazily generated device file across launches', async () => {
  const options = await fixture()
  const first = await prepareDesktopHongguoEnvironment(options)
  const app = first.MUSE_HONGGUO_LEGACY_APP_DIR!
  await expect(readFile(join(app, 'devices.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(app, 'devices.json'), 'private retained device')
  const second = await prepareDesktopHongguoEnvironment(options)
  expect(second).toEqual(first)
  expect(second.MUSE_HONGGUO_BOOTSTRAP_DEVICES).toBe('1')
  expect(await readFile(join(app, 'devices.json'), 'utf8')).toBe('private retained device')
  expect(second.MUSE_HONGGUO_JAVA_PATH).toBe(join(options.runtime, 'java', 'Contents', 'Home', 'bin', 'java'))
  expect(second.MUSE_HONGGUO_PYTHON_PATH).toBe(join(options.runtime, 'python', 'bin', 'python3.11'))
})

it('uses the recorded Windows payload target without requiring Java or Python on PATH', async () => {
  const options = await fixture('win-x64')
  const environment = await prepareDesktopHongguoEnvironment(options)
  expect(environment.MUSE_HONGGUO_JAVA_PATH).toBe(join(options.runtime, 'java', 'bin', 'java.exe'))
  expect(environment.MUSE_HONGGUO_PYTHON_PATH).toBe(join(options.runtime, 'python', 'python.exe'))
  expect(environment).not.toHaveProperty('PATH')
  expect(environment).not.toHaveProperty('PYTHONPATH')
})

it('joins competing first-launch installations without publishing partial or duplicate source state', async () => {
  const options = await fixture()
  const environments = await Promise.all([prepareDesktopHongguoEnvironment(options), prepareDesktopHongguoEnvironment(options)])
  expect(environments[0]).toEqual(environments[1])
  for (const file of options.files) {
    expect(await readFile(join(environments[0].MUSE_HONGGUO_LEGACY_APP_DIR!, file.path), 'utf8')).toBe(file.path)
  }
})

it('refuses changed user-side immutable sources and preserves the users device file', async () => {
  const options = await fixture()
  const environment = await prepareDesktopHongguoEnvironment(options)
  const app = environment.MUSE_HONGGUO_LEGACY_APP_DIR!
  await writeFile(join(app, 'devices.json'), 'private')
  await writeFile(join(app, 'config.json'), 'changed.json')
  await expect(prepareDesktopHongguoEnvironment(options)).rejects.toThrow(/size|checksum/u)
  expect(await readFile(join(app, 'devices.json'), 'utf8')).toBe('private')
})

it('refuses a descriptor attempting to copy a saved identity outside the source allowlist', async () => {
  const options = await fixture()
  await writeFile(join(options.runtime, 'hongguo-runtime.json'), JSON.stringify({ version: 1, target: 'mac-arm64',
    sourceFiles: options.files.map((file, index) => index === 0 ? { ...file, path: '../../devices.json' } : file) }))
  await expect(prepareDesktopHongguoEnvironment(options)).rejects.toThrow(/source inventory/u)
  await expect(readFile(join(options.productHome, 'devices.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform === 'win32')('rejects a linked source directory before copying any content', async () => {
  const options = await fixture()
  const sign = join(options.runtime, 'app', 'sign')
  await rm(sign, { recursive: true })
  await mkdir(join(options.runtime, 'elsewhere'))
  await writeFile(join(options.runtime, 'elsewhere', 'unidbg-sign.jar'), 'sign/unidbg-sign.jar')
  await symlink(join(options.runtime, 'elsewhere'), sign)
  await expect(prepareDesktopHongguoEnvironment(options)).rejects.toThrow(/linked/u)
})
