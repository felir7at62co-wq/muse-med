import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubprocessHandle, SubprocessOutcome, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { checkHongguoRuntime, createNativeDiagnostics } from './fixtures/hongguo-runtime-smoke.mjs'
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
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('Hongguo native payload check failed (stage=bootstrap; code=native_check; deadline=false)')
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
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('Hongguo native payload check failed (stage=signer-request; code=native_check; deadline=false)')
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
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('Hongguo native payload check failed (stage=offline-aes; code=native_check; deadline=false)')
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
  const assertion = expect(result).rejects.toThrow('Hongguo native payload check failed (stage=bootstrap; code=native_check; deadline=true)')
  await vi.advanceTimersByTimeAsync(180_000)
  await assertion
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it.each([
  { code: 'signer_start_timeout', expected: 'signer_start_timeout' },
  { code: 'private-device-signature', expected: 'native_check' },
])('reports only an allowed signer error code and fixed stage (%#)', async ({ code, expected }) => {
  const fixture = mountedRuntime()
  fixture.runtime.client.signer.ensure.mockRejectedValueOnce(Object.assign(new Error('private-cookie-token'), { code }))
  let failure: unknown
  try { await checkHongguoRuntime('/root', '/runtime', environment, fixture.mount) }
  catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error('Expected a bounded diagnostic')
  expect(failure.message).toBe(`Hongguo native payload check failed (stage=signer-start; code=${expected}; deadline=false)`)
  expect(failure.message).not.toContain('private-cookie-token')
  expect(failure.message).not.toContain('private-device-signature')
  expect(fixture.runtime.client.dispose).toHaveBeenCalledOnce()
  expect(fixture.runtime.disposeContext).toHaveBeenCalledOnce()
})

it('reports the mount stage without creating native probes and clears its deadline', async () => {
  vi.useFakeTimers()
  const fixture = mountedRuntime()
  fixture.mount.mockRejectedValueOnce(new Error('private-native-installation-path'))
  await expect(checkHongguoRuntime('/root', '/runtime', environment, fixture.mount)).rejects.toThrow('Hongguo native payload check failed (stage=mount; code=native_check; deadline=false)')
  expect(fixture.spawn).not.toHaveBeenCalled()
  expect(fixture.runtime.client.dispose).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([
  { argv: ['java', 'serve', '12345'], kind: 'java' },
  { argv: ['python', '-I', 'bridge.py'], kind: 'python' },
  { argv: ['ffmpeg', '-version'], kind: 'other' },
  { argv: ['other'], kind: 'other' },
])('delegates native resources and retains only fixed classifications (%#)', async ({ argv, kind }) => {
  const handle = nativeHandle('private-token unidbg 离线签名服务已启动: 127.0.0.1:12345/sign (auth on,\n番茄海外 init 完成 base=0x1234\n', 'SIGBUS libunicorn private-device-path')
  const service: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'> = {
    spawn: vi.fn(() => handle), resolveExecutable: vi.fn(async (value: string) => value),
  }
  const diagnostic = createNativeDiagnostics(service)
  const spec: SubprocessSpawnSpec = { argv, cwd: '/private-tool-workspace', env: { HG_SIGN_TOKEN: 'private-token' }, graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } }
  expect(diagnostic.subprocess.spawn(spec)).toBe(handle)
  expect(await diagnostic.subprocess.resolveExecutable('private-executable', undefined, new AbortController().signal)).toBe('private-executable')
  expect(service.spawn).toHaveBeenCalledWith(spec)
  await diagnostic.settle()
  expect(diagnostic.records()).toHaveLength(1)
  expect(diagnostic.records()[0]).toMatchObject({ kind, exitCode: 0, signal: null, rejected: false,
    markers: { bus: true, unicorn: true, asciiInit: true, utf8Init: true, asciiListener: true, utf8Listener: true } })
  expect(JSON.stringify(diagnostic.records())).not.toMatch(/private-(?:token|device|tool|executable)/u)
})

it('joins admitted process outcomes before publishing diagnostics and bounds retained records', async () => {
  let finish!: (value: SubprocessOutcome) => void
  const handle = { ...nativeHandle(''), done: new Promise<SubprocessOutcome>((done) => { finish = done }) }
  const service: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'> = {
    spawn: () => handle, resolveExecutable: async value => value,
  }
  const diagnostic = createNativeDiagnostics(service)
  for (let index = 0; index < 30; index++) diagnostic.subprocess.spawn({ argv: ['child'], cwd: '/fixture', graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
  let settled = false
  const join = diagnostic.settle().then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(diagnostic.records()).toEqual([])
  finish({ exitCode: 137, signal: 'SIGKILL' })
  await join
  expect(settled).toBe(true)
  expect(diagnostic.records()).toHaveLength(8)
  expect(diagnostic.records().every(record => record.exitCode === 137 && record.signal === 'SIGKILL')).toBe(true)
})

it('joins rejected process observation and replaces collection errors with a fixed fact', async () => {
  const failure = Promise.reject(new Error('private-signature-token'))
  const base = nativeHandle('')
  const handle = { ...base, done: failure, collected: { stdout: { readFrom: () => { throw new Error('private-capture') } } } }
  const service: Pick<SubprocessRuntime, 'spawn' | 'resolveExecutable'> = {
    spawn: () => handle, resolveExecutable: async value => value,
  }
  const diagnostic = createNativeDiagnostics(service)
  diagnostic.subprocess.spawn({ argv: ['java', 'serve'], cwd: '/fixture', graceMs: 1000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } } })
  await diagnostic.settle()
  expect(diagnostic.records()[0]).toMatchObject({ kind: 'java', rejected: true, exitCode: null, signal: null, markers: { captureFailed: true } })
  expect(JSON.stringify(diagnostic.records())).not.toContain('private-')
})
