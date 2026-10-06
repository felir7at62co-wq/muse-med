import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from 'tar'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { extractHongguoArchive, hongguoRuntimeExecutables, prepareHongguoRuntime, validateHongguoRuntimeLock, verifyHongguoSource } from '../scripts/prepare-hongguo-runtime.ts'

const lock = validateHongguoRuntimeLock(JSON.parse(await readFile(new URL('../scripts/hongguo-runtime.lock.json', import.meta.url), 'utf8')))
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'muse-hongguo-preparation-'))
  roots.push(path)
  return path
}

it('pins Python 3.11 independently of the ordinary workspace interpreter and rejects private source inventory', () => {
  expect(lock.pythonVersion).toMatch(/^3\.11\./u)
  expect(() => validateHongguoRuntimeLock({ ...lock, pythonVersion: '3.12.0' })).toThrow(/lock/u)
  expect(() => validateHongguoRuntimeLock({ ...lock, sourceFiles: [...lock.sourceFiles, { path: 'devices.json', bytes: 1, sha256: 'a'.repeat(64) }] })).toThrow(/allowlist/u)
  expect(() => validateHongguoRuntimeLock({ ...lock, targets: { ...lock.targets, 'win-x64': undefined } })).toThrow(/target/u)
  expect(() => validateHongguoRuntimeLock({ ...lock, javaSource: { ...lock.javaSource, url: 'https://example.com/source?token=x' } })).toThrow(/HTTPS/u)
})

it('resolves native executables from target resources', () => {
  expect(hongguoRuntimeExecutables('/payload', 'win-x64')).toEqual({ java: join('/payload', 'java', 'bin', 'java.exe'), python: join('/payload', 'python', 'python.exe') })
  expect(hongguoRuntimeExecutables('/payload', 'mac-arm64')).toEqual({ java: join('/payload', 'java', 'Contents', 'Home', 'bin', 'java'), python: join('/payload', 'python', 'bin', 'python3.11') })
})

it('refuses a changed source file before accepting private configuration', async () => {
  const path = await root()
  await writeFile(join(path, 'config.json'), '{}')
  await expect(verifyHongguoSource(path, lock.sourceFiles)).rejects.toThrow(/size/u)
  expect(await readFile(join(path, 'config.json'), 'utf8')).toBe('{}')
})

it.each([
  { base_query: { device_id: 'saved-device' }, session_headers: {} },
  { base_query: {}, session_headers: { Cookie: 'private' } },
])('rejects saved device identifiers and account headers even when their file hash matches', async (config) => {
  const path = await root(), bytes = JSON.stringify(config)
  await writeFile(join(path, 'config.json'), bytes)
  await expect(verifyHongguoSource(path, [{ path: 'config.json', bytes: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex') }])).rejects.toThrow(/private identifiers or headers/u)
})

it('does not delete an incomplete existing payload or silently select new network inputs', async () => {
  const path = await root()
  await writeFile(join(path, 'keep.txt'), 'existing data')
  await expect(prepareHongguoRuntime({ output: path, cache: join(path, 'cache'), target: 'mac-arm64', lock })).rejects.toThrow()
  expect(await readFile(join(path, 'keep.txt'), 'utf8')).toBe('existing data')
})

it.skipIf(process.platform === 'win32')('materializes internal file aliases and refuses an archive link leaving its extraction directory', async () => {
  const path = await root(), source = join(path, 'input'), output = join(path, 'output')
  await mkdir(source)
  await writeFile(join(source, 'python3.11'), 'executable')
  await symlink('python3.11', join(source, 'python3'))
  await create({ file: join(path, 'valid.tgz'), gzip: true, cwd: source }, ['python3', 'python3.11'])
  await extractHongguoArchive(join(path, 'valid.tgz'), output)
  expect(await readFile(join(output, 'python3'), 'utf8')).toBe('executable')
  await symlink('../outside', join(source, 'unsafe'))
  await create({ file: join(path, 'invalid.tgz'), gzip: true, cwd: source }, ['unsafe'])
  await expect(extractHongguoArchive(join(path, 'invalid.tgz'), join(path, 'invalid'))).rejects.toThrow(/escaping link/u)
})
