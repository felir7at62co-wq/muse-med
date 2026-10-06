import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { checkHongguoRuntime } from './fixtures/hongguo-runtime-smoke.mjs'
import type { HongguoSmokeRuntime } from './fixtures/hongguo-runtime-smoke.mjs'

const environment = { MUSE_HONGGUO_BOOTSTRAP_DEVICES: '1', MUSE_HONGGUO_LEGACY_APP_DIR: import.meta.dirname,
  MUSE_HONGGUO_JAVA_PATH: process.execPath, MUSE_HONGGUO_PYTHON_PATH: process.execPath }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function nativeHandle(stdout: string, stderr = '', exitCode = 0) {
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: Buffer.byteLength(text), lossy: false }) })
  return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done: Promise.resolve({ exitCode, signal: null }), terminate: vi.fn(), waitForExit: vi.fn(async () => true) } satisfies SubprocessHandle
}

function mountedRuntime(signature = JSON.stringify({ 'X-Argus': 'private-signature', 'X-Gorgon': 'private-signature', 'X-Khronos': 1 })) {
  const response = Object.assign(Readable.from([Buffer.from(signature)]), { statusCode: 200 })
  const destroy = vi.spyOn(response, 'destroy')
  const probes: ReturnType<typeof nativeHandle>[] = []
  const spawn = vi.fn((_spec: SubprocessSpawnSpec) => {
    const handle = probes.length === 0 ? nativeHandle('', 'openjdk version "17.0.20.1" 2026-09-15\n')
      : nativeHandle(JSON.stringify({ python: '3.11.17', offline: true, aes: true }))
    probes.push(handle)
    return handle
  })
  const runtime = {
    client: { source: { load: vi.fn<(signal: AbortSignal) => Promise<unknown>>(async () => ({})), sign: vi.fn(async () => response) },
      signer: { ensure: vi.fn(async () => ({ url: 'http://127.0.0.1:12345/sign', token: 'private-token' })) },
      dispose: vi.fn(async () => {}) },
    subprocess: { spawn }, bridge: '/packaged/python/decrypt.py', disposeContext: vi.fn(async () => {}),
  } satisfies HongguoSmokeRuntime
  return { runtime, probes, spawn, response, destroy, mount: vi.fn(async () => runtime) }
}

afterEach(() => { vi.useRealTimers() })

it('publishes only native versions and acceptance booleans after the client and context are disposed', async () => {
  const fixture = mountedRuntime()
  const clientExit = deferred(), contextExit = deferred()
  fixture.runtime.client.dispose.mockImplementation(() => clientExit.promise)
  fixture.runtime.disposeContext.mockImplementation(() => contextExit.promise)
  let settled = false
  const result = checkHongguoRuntime('/packaged/dsh', '/resources/runtime', environment, fixture.mount)
    .then((value) => { settled = true; return value })
  await vi.waitFor(() => { expect(fixture.runtime.client.dispose).toHaveBeenCalled() })
  expect(settled).toBe(false)
  expect(fixture.runtime.disposeContext).not.toHaveBeenCalled()
  clientExit.resolve()
  await vi.waitFor(() => { expect(fixture.runtime.disposeContext).toHaveBeenCalled() })
  expect(settled).toBe(false)
  contextExit.resolve()
  expect(await result).toEqual({ java: '17.0.20.1', python: '3.11.17', bootstrap: true,
    signer: true, offline: true, aes: true, cleanup: true })
  expect(fixture.runtime.client.source.load.mock.invocationCallOrder[0])
    .toBeLessThan(fixture.runtime.client.signer.ensure.mock.invocationCallOrder[0]!)
  expect(fixture.destroy).toHaveBeenCalled()
  for (const handle of fixture.probes) {
    expect(handle.terminate).toHaveBeenCalled()
    expect(handle.waitForExit).toHaveBeenCalled()
  }
})

it.each(['MUSE_HONGGUO_BOOTSTRAP_DEVICES', 'MUSE_HONGGUO_LEGACY_APP_DIR', 'MUSE_HONGGUO_JAVA_PATH', 'MUSE_HONGGUO_PYTHON_PATH'])
('rejects missing %s before creating native resources', async (name) => {
  const fixture = mountedRuntime()
  const incomplete: NodeJS.ProcessEnv = { ...environment }
  Reflect.deleteProperty(incomplete, name)
  await expect(checkHongguoRuntime('/packaged/dsh', '/runtime', incomplete, fixture.mount)).rejects.toThrow('prepared local runtime paths')
  expect(fixture.mount).not.toHaveBeenCalled()
})

