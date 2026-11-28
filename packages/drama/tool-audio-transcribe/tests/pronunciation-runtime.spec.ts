/** The local speech runtime accepts only provisioned assets and owns its subprocess bounds. */
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { command, digest, offlineLibraryDigest, owned, verifiedSpeechRuntime } from '../src/pronunciation-runtime.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-offline-runtime-')))
  directories.push(root)
  return { root, signal: new AbortController().signal }
}

it('rejects missing, wrong-type and redirected paths inside the approved workspace', async () => {
  const { root } = await fixture()
  const boundary = join(root, 'workspace')
  const outside = join(root, 'outside')
  const link = join(boundary, 'redirected')
  await Promise.all([mkdir(boundary), mkdir(outside)])
  const asset = join(outside, 'source.wav')
  await writeFile(asset, 'outside workspace')
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(owned(boundary, true, root)).resolves.toBe(boundary)
  await expect(owned(boundary, false, root)).rejects.toThrow('OFFLINE_ASR_SCOPE')
  await expect(owned(asset, false, boundary)).rejects.toThrow('OFFLINE_ASR_SCOPE')
  await expect(owned(join(boundary, 'missing.wav'), false, boundary)).rejects.toThrow('OFFLINE_ASR_SCOPE')
  await expect(owned(link, true, boundary)).rejects.toThrow('OFFLINE_ASR_SCOPE')
  await expect(owned(join(link, 'source.wav'), false, boundary)).rejects.toThrow('OFFLINE_ASR_SCOPE')
  await rm(asset)
  await rmdir(outside)
  await expect(owned(link, true, boundary)).rejects.toThrow('OFFLINE_ASR_SCOPE')
})

it('verifies exact local pinned model files and a nested dependency tree, rejecting drift and unknown files', async () => {
  const { root, signal } = await fixture()
  const runtime = { pythonPath: join(root, 'python'), libraryDir: join(root, 'dependencies'),
    modelDir: join(root, 'model'), librarySha256: '' }
  const dependency = join(runtime.libraryDir, 'package', 'module.py')
  const model = join(runtime.modelDir, 'voice.onnx')
  await Promise.all([mkdir(join(runtime.libraryDir, 'package'), { recursive: true }), mkdir(runtime.modelDir)])
  await Promise.all([writeFile(runtime.pythonPath, 'pinned runtime'), writeFile(dependency, 'local dependencies'),
    writeFile(model, 'local model'), writeFile(join(runtime.modelDir, 'model-version.json'), '{}')])
  runtime.librarySha256 = await offlineLibraryDigest(runtime.libraryDir, signal)
  const files = { 'voice.onnx': await digest(model, signal) }
  await expect(verifiedSpeechRuntime(runtime, files, signal)).resolves.toEqual({
    python: runtime.pythonPath, library: runtime.libraryDir, models: runtime.modelDir,
  })
  await expect(verifiedSpeechRuntime({ ...runtime, pythonPath: 'relative' }, files, signal)).rejects.toThrow('Invalid deployment paths')
  await expect(verifiedSpeechRuntime({ ...runtime, librarySha256: 'invalid' }, files, signal)).rejects.toThrow('Invalid deployment paths')
  const unexpected = join(runtime.modelDir, 'unexpected')
  await writeFile(unexpected, 'not provisioned')
  await expect(verifiedSpeechRuntime(runtime, files, signal)).rejects.toThrow('Unexpected file')
  await rm(unexpected)
  await writeFile(model, 'different model')
  await expect(verifiedSpeechRuntime(runtime, files, signal)).rejects.toThrow('Offline model digest differs')
  await writeFile(dependency, 'different dependencies')
  await expect(verifiedSpeechRuntime(runtime, files, signal)).rejects.toThrow('Dependency digest differs')
})

it('returns subprocess output and reports a timeout without exposing its stderr', async () => {
  const { signal } = await fixture()
  const category = 'OFFLINE_TEST_PROCESS'
  await expect(command(process.execPath, ['-e', "process.stdout.write('observed output')"], category, 10_000, signal))
    .resolves.toBe('observed output')
  await expect(command(process.execPath, ['-e', "process.stderr.write('fixture private error'); process.exitCode = 1"],
    category, 10_000, signal)).rejects.toThrow(/^OFFLINE_TEST_PROCESS: Local speech processing failed or exceeded its limit\.$/u)
  await expect(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], category, 100, signal)).rejects.toThrow(category)
})

it('preserves the cancellation reason and the running local subprocess exits', async () => {
  const { root } = await fixture()
  const ready = join(root, 'process-ready')
  const controller = new AbortController()
  const reason = new Error('cancelled by the Session')
  const running = command(process.execPath, ['-e',
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ready],
  'OFFLINE_TEST_PROCESS', 15_000, controller.signal)
  try {
    const rejected = expect(running).rejects.toBe(reason)
    const pid = (): Promise<number> => readFile(ready, 'utf8').then(Number).catch(() => 0)
    await expect.poll(pid, { timeout: 10_000 }).toBeGreaterThan(0)
    controller.abort(reason)
    await rejected
    const child = await pid()
    await expect.poll(() => {
      try { process.kill(child, 0); return true } catch { return false }
    }, { timeout: 10_000 }).toBe(false)
  } finally {
    controller.abort(reason)
    await running.catch(() => undefined)
  }
}, 25_000)
