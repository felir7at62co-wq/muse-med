import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MuseAsrClient } from '../src/asr.ts'
import { writeMuseSession } from '../src/session.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(fetcher: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'muse-asr-client-'))
  dirs.push(dir)
  const baseUrl = 'https://muse.test', sessionFile = join(dir, 'session.json'), file = join(dir, 'clip.mp3')
  await writeMuseSession(sessionFile, { baseUrl, cookie: '__Host-muse=secret-session', username: 'alice' })
  await writeFile(file, 'mock mp3')
  return { client: new MuseAsrClient({ baseUrl, sessionFile, requestTimeoutMs: 2000, fetcher }), file }
}

it('uses the current account cookie and a persisted UUID without returning credentials', async () => {
  const id = randomUUID(), seen: Array<{ url: string; init: RequestInit }> = []
  const fetcher: typeof fetch = async (url, init) => {
    seen.push({ url: url instanceof URL ? url.href : typeof url === 'string' ? url : url.url, init: init! })
    return new Response(JSON.stringify({ id, status: 'processing' }), { status: 202 })
  }
  const { client, file } = await fixture(fetcher)
  expect(await client.submit(file, id, 'a'.repeat(64), 'zh')).toEqual({ id, status: 'processing' })
  expect(await client.get(id)).toEqual({ id, status: 'processing' })
  expect(seen.map(item => item.url)).toEqual(['https://muse.test/api/asr/jobs', `https://muse.test/api/asr/jobs/${id}`])
  expect(new Headers(seen[0]!.init.headers).get('cookie')).toContain('__Host-muse=secret-session')
  expect(JSON.stringify(await client.get(id))).not.toContain('secret-session')
})

it('reports an unconfigured server and a missing old task as distinct failures', async () => {
  const id = randomUUID()
  const missing = await fixture(async () => new Response('{}', { status: 404 }))
  await expect(missing.client.submit(missing.file, id, 'a'.repeat(64), 'zh')).rejects.toMatchObject({ code: 'server-not-configured' })
  await expect(missing.client.get(id)).rejects.toMatchObject({ code: 'job-not-found' })
  const unavailable = await fixture(async () => new Response('{}', { status: 503 }))
  await expect(unavailable.client.get(id)).rejects.toMatchObject({ code: 'server-not-configured' })
})
