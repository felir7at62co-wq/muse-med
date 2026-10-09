import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { clearModelAccess, saveModelAccess } from '../src/model-access.ts'
import { clearMuseSessionIfUnchanged, readMuseSession, writeMuseSession } from '../src/session.ts'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'muse-access-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sessionFile = join(root, 'session.json'), accessFile = join(root, 'model-access.json'), baseUrl = 'https://muse.test'
  await writeMuseSession(sessionFile, { baseUrl, username: 'alice', cookie: '__Host-muse=alice-session' })
  const session = await readMuseSession(sessionFile, baseUrl)
  if (!session) throw new Error('Missing fixture login')
  return { root, sessionFile, accessFile, baseUrl, session }
}
const providers = [{ id: 'supplier', access: { baseURL: 'https://supplier.test/v1', apiKey: 'fixture-key' } }]

it('rejects stale issuance and preserves a newer account when deleting old access', async () => {
  const f = await fixture()
  await writeMuseSession(f.sessionFile, { baseUrl: f.baseUrl, username: 'bob', cookie: '__Host-muse=bob-session' })
  expect(await saveModelAccess(f.sessionFile, f.baseUrl, f.session.revision, providers)).toBe(false)
  await expect(readFile(f.accessFile)).rejects.toMatchObject({ code: 'ENOENT' })
  const current = await readMuseSession(f.sessionFile, f.baseUrl)
  if (!current) throw new Error('Missing replacement login')
  expect(await saveModelAccess(f.sessionFile, f.baseUrl, current.revision, providers)).toBe(true)
  await clearModelAccess(f.sessionFile, f.baseUrl, f.session.revision)
  await clearModelAccess(f.sessionFile, f.baseUrl)
  const stored: unknown = JSON.parse(await readFile(f.accessFile, 'utf8'))
  expect(stored).toMatchObject({ revision: current.revision })
  await clearMuseSessionIfUnchanged(f.sessionFile, current)
  await clearModelAccess(f.sessionFile, f.baseUrl)
  await expect(readFile(f.accessFile)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not acquire an account writer lock when an unused home has no access file', async () => {
  const f = await fixture()
  await clearModelAccess(join(f.root, 'unused', 'session.json'), f.baseUrl)
  await expect(readFile(join(f.root, 'unused', 'session.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves another origin access file intact and refuses corrupt storage', async () => {
  const f = await fixture()
  await writeFile(f.accessFile, JSON.stringify({ baseUrl: 'https://other.test', revision: f.session.revision }))
  await clearModelAccess(f.sessionFile, f.baseUrl, f.session.revision)
  expect(await readFile(f.accessFile, 'utf8')).toContain('https://other.test')
  await writeFile(f.accessFile, '{')
  await expect(clearModelAccess(f.sessionFile, f.baseUrl)).rejects.toThrow()
})

it('propagates a storage failure and tolerates another Host deleting access before lock acquisition', async () => {
  const f = await fixture()
  await mkdir(f.accessFile)
  await expect(clearModelAccess(f.sessionFile, f.baseUrl)).rejects.toMatchObject({ code: 'EISDIR' })
  await rm(f.accessFile, { recursive: true })
  await saveModelAccess(f.sessionFile, f.baseUrl, f.session.revision, providers)
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  onTestFinished(() => { vi.mocked(readFile).mockImplementation(actual.readFile) })
  vi.mocked(readFile).mockImplementationOnce(async () => {
    const text = await actual.readFile(f.accessFile, 'utf8')
    await rm(f.accessFile)
    return text
  })
  await clearModelAccess(f.sessionFile, f.baseUrl)
  await expect(readFile(f.accessFile)).rejects.toMatchObject({ code: 'ENOENT' })
})
