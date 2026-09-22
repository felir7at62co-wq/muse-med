import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareBgmPublication } from '../scripts/bgm-publication.ts'
import { readTosCredentialRecord, uploadBgmPublication } from '../scripts/upload-bgm.ts'

const roots: string[] = []
const clients: S3Client[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.destroy()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bgm-upload-'))
  roots.push(root)
  const bytes = Buffer.from('published fixture audio')
  const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  const path = join(root, 'track.mp3')
  await writeFile(path, bytes)
  const index = join(root, 'index.json')
  await writeFile(index, JSON.stringify([{ path, bytes: bytes.length, sha256, valence: 4, arousal: 5, moods: [] }]))
  const plan = await prepareBgmPublication(index, root, 'https://music.example')
  const client = new S3Client({ region: 'cn-beijing', endpoint: 'https://storage.example', maxAttempts: 1,
    credentials: { accessKeyId: 'fixture-id', secretAccessKey: 'fixture-secret' } })
  clients.push(client)
  return { root, path, bytes, plan, client }
}

/** The plugin requests public URLs as plain strings; the DOM fetch type is wider. */
function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  throw new Error('unexpected fetch input')
}

/** Answer every client command locally so no request leaves the process. */
function stubSend(client: S3Client, answer: (command: unknown) => unknown): void {
  client.send = async (command: unknown): Promise<unknown> => answer(command)
}

it('uploads audio and verifies public bytes before publishing the catalog', async () => {
  const f = await fixture()
  const writes: string[] = []
  stubSend(f.client, (command) => {
    if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } }
    if (!(command instanceof PutObjectCommand)) throw new Error('unexpected command')
    expect(command.input.IfNoneMatch).toBe('*')
    writes.push(command.input.Key!)
    return { $metadata: {} }
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (requestUrl(input).endsWith('/bgm/index.json')) return new Response(JSON.stringify(f.plan.manifest))
    expect(writes).toHaveLength(1)
    return new Response(f.bytes)
  })
  const result = await uploadBgmPublication(f.client, 'muse', f.plan)
  expect(writes).toEqual([f.plan.artifacts[0]!.key, 'bgm/index.json'])
  expect(result).toEqual({ uploaded: 1, reused: 0, manifest_url: 'https://music.example/bgm/index.json' })
})

it('does not publish a catalog when public audio fails hash validation', async () => {
  const f = await fixture()
  const writes: string[] = []
  stubSend(f.client, (command) => {
    if (command instanceof HeadObjectCommand) throw { $metadata: { httpStatusCode: 404 } }
    if (command instanceof PutObjectCommand) writes.push(command.input.Key!)
    return { $metadata: {} }
  })
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('corrupt public audio'))
  await expect(uploadBgmPublication(f.client, 'muse', f.plan)).rejects.toThrow(/public.*(size|hash)/)
  expect(writes).toEqual([f.plan.artifacts[0]!.key])
})

it('reuses verified existing audio without overwriting it', async () => {
  const f = await fixture()
  const writes: string[] = []
  stubSend(f.client, (command) => {
    if (command instanceof HeadObjectCommand) {
      if (command.input.Key === 'bgm/index.json') throw { $metadata: { httpStatusCode: 404 } }
      return { ContentLength: f.bytes.length, Metadata: { sha256: f.plan.artifacts[0]!.sha256.slice(7) }, $metadata: {} }
    }
    if (command instanceof PutObjectCommand) writes.push(command.input.Key!)
    return { $metadata: {} }
  })
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new Response(requestUrl(input).endsWith('/bgm/index.json')
    ? JSON.stringify(f.plan.manifest) : f.bytes))
  const result = await uploadBgmPublication(f.client, 'muse', f.plan)
  expect(result.reused).toBe(1)
  expect(writes).toEqual(['bgm/index.json'])
})

it('refuses a different existing manifest before making any writes', async () => {
  const f = await fixture()
  const commands: unknown[] = []
  stubSend(f.client, (command) => {
    commands.push(command)
    return { ContentLength: 10, Metadata: { sha256: 'different' }, $metadata: {} }
  })
  await expect(uploadBgmPublication(f.client, 'muse', f.plan)).rejects.toThrow(/existing.*differs/)
  expect(commands).toHaveLength(1)
  expect(commands[0]).toBeInstanceOf(HeadObjectCommand)
})

it('reads only the named managed credential record and hides malformed contents', async () => {
  const f = await fixture()
  const file = join(f.root, 'credentials.yaml')
  await writeFile(file, JSON.stringify({ version: 1, records: { 'drama-resources/tos-muse': {
    kind: 'api-key', env: { TOS_ACCESS_KEY_ID: 'fixture-id', TOS_SECRET_ACCESS_KEY: 'fixture-secret' },
  } } }))
  expect(await readTosCredentialRecord(file)).toEqual({ accessKeyId: 'fixture-id', secretAccessKey: 'fixture-secret' })
  await writeFile(file, 'private-value: [invalid yaml')
  await expect(readTosCredentialRecord(file)).rejects.toThrow('Cannot read the managed TOS credential record')
})
