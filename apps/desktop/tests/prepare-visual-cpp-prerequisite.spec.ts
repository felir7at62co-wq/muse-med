import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareVisualCppPrerequisite, validateMediaLock } from '../scripts/prepare-media-runtime.ts'

const mocked = vi.hoisted(() => ({ spawn: vi.fn<(binary: string, args: string[], options: {
  env: NodeJS.ProcessEnv
  stdio: 'inherit'
  windowsHide: boolean
}) => EventEmitter>() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: mocked.spawn,
}))
const bytes = Buffer.from('locked VC fixture bytes')
const vcResource = { filename: 'vc_redist.x64.exe', url: 'https://example.com/vc_redist.x64.exe',
  bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), productVersion: '14.51.36247.0' }
const lock = validateMediaLock({
  ...JSON.parse(await readFile(new URL('../scripts/media-runtime.lock.json', import.meta.url), 'utf8')),
  vcRedist: vcResource,
})
beforeEach(() => {
  mocked.spawn.mockReset().mockImplementation(() => {
    const process = new EventEmitter()
    queueMicrotask(() => process.emit('close', 0))
    return process
  })
})
afterEach(() => { vi.unstubAllGlobals() })

it('prepares only the verified CRT and checks its exact Microsoft signature and version', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-vc-cache-'))
  test.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const cache = join(root, 'cache')
  const output = join(root, 'payload')
  await mkdir(cache)
  await writeFile(join(cache, vcResource.filename), bytes)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const path = await prepareVisualCppPrerequisite({ output, cache, lock, environment: { SystemRoot: 'C:\\Windows' } })
  expect(path).toBe(join(output, vcResource.filename))
  expect(await readFile(path)).toEqual(bytes)
  expect(await readdir(output)).toEqual([vcResource.filename])
  expect(fetch).not.toHaveBeenCalled()
  expect(mocked.spawn).toHaveBeenCalledTimes(1)
  const [binary, args, options] = mocked.spawn.mock.calls[0]!
  expect(binary).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  expect(args[args.length - 1]).toContain('Get-AuthenticodeSignature')
  expect(args[args.length - 1]).toContain('CN=Microsoft Corporation')
  expect(args[args.length - 1]).not.toContain('Start-Process')
  expect(options.env).toEqual({ SystemRoot: 'C:\\Windows', DSH_MEDIA_VC_FILE: path, DSH_MEDIA_VC_VERSION: vcResource.productVersion })
})

it('downloads only the locked redistributable when its cache is absent', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-vc-fetch-'))
  test.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const fetch = vi.fn(async (url: string) => {
    expect(url).toBe(vcResource.url)
    return new Response(bytes)
  })
  vi.stubGlobal('fetch', fetch)
  const path = await prepareVisualCppPrerequisite({ output: join(root, 'payload'), cache: join(root, 'cache'), lock,
    environment: { SystemRoot: 'C:\\Windows' } })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await readFile(path)).toEqual(bytes)
  expect(await readdir(join(root, 'cache'))).toEqual([vcResource.filename])
})

it('rejects changed cached bytes without replacing them or downloading another runtime', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-vc-changed-'))
  test.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const cache = join(root, 'cache')
  await mkdir(cache)
  const changed = Buffer.alloc(bytes.length)
  await writeFile(join(cache, vcResource.filename), changed)
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(prepareVisualCppPrerequisite({ output: join(root, 'payload'), cache, lock,
    environment: { SystemRoot: 'C:\\Windows' } })).rejects.toThrow('checksum mismatch')
  expect(await readFile(join(cache, vcResource.filename))).toEqual(changed)
  expect(fetch).not.toHaveBeenCalled()
  expect(mocked.spawn).not.toHaveBeenCalled()
})

it('removes a failed partial download and never verifies it as a prerequisite', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-vc-partial-'))
  test.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('short')))
  const cache = join(root, 'cache')
  await expect(prepareVisualCppPrerequisite({ output: join(root, 'payload'), cache, lock,
    environment: { SystemRoot: 'C:\\Windows' } })).rejects.toThrow('size mismatch')
  expect(await readdir(cache)).toEqual([])
  expect(mocked.spawn).not.toHaveBeenCalled()
})

it('refuses an output collision and an unsuccessful signature verification', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'installer-vc-trust-'))
  test.onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const cache = join(root, 'cache')
  const output = join(root, 'payload')
  await mkdir(cache)
  await mkdir(output)
  await writeFile(join(cache, vcResource.filename), bytes)
  await writeFile(join(output, vcResource.filename), 'keep fixture sentinel')
  const options = { output, cache, lock, environment: { SystemRoot: 'C:\\Windows' } }
  await expect(prepareVisualCppPrerequisite(options)).rejects.toThrow()
  expect(await readFile(join(output, vcResource.filename), 'utf8')).toBe('keep fixture sentinel')
  expect(mocked.spawn).not.toHaveBeenCalled()
  await rm(join(output, vcResource.filename))
  mocked.spawn.mockImplementation(() => {
    const process = new EventEmitter()
    queueMicrotask(() => process.emit('close', 1))
    return process
  })
  await expect(prepareVisualCppPrerequisite(options)).rejects.toThrow('media command failed (1)')
})
