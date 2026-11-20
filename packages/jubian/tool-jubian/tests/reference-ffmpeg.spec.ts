/** Image normalization checks child completion, output dimensions and owned temporary cleanup. */
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { scaleImageWithFfmpeg, uploadReferenceMethod } from '../src/reference.ts'

const child = vi.hoisted(() => ({ mode: 'valid', calls: [] as { executable: string; args: string[] }[],
  started: undefined as undefined | (() => void),
  pending: undefined as undefined | { close: () => void; aborted: Promise<void>; closed: boolean } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: (path: Parameters<typeof actual.rm>[0], options: Parameters<typeof actual.rm>[1]) => {
    if (child.mode === 'held' && child.pending?.closed !== true) {
      throw new Error('temporary cleanup preceded child completion')
    }
    return actual.rm(path, options)
  } }
})
vi.mock('node:child_process', () => ({
  execFile: (executable: string, args: string[], options: { signal?: AbortSignal },
    callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    const process = new EventEmitter()
    child.calls.push({ executable, args })
    if (child.mode === 'held') {
      const aborted = Promise.withResolvers<undefined>()
      const onAbort = (): void => { callback(new Error('process aborted'), '', ''); aborted.resolve(undefined) }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const pending = { closed: false, close: () => {
        pending.closed = true
        options.signal?.removeEventListener('abort', onAbort)
        process.emit('close', 1, null)
      }, aborted: aborted.promise }
      child.pending = pending
      child.started?.()
      return process
    }
    if (child.mode === 'failure') {
      queueMicrotask(() => { callback(new Error('process exited unsuccessfully'), '', ''); process.emit('close', 1, null) })
      return process
    }
    const bytes = new Uint8Array(24)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    bytes.set([73, 72, 68, 82], 12)
    const view = new DataView(bytes.buffer)
    view.setUint32(16, child.mode === 'wrong-size' ? 17 : 32)
    view.setUint32(20, 32)
    void writeFile(args.at(-1)!, bytes).then(() => { callback(null, '', ''); process.emit('close', 0, null) }, (error: unknown) => {
      callback(error as Error, '', '')
      process.emit('close', 1, null)
    })
    return process
  },
}))

const request = { bytes: new Uint8Array([1]), width: 17, height: 17,
  format: 'png' as const, target: { width: 32, height: 32 } }
afterEach(() => {
  child.pending?.close(); child.pending = undefined; child.started = undefined
  child.calls.splice(0); child.mode = 'valid'; vi.unstubAllEnvs()
})

it('waits for an aborted child to close before releasing its temporary images', async () => {
  child.mode = 'held'
  const started = Promise.withResolvers<undefined>()
  child.started = () => { started.resolve(undefined) }
  const controller = new AbortController()
  const reason = new Error('user cancelled normalization')
  const operation = scaleImageWithFfmpeg({ ...request, signal: controller.signal }, '/test/ffmpeg')
  const rejected = expect(operation).rejects.toBe(reason)
  try {
    await started.promise
    const pending = child.pending
    if (pending === undefined) throw new Error('child was not registered')
    controller.abort(reason)
    await pending.aborted
    pending.close()
    await rejected
    await expect(access(dirname(child.calls[0]!.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    child.pending?.close()
    await operation.catch((_error: unknown) => { /* Cancellation is asserted above; teardown still awaits the child. */ })
  }
})

it('rejects cancellation before allocating temporary files or starting a child', async () => {
  const controller = new AbortController()
  const reason = new Error('already cancelled')
  controller.abort(reason)
  await expect(scaleImageWithFfmpeg({ ...request, signal: controller.signal }, '/test/ffmpeg')).rejects.toBe(reason)
  expect(child.calls).toHaveLength(0)
})

it.each([
  { explicit: '/configured/ffmpeg', env: 'DSH_JUBIAN_FFMPEG', value: '/environment/ffmpeg', expected: '/configured/ffmpeg' },
  { explicit: undefined, env: 'DSH_JUBIAN_FFMPEG', value: '/environment/ffmpeg', expected: '/environment/ffmpeg' },
  { explicit: ' ', env: 'FFMPEG_PATH', value: '/fallback/ffmpeg', expected: '/fallback/ffmpeg' },
  { explicit: undefined, env: 'MUSE_FFMPEG_EXECUTABLE', value: '/muse/ffmpeg', expected: '/muse/ffmpeg' },
  { explicit: undefined, env: 'FFMPEG_PATH', value: ' ', expected: 'ffmpeg' },
])('normalizes dimensions using the configured binary resolution %j', async ({ explicit, env, value, expected }) => {
  for (const name of ['DSH_JUBIAN_FFMPEG', 'FFMPEG_PATH', 'MUSE_FFMPEG_EXECUTABLE']) vi.stubEnv(name, '')
  vi.stubEnv(env, value)
  const bytes = await scaleImageWithFfmpeg(request, explicit), call = child.calls[0]!
  expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16)).toBe(32)
  expect(call.executable).toBe(expected)
  expect(call.args).toContain('scale=32:32')
  await expect(access(dirname(call.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['failure', 'wrong-size'])('refuses %s output and releases its temporary directory', async (mode) => {
  child.mode = mode
  await expect(scaleImageWithFfmpeg(request, '/test/ffmpeg')).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  await expect(access(dirname(child.calls[0]!.args.at(-1)!))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports alignment requirements through the default scaler when child execution fails', async () => {
  child.mode = 'failure'
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); bytes.set([73, 72, 68, 82], 12)
  new DataView(bytes.buffer).setUint32(16, 17); new DataView(bytes.buffer).setUint32(20, 17)
  const root = await mkdtemp(join(tmpdir(), 'jubian-scale-input-'))
  try {
    const source = join(root, 'odd.png')
    await writeFile(source, bytes)
    const network = vi.fn<typeof fetch>()
    expect(await uploadReferenceMethod({ image_path: source }, { fetch: network, ffmpegPath: '/test/ffmpeg' }))
      .toMatchObject({ uploaded: false, status: 'alignment_required', required_width: 16, required_height: 16 })
    expect(network).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
