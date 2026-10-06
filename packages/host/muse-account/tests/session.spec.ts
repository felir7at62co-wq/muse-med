import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clearMuseSessionIfUnchanged, readMuseSession, writeMuseSession } from '../src/session.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'muse-session-fields-'))
  homes.push(home)
  return join(home, 'session.json')
}
const baseUrl = 'https://muse.example'

it('reads approved optional identity metadata and ignores files issued for another origin', async () => {
  const file = await fixture()
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=fixture', username: 'writer', environment: 'production', workspaceLabel: 'Studio' })
  expect(await readMuseSession(file, baseUrl)).toMatchObject({ environment: 'production', workspaceLabel: 'Studio' })
  expect(await readMuseSession(file, 'https://other.example')).toBeNull()
  const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  await writeFile(file, JSON.stringify({ ...stored, environment: 1, workspaceLabel: false }))
  expect(await readMuseSession(file, baseUrl)).not.toHaveProperty('environment')
  expect(await readMuseSession(file, baseUrl)).not.toHaveProperty('workspaceLabel')
})

it.each(['null', '[]', '"session"'])(
  'refuses a non-object stored session (%s)', async (text) => {
    const file = await fixture(); await writeFile(file, text)
    await expect(readMuseSession(file, baseUrl)).rejects.toThrow('stored session is not an object')
  },
)

it.each([
  { cookie: '' }, { cookie: 5 }, { cookie: '__Host-muse=bad value' }, { cookie: 'other=value' },
  { username: '' }, { username: 5 }, { revision: '' }, { revision: 5 },
])('refuses incomplete persisted account fields (%j)', async (fields) => {
  const file = await fixture()
  await writeFile(file, JSON.stringify({ baseUrl, cookie: '__Host-muse=fixture', username: 'writer', revision: 'revision', ...fields }))
  await expect(readMuseSession(file, baseUrl)).rejects.toThrow('stored session has invalid account fields')
})

it('keeps unreadable storage failures distinct from an absent sign-in', async () => {
  const file = await fixture()
  expect(await readMuseSession(file, baseUrl)).toBeNull()
  await mkdir(file)
  await expect(readMuseSession(file, baseUrl)).rejects.toThrow()
})

it('deletes only the persisted revision whose rejection was confirmed', async () => {
  const file = await fixture()
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=first', username: 'writer' })
  const first = await readMuseSession(file, baseUrl)
  if (!first) throw new Error('Missing persisted fixture session')
  await writeMuseSession(file, { baseUrl, cookie: '__Host-muse=second', username: 'writer' })
  expect(await clearMuseSessionIfUnchanged(file, first)).toBe(false)
  const second = await readMuseSession(file, baseUrl)
  if (!second) throw new Error('Missing replacement fixture session')
  expect(await clearMuseSessionIfUnchanged(file, second)).toBe(true)
  expect(await readMuseSession(file, baseUrl)).toBeNull()
})