it('stops before signing and native probes when source bootstrap fails and suppresses its diagnostic', async () => {
  const fixture = mountedRuntime()
  fixture.runtime.client.source.load.mockRejectedValueOnce(new Error('private-device-identifier'))
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow(/^Hongguo native payload check failed$/u)
  expect(fixture.runtime.client.signer.ensure).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it('disposes the client and context when the original signer cannot start', async () => {
  const fixture = mountedRuntime()
  fixture.runtime.client.signer.ensure.mockRejectedValueOnce(new Error('signer missing'))
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('native payload check failed')
  expect(fixture.runtime.client.source.sign).not.toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it.each(['{"error":"private-device-identifier"}', '{"x-argus":"private-signature"}', 'private-signature'])
('rejects an invalid local signature response without disclosing it (%#)', async (signature) => {
  const fixture = mountedRuntime(signature)
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow(/^Hongguo native payload check failed$/u)
  expect(fixture.destroy).toHaveBeenCalled()
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it('rejects an unsuccessful signing HTTP response and destroys its body', async () => {
  const fixture = mountedRuntime()
  fixture.response.statusCode = 403
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('native payload check failed')
  expect(fixture.destroy).toHaveBeenCalled()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it.each([
  { stdout: '{"ok":false}', stderr: '', exitCode: 1 },
  { stdout: '{"python":"3.11.17","offline":false,"aes":true}', stderr: '', exitCode: 0 },
  { stdout: '{"python":"3.11.17","offline":true,"aes":false}', stderr: '', exitCode: 0 },
  { stdout: '{"python":"3.12.1","offline":true,"aes":true}', stderr: '', exitCode: 0 },
  { stdout: '{"python":"3.11.17","offline":true,"aes":true}', stderr: 'private-source-diagnostic', exitCode: 0 },
])('rejects incompatible or unavailable original Python modules and joins the probe (%#)', async (output) => {
  const fixture = mountedRuntime()
  const handle = nativeHandle(output.stdout, output.stderr, output.exitCode)
  fixture.spawn.mockImplementationOnce(() => nativeHandle('', 'openjdk version "17.0.20.1"\n')).mockImplementationOnce(() => handle)
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow(/^Hongguo native payload check failed$/u)
  expect(handle.terminate).toHaveBeenCalled()
  expect(handle.waitForExit).toHaveBeenCalled()
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it('terminates and joins a rejected native process before disposing its provider', async () => {
  const fixture = mountedRuntime()
  const handle = nativeHandle('')
  const failure = Promise.reject(new Error('spawn failed'))
  void failure.catch(() => {})
  fixture.spawn.mockImplementationOnce(() => ({ ...handle, done: failure }))
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('native payload check failed')
  expect(handle.terminate).toHaveBeenCalled()
  expect(handle.waitForExit).toHaveBeenCalled()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it('awaits context disposal even when client cleanup fails and hides its diagnostic', async () => {
  const fixture = mountedRuntime()
  const contextExit = deferred()
  fixture.runtime.client.dispose.mockRejectedValueOnce(new Error('private-cleanup-diagnostic'))
  fixture.runtime.disposeContext.mockImplementationOnce(() => contextExit.promise)
  let settled = false
  const result = checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)
  const assertion = expect(result.finally(() => { settled = true }))
    .rejects.toThrow(/^Hongguo native payload cleanup failed$/u)
  await vi.waitFor(() => { expect(fixture.runtime.disposeContext).toHaveBeenCalled() })
  expect(settled).toBe(false)
  contextExit.resolve()
  await assertion
})

it('bounds a hung bootstrap with cancellation and awaits its owned cleanup', async () => {
  vi.useFakeTimers()
  const fixture = mountedRuntime()
  fixture.runtime.client.source.load.mockImplementation(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('bootstrap cancelled')) }, { once: true })
  }))
  const result = checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)
  const assertion = expect(result).rejects.toThrow('native payload check failed')
  await vi.advanceTimersByTimeAsync(180_000)
  await assertion
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})
