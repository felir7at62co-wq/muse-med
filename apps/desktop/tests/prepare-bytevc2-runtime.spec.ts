/** Decoder resources retain their exact source and reject incomplete or changed payloads. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { bytevc2RuntimeFilename, prepareBytevc2Runtime, smokeBytevc2Runtime, validateBytevc2RuntimeLock,
  verifyPreparedBytevc2Runtime, type Bytevc2Target } from '../scripts/prepare-bytevc2-runtime.ts'

const { smoke } = vi.hoisted(() => ({ smoke: vi.fn(() => ({
  status: 0, signal: null, error: undefined, stdout: ' V....D bvc2 decoder\n V....D libx264 encoder\n', stderr: '',
})) }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawnSync: smoke }))
const lock = validateBytevc2RuntimeLock(JSON.parse(await readFile(new URL('../scripts/bytevc2-runtime.lock.json', import.meta.url), 'utf8')))
const roots: string[] = []
afterEach(async () => {
  smoke.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture(target: Bytevc2Target = 'mac-arm64', omit?: string, wrongArchitecture = false) {
  const root = await mkdtemp(join(tmpdir(), 'bytevc2-runtime-'))
  roots.push(root)
  const cache = join(root, 'cache'), output = join(root, 'payload')
  await mkdir(cache)
  const binary = Buffer.alloc(512)
  if (target === 'win-x64') {
    binary.write('MZ'); binary.writeUInt32LE(128, 60); binary.write('PE\0\0', 128); binary.writeUInt16LE(0x8664, 132)
  } else {
    binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(target === 'mac-arm64' && !wrongArchitecture ? 0x0100000c : 0x01000007, 4)
  }
  const names = [bytevc2RuntimeFilename(target), 'LIBREMPEG-COPYING.AGPLv3', 'LIBREMPEG-COPYING.GPLv3',
    'LIBREMPEG-LICENSE.md', 'LIBREMPEG-NOTICE.txt', 'LIBREMPEG-X264-LICENSE.txt']
  const memberRoot = target === 'win-x64' ? 'resources/bin/' : '红果短剧.app/Contents/Resources/bin/'
  let archive = zipSync(Object.fromEntries(names.filter(name => name !== omit).map(name =>
    [memberRoot + name, name === bytevc2RuntimeFilename(target) ? binary : Buffer.from('Original notice\n')])) )
  if (target === 'win-x64') {
    const { path7za } = createRequire(import.meta.url)('7zip-bin') as { path7za: string }
    const extractor = join(root, process.platform === 'win32' ? '7za.exe' : '7za')
    await copyFile(path7za, extractor); await chmod(extractor, 0o755)
    const memberDirectory = join(root, 'resources', 'bin'); await mkdir(memberDirectory, { recursive: true })
    for (const name of names.filter(name => name !== omit)) {
      await writeFile(join(memberDirectory, name), name === bytevc2RuntimeFilename(target) ? binary : Buffer.from('Original notice\n'))
    }
    const packed = join(root, 'fixture.7z')
    execFileSync(extractor, ['a', '-t7z', packed, 'resources'], { cwd: root, stdio: 'ignore' })
    archive = new Uint8Array(await readFile(packed))
  }
  const source = Buffer.from('Exact corresponding source archive fixture\n')
  const targetInputs = { archive: { ...lock.targets[target].archive, bytes: archive.length, sha256: digest(archive) },
    source: { ...lock.targets[target].source, bytes: source.length, sha256: digest(source) },
    helper: { filename: bytevc2RuntimeFilename(target), bytes: binary.length, sha256: digest(binary) } }
  const fixtureLock = { ...lock, targets: { ...lock.targets, [target]: targetInputs } }
  await writeFile(join(cache, targetInputs.archive.filename), archive)
  await writeFile(join(cache, targetInputs.source.filename), source)
  return { root, cache, output, target, lock: fixtureLock }
}

it('pins one release and its matching Librempeg source for every Desktop target', () => {
  expect(lock.helperRevision).toBe('cb1f8f3eef84999e61b27e2d44664858179bc240')
  expect(lock.targets['mac-arm64'].archive.sha256).toBe('2c7ff459b18e55ec24e580349892bc1785f26a7ad659ef4f57deec2691034a09')
  expect(lock.targets['mac-x64'].source.sha256).toBe(lock.targets['mac-arm64'].source.sha256)
  for (const bad of [{ ...lock, release: 'latest' }, { ...lock, targets: {} },
    { ...lock, targets: { ...lock.targets, 'win-x64': { ...lock.targets['win-x64'],
      source: { ...lock.targets['win-x64'].source, url: 'https://example.com/source.tar.gz' } } } }]) {
    expect(() => validateBytevc2RuntimeLock(bad)).toThrow('ByteVC2 runtime:')
  }
})

it.each(['mac-arm64', 'mac-x64', 'win-x64'] as const)('prepares only the %s helper and notices with exact corresponding source', async (target) => {
  const options = await fixture(target)
  await expect(prepareBytevc2Runtime(options)).resolves.toBe(options.output)
  await verifyPreparedBytevc2Runtime(options.output, target, options.lock)
  const source = options.lock.targets[target].source
  expect(await readFile(join(options.output, source.filename))).toEqual(await readFile(join(options.cache, source.filename)))
  await expect(prepareBytevc2Runtime(options)).resolves.toBe(options.output)
})

it('retains changed installations for inspection instead of silently replacing their helper', async () => {
  const options = await fixture()
  await prepareBytevc2Runtime(options)
  await writeFile(join(options.output, 'librempeg'), 'changed helper')
  await expect(prepareBytevc2Runtime(options)).rejects.toThrow('payload changed')
  expect(await readFile(join(options.output, 'librempeg'), 'utf8')).toBe('changed helper')
})

it('rejects a changed helper even when its local inventory record is rewritten to match', async () => {
  const options = await fixture()
  await prepareBytevc2Runtime(options)
  const helperPath = join(options.output, 'librempeg')
  const bytes = await readFile(helperPath); bytes[100] = 1; await writeFile(helperPath, bytes)
  const descriptorPath = join(options.output, 'bytevc2-runtime.json')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>
  }
  const helper = descriptor.files.find(file => file.path === 'librempeg')!
  helper.sha256 = digest(bytes)
  await writeFile(descriptorPath, JSON.stringify(descriptor))
  await expect(prepareBytevc2Runtime(options)).rejects.toThrow('media checksum mismatch: librempeg')
})

it('rejects a changed cached source without publishing an output', async () => {
  const options = await fixture()
  await writeFile(join(options.cache, options.lock.targets[options.target].source.filename), 'wrong source')
  await expect(prepareBytevc2Runtime(options)).rejects.toThrow('media size mismatch')
  await expect(readFile(join(options.output, 'bytevc2-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a release missing a required license instead of publishing a decoder alone', async () => {
  const options = await fixture('mac-arm64', 'LIBREMPEG-COPYING.AGPLv3')
  await expect(prepareBytevc2Runtime(options)).rejects.toThrow('original notices required')
  await expect(readFile(join(options.output, 'bytevc2-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a helper for the wrong target architecture', async () => {
  const options = await fixture('mac-arm64', undefined, true)
  await expect(prepareBytevc2Runtime(options)).rejects.toThrow('matching Mach-O helper required')
  await expect(readFile(join(options.output, 'bytevc2-runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')('requires the actual ByteVC2 decoder and H264 encoder in native smoke output', () => {
  smoke.mockReturnValueOnce({ status: 0, signal: null, error: undefined, stdout: ' V....D h264 only\n', stderr: '' })
  expect(() => {
    smokeBytevc2Runtime('/unused', process.platform === 'win32' ? 'win-x64' : 'mac-arm64')
  }).toThrow('required decoder or encoder')
})
