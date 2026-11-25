import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { requestJson } from '@deepseek-ai/dsh-workbench-connection/transport'
import { WorkbenchHttpError, type WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { JINGLIU } from '../src/http.ts'
import { JingliuMedia, mediaPath, projectMediaFolder, type MediaConfig } from '../src/media.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, link: vi.fn(fs.link), stat: vi.fn(fs.stat) }
})

afterEach(() => {
  vi.mocked(link).mockReset()
  vi.mocked(stat).mockReset()
})

interface Seen { method: string; url: string; cookie: string | undefined; range: string | undefined; body: Buffer; headers: IncomingMessage['headers'] }
type Handler = (req: IncomingMessage, body: Buffer, res: ServerResponse) => void | Promise<void>

const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex')
const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }

async function studio(handler: Handler) {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks)
      seen.push({ method: req.method ?? '', url: req.url ?? '', cookie: req.headers.cookie, range: req.headers.range, body, headers: req.headers })
      await handler(req, body, res)
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
  })
  const port = (server.address() as AddressInfo).port
  const origin = 'http://127.0.0.1:' + String(port)
  const check = vi.fn(async () => {})
  const session: WorkbenchSession = {
    identity: 'studio-user', origin, check,
    request: async (path, options = {}) => await requestJson(JINGLIU, origin + '/fwp/v2', path, 5000, options),
    // The Host transport carries the user's credential; object-storage requests must never receive it.
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      headers.set('cookie', 'muse=private')
      return await fetch(url, { ...init, headers, redirect: init.redirect === 'manual' ? 'manual' : 'error' })
    },
  }
  return { origin, host: '127.0.0.1:' + String(port), seen, session, check }
}

async function folder() {
  const root = await mkdtemp(join(tmpdir(), 'jingliu-media-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

function media(host: string, config: Partial<MediaConfig> = {}) {
  return new JingliuMedia({ hosts: [host], downloads: 4, cacheBytes: 1 << 30, maxBytes: 1 << 20, timeoutMs: 10_000, ...config })
}

function localSession(request: WorkbenchSession['request'], fetch = vi.fn<WorkbenchSession['fetch']>()): WorkbenchSession {
  return { identity: 'studio-user', origin: 'https://studio.invalid', check: vi.fn<WorkbenchSession['check']>(), fetch, request }
}

// Serves `objects` from `/tos/<name>` with byte ranges, like presigned object storage.
function objectStore(res: ServerResponse, req: IncomingMessage, objects: Record<string, Buffer>) {
  const name = new URL(req.url ?? '', 'http://x').pathname.replace(/^\/tos\//u, '')
  const bytes = objects[name]
  if (!bytes) { res.writeHead(404); res.end(); return }
  const range = /^bytes=(\d+)-$/u.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${String(start)}-${String(bytes.length - 1)}/${String(bytes.length)}` })
    res.end(bytes.subarray(start))
    return
  }
  res.writeHead(200, { 'content-type': 'image/png', etag: '"' + md5(bytes) + '"' })
  res.end(bytes)
}

it('normalizes stored addresses and refuses traversal and names a platform cannot store', () => {
  expect(mediaPath('/fwp/media/generated/a.png')).toEqual({ path: '/fw/media/generated/a.png', parts: ['generated', 'a.png'] })
  expect(mediaPath('/fw/media/exports/jianying/%E5%8C%85.zip').parts).toEqual(['exports', 'jianying', '%E5%8C%85.zip'])
  expect(mediaPath('/fw/media/bgm-library/calm.mp3').parts).toEqual(['bgm-library', 'calm.mp3'])
  for (const bad of ['/fw/media/../a.png', '/fw/media/a%2e%2e/b', '/fw/media/generated/a:b.png', '/fw/media/generated/CON', '/other/a.png',
    '/fw/media/generated/a.png?x=1', '/fw/media/a.png', '/fw/media/.muse-media.json', '/fw/media/secret/a.png', '/fw/media/backups/j.db',
    '/fw/media/generated/.env', '/fw/media/generated/.hidden/a.png', '/fw/media/generated/x.png.part', '/fw/media/generated/x.png.PART.json',
    '/fw/media/exports/a/b/c.zip']) {
    expect(() => mediaPath(bad)).toThrow(expect.objectContaining({ code: 'JINGLIU_INVALID_MEDIA' }))
  }
  expect(projectMediaFolder('/work', 'p-1')).toBe(join('/work', 'jingliu', 'p-1'))
  expect(() => projectMediaFolder('/work', '../p')).toThrow(expect.objectContaining({ code: 'JINGLIU_INVALID_PROJECT' }))
})

it('resolves in batches of 200 and reads every address through the Host once the studio has no resolve route', async () => {
  let resolveStatus = 200
  const { session, seen, host } = await studio((req, body, res) => {
    if (req.url !== '/fwp/v2/media/resolve') { json(res, 404, {}); return }
    if (resolveStatus !== 200) { json(res, resolveStatus, { detail: 'Not Found' }); return }
    const paths = (JSON.parse(body.toString('utf8')) as { paths: string[] }).paths
    json(res, 200, { tos: true, items: paths.map((path, index) => index % 3 === 0
      ? { path: path.replace('/fw/', '/fwp/'), url: `http://${host}/tos/${String(index)}`, size: 3, etag: '"e"', content_type: 'image/png; q=1', expires_at: 'later' }
      : index % 3 === 1 ? { path, local: true } : { path, error: 'not_in_tos' }) })
  })
  const store = media(host)
  const signal = new AbortController().signal
  const paths = Array.from({ length: 201 }, (_, index) => `/fw/media/generated/${String(index)}.png`)
  const sources = await store.resolve(session, [...paths, '/fwp/media/generated/0.png'], signal)
  expect(seen.map(request => (JSON.parse(request.body.toString('utf8')) as { paths: string[] }).paths.length)).toEqual([200, 1])
  expect(sources.size).toBe(201)
  expect(sources.get('/fw/media/generated/0.png')).toMatchObject({ kind: 'object', size: 3, etag: 'e', contentType: 'image/png' })
  expect(sources.get('/fw/media/generated/1.png')).toEqual({ kind: 'host', path: '/fw/media/generated/1.png' })
  // A file outside the folders object storage manages is still served by the studio.
  expect(sources.get('/fw/media/generated/2.png')).toEqual({ kind: 'host', path: '/fw/media/generated/2.png' })
  resolveStatus = 404
  const fresh = { ...session }
  expect([...(await store.resolve(fresh, paths.slice(0, 2), signal)).values()].map(source => source.kind)).toEqual(['host', 'host'])
  expect([...(await store.resolve(fresh, paths.slice(0, 2), signal)).values()].map(source => source.kind)).toEqual(['host', 'host'])
  expect(seen).toHaveLength(3)
})

it('rejects a resolve answer that omits an address and reads a link to an untrusted host through the Host', async () => {
  let items: unknown[] = []
  const image = Buffer.from('kept by the studio')
  const { session, host, seen } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') { json(res, 200, { items }); return }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(image)
  })
  const warn = vi.fn()
  const store = media(host, { warn })
  const signal = new AbortController().signal
  const a = '/fw/media/generated/a.png'
  const b = '/fw/media/generated/b.png'
  await expect(store.resolve(session, [a], signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INVALID_RESULT' })
  items = [{ path: a, url: 'https://evil.example/a.png', size: 1, etag: 'e' }, { path: b, url: `https://user:pw@${host}/b.png`, size: 1, etag: 'e' }]
  expect([...(await store.resolve(session, [a, b], signal)).values()]).toEqual([{ kind: 'host', path: a }, { kind: 'host', path: b }])
  expect(warn).toHaveBeenCalledTimes(1)
  expect(String(warn.mock.calls[0]?.[0])).toContain('evil.example')
  items = [{ path: a, url: 'https://evil.example/a.png', size: 1, etag: 'e' }]
  expect(Buffer.from(await (await store.open(session, a, signal)).arrayBuffer())).toEqual(image)
  expect(seen.at(-1)).toMatchObject({ url: '/fwp/media/generated/a.png', cookie: 'muse=private' })
})

it('uses the resolved media type when object storage reports none or application/octet-stream', async () => {
  const bytes = Buffer.from('\x89PNG image')
  let reported: string | undefined = 'application/octet-stream'
  const { session, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path: '/fw/media/generated/o.png', url: `http://${host}/tos/o`, size: bytes.length, etag: md5(bytes), content_type: 'image/png' },
        { path: '/fw/media/outputs/f.mp4', local: true }] })
      return
    }
    res.writeHead(200, reported === undefined ? {} : { 'content-type': reported }); res.end(bytes)
  })
  const store = media(host)
  const signal = new AbortController().signal
  const typeOf = async (path: string) => {
    const response = await store.open(session, path, signal)
    await response.arrayBuffer()
    return response.headers.get('content-type')
  }
  expect(await typeOf('/fw/media/generated/o.png')).toBe('image/png')
  expect(await typeOf('/fw/media/outputs/f.mp4')).toBe('video/mp4')
  reported = undefined
  expect(await typeOf('/fw/media/generated/o.png')).toBe('image/png')
  reported = 'image/webp; charset=binary'
  expect(await typeOf('/fw/media/generated/o.png')).toBe('image/webp; charset=binary')
  reported = 'application/octet-stream'
  const root = await folder()
  const files = await store.files(session, ['/fw/media/generated/o.png', '/fw/media/outputs/f.mp4'], root, { keep: false, evict: false, signal })
  expect([...files.values()].map(file => file.contentType)).toEqual(['image/png', 'video/mp4'])
})

it('downloads from object storage without the studio credential, checks the ETag and never downloads a file twice', async () => {
  const objects = { a: Buffer.from('first image bytes'), b: Buffer.from('second') }
  let etagB = md5(objects.b)
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url?.startsWith('/tos/')) { objectStore(res, req, objects); return }
    json(res, 200, { items: [
      { path: '/fw/media/generated/a.png', url: `http://${host}/tos/a?X-Tos-Signature=s`, size: objects.a.length, etag: md5(objects.a), content_type: 'image/png' },
      { path: '/fw/media/uploads/b.png', url: `http://${host}/tos/b`, size: objects.b.length, etag: etagB, content_type: 'image/png' },
    ] })
  })
  const root = await folder()
  const store = media(host)
  const signal = new AbortController().signal
  const files = await store.files(session, ['/fwp/media/generated/a.png'], root, { keep: true, evict: false, signal })
  const a = files.get('/fw/media/generated/a.png')
  expect(a).toEqual({ path: '/fw/media/generated/a.png', file: join(root, 'generated', 'a.png'), size: objects.a.length, contentType: 'image/png' })
  expect(await readFile(join(root, 'generated', 'a.png'))).toEqual(objects.a)
  const index = JSON.parse(await readFile(join(root, '.muse-media.json'), 'utf8')) as { files: Record<string, unknown> }
  expect(index.files['/fw/media/generated/a.png']).toMatchObject({ size: objects.a.length, etag: md5(objects.a), type: 'image/png', keep: true })
  const objectRequests = seen.filter(request => request.url.startsWith('/tos/'))
  expect(objectRequests.map(request => [request.url, request.cookie])).toEqual([['/tos/a?X-Tos-Signature=s', undefined]])
  const count = seen.length
  expect((await store.files(session, ['/fw/media/generated/a.png'], root, { keep: false, evict: false, signal })).get('/fw/media/generated/a.png')).toEqual(a)
  expect(seen).toHaveLength(count)
  etagB = md5(Buffer.from('other'))
  await expect(store.files(session, ['/fw/media/uploads/b.png'], root, { keep: false, evict: false, signal })).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INTEGRITY' })
  await expect(stat(join(root, 'uploads', 'b.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, 'uploads', 'b.png.part'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('resumes a partial download with a byte range', async () => {
  const video = Buffer.from('0123456789abcdefghij')
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url?.startsWith('/tos/')) { objectStore(res, req, { v: video }); return }
    json(res, 200, { items: [{ path: '/fw/media/generated/v.mp4', url: `http://${host}/tos/v`, size: video.length, etag: md5(video), content_type: 'video/mp4' }] })
  })
  const root = await folder()
  await mkdir(join(root, 'generated'))
  await writeFile(join(root, 'generated', 'v.mp4.part'), video.subarray(0, 8))
  await writeFile(join(root, 'generated', 'v.mp4.part.json'), JSON.stringify({ etag: md5(video), size: video.length }))
  const files = await media(host).files(session, ['/fw/media/generated/v.mp4'], root, { keep: false, evict: false, signal: new AbortController().signal })
  expect(await readFile(files.get('/fw/media/generated/v.mp4')!.file)).toEqual(video)
  expect(seen.filter(request => request.url.startsWith('/tos/')).map(request => request.range)).toEqual(['bytes=8-'])
  await expect(stat(join(root, 'generated', 'v.mp4.part.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reads a file the studio keeps through the Host and follows a redirect only to a trusted host without the credential', async () => {
  const image = Buffer.from('host image')
  let redirect = ''
  const { session, seen, host, origin, check } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') { json(res, 200, { items: [{ path: '/fw/media/generated/h.png', local: true }] }); return }
    if (req.url?.startsWith('/tos/')) { objectStore(res, req, { h: image }); return }
    if (redirect) { res.writeHead(307, { location: redirect }); res.end(); return }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(image.length) })
    res.end(image)
  })
  const store = media(host)
  const signal = new AbortController().signal
  const read = async () => Buffer.from(await (await store.open(session, '/fw/media/generated/h.png', signal)).arrayBuffer())
  expect(await read()).toEqual(image)
  expect(seen.at(-1)).toMatchObject({ url: '/fwp/media/generated/h.png', cookie: 'muse=private' })
  expect(check).toHaveBeenCalled()
  redirect = `http://${host}/tos/h`
  expect(await read()).toEqual(image)
  expect(seen.slice(-2).map(request => [request.url, request.cookie])).toEqual([['/fwp/media/generated/h.png', 'muse=private'], ['/tos/h', undefined]])
  redirect = origin.replace('127.0.0.1', 'localhost') + '/tos/h'
  await expect(read()).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_REDIRECT_REFUSED' })
  redirect = ''
  const root = await folder()
  const files = await store.files(session, ['/fw/media/generated/h.png'], root, { keep: true, evict: false, signal })
  expect(files.get('/fw/media/generated/h.png')).toMatchObject({ size: image.length, contentType: 'image/png' })
  const copy = join(root, 'draft.png')
  await store.place(files.get('/fw/media/generated/h.png')!, copy)
  expect(await readFile(copy)).toEqual(image)
  await expect(store.place(files.get('/fw/media/generated/h.png')!, copy)).rejects.toMatchObject({ code: 'EEXIST' })
})

it('names a missing or unreachable file instead of a login failure', async () => {
  const { session, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path: '/fw/media/generated/x.png', error: 'not_found' }, { path: '/fw/media/generated/y.png', local: true }] })
      return
    }
    res.writeHead(502); res.end()
  })
  const store = media(host)
  const signal = new AbortController().signal
  await expect(store.open(session, '/fw/media/generated/x.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_NOT_FOUND' })
  await expect(store.open(session, '/fw/media/generated/y.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_UNAVAILABLE' })
  const failing: WorkbenchSession = { ...session, fetch: async () => { throw new TypeError('fetch failed') } }
  await expect(store.open(failing, '/fw/media/generated/y.png', signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_UNAVAILABLE' })
})

it('limits simultaneous downloads and removes the least recently viewed files beyond the cache size, never kept ones', async () => {
  const objects: Record<string, Buffer> = { k: Buffer.alloc(10, 1), a: Buffer.alloc(10, 2), b: Buffer.alloc(10, 3), c: Buffer.alloc(10, 4) }
  let active = 0
  let peak = 0
  const { session, host } = await studio(async (req, body, res) => {
    if (req.url?.startsWith('/tos/')) {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active -= 1
      objectStore(res, req, objects)
      return
    }
    const paths = (JSON.parse(body.toString('utf8')) as { paths: string[] }).paths
    json(res, 200, { items: paths.map((path) => {
      const name = path.slice('/fw/media/generated/'.length, -'.png'.length)
      return { path, url: `http://${host}/tos/${name}`, size: 10, etag: md5(objects[name]!) }
    }) })
  })
  const root = await folder()
  const store = media(host, { downloads: 2, cacheBytes: 20 })
  const signal = new AbortController().signal
  await store.files(session, ['/fw/media/generated/k.png'], root, { keep: true, evict: false, signal })
  await store.files(session, ['/fw/media/generated/a.png', '/fw/media/generated/b.png'], root, { keep: false, evict: true, signal })
  await store.files(session, ['/fw/media/generated/c.png'], root, { keep: false, evict: true, signal })
  expect(peak).toBe(2)
  const present = async (name: string) => await stat(join(root, 'generated', name + '.png')).then(() => true, () => false)
  expect(await Promise.all(['k', 'a', 'b', 'c'].map(present))).toEqual([true, false, true, true])
  const index = JSON.parse(await readFile(join(root, '.muse-media.json'), 'utf8')) as { files: Record<string, unknown> }
  expect(Object.keys(index.files).sort()).toEqual(['/fw/media/generated/b.png', '/fw/media/generated/c.png', '/fw/media/generated/k.png'])
})

it('uploads a local file straight to object storage and confirms it with the studio', async () => {
  let ticket: Record<string, unknown> = {}
  let complete: [number, unknown] = [200, {}]
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/upload-url') { json(res, 200, ticket); return }
    if (req.url === '/fwp/v2/media/upload-complete') { json(res, ...complete); return }
    if (req.method === 'PUT') { res.writeHead(200); res.end(); return }
    json(res, 404, {})
  })
  const root = await folder()
  const file = join(root, 'face.png')
  await writeFile(file, 'png data')
  const store = media(host)
  const signal = new AbortController().signal
  ticket = { upload_url: `http://${host}/tos/put?sig=1`, headers: { 'x-tos-meta-owner': 'u' }, path: '/fw/media/uploads/u1.png', token: 't1' }
  complete = [200, { path: '/fw/media/uploads/u1.png', size: 8 }]
  expect(await store.upload(session, file, { projectId: 'p1', signal })).toEqual({ path: '/fw/media/uploads/u1.png', size: 8 })
  const [asked, put, done] = seen
  expect(JSON.parse(asked!.body.toString('utf8'))).toEqual({ filename: 'face.png', content_type: 'image/png', size: 8, project_id: 'p1' })
  expect(put).toMatchObject({ method: 'PUT', url: '/tos/put?sig=1', cookie: undefined })
  expect(put!.body.toString('utf8')).toBe('png data')
  expect(put!.headers).toMatchObject({ 'x-tos-meta-owner': 'u', 'content-type': 'image/png', 'content-length': '8' })
  expect(JSON.parse(done!.body.toString('utf8'))).toEqual({ path: '/fw/media/uploads/u1.png', token: 't1' })
  complete = [200, { path: '/fw/media/uploads/u1.png', size: 7 }]
  ticket = { ...ticket, headers: { 'content-type': 'image/png; purpose=presigned' } }
  await expect(store.upload(session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_UNCONFIRMED' })
  expect(seen.at(-2)?.headers['content-type']).toBe('image/png; purpose=presigned')
  ticket = { ...ticket, headers: { cookie: 'x' } }
  await expect(store.upload(session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INVALID_RESULT' })
  ticket = { ...ticket, headers: {}, upload_url: 'https://evil.example/put' }
  await expect(store.upload(session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_HOST_REFUSED' })
  ticket = { ...ticket, upload_url: `http://${host}/tos/put`, path: '/fw/media/generated/u1.png' }
  await expect(store.upload(session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INVALID_RESULT' })
  const text = join(root, 'notes.txt')
  await writeFile(text, 'x')
  await expect(store.upload(session, text, { signal })).rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_INVALID' })
  await expect(store.upload(session, join(root, 'gone.png'), { signal })).rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_FILE_MISSING' })
  const old = await studio((_req, _body, res) => { json(res, 404, { detail: 'Not Found' }) })
  await expect(store.upload(old.session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_UNSUPPORTED' })
})

it('refuses to read Host media once the authenticated connection has changed', async () => {
  const path = '/fw/media/generated/cover.png'
  const { session, host, check, seen } = await studio((_req, _body, res) => {
    json(res, 200, { items: [{ path, local: true }] })
  })
  const changed = Object.assign(new Error('Studio login changed'), { code: 'JINGLIU_ACCOUNT_CHANGED' })
  check.mockRejectedValueOnce(changed)
  await expect(media(host).open(session, path, new AbortController().signal)).rejects.toBe(changed)
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/resolve'])
  expect(check).toHaveBeenCalledTimes(1)
})

it.each(['host', 'object'] as const)('preserves cancellation while opening %s media', async (mode) => {
  const path = '/fw/media/generated/cover.png'
  const reading = Promise.withResolvers<undefined>()
  const { session, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      const source = mode === 'host' ? { path, local: true } : { path, url: `http://${host}/tos/cover`, size: 4, etag: 'revision' }
      json(res, 200, { items: [source] })
      return
    }
    reading.resolve(undefined)
  })
  const controller = new AbortController()
  const stopped = new Error('User cancelled media read')
  const operation = media(host).open(session, path, controller.signal)
  const rejected = expect(operation).rejects.toBe(stopped)
  try {
    await Promise.race([reading.promise, operation])
  } finally {
    controller.abort(stopped)
  }
  await rejected
})

it.each([404, 502, 'lost connection'] as const)('reports object-storage failure %s as a media error', async (status) => {
  const path = '/fw/media/generated/cover.png'
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path, url: `http://${host}/tos/cover`, size: 4, etag: 'revision' }] })
      return
    }
    if (status === 'lost connection') { res.destroy(); return }
    res.writeHead(status, { 'content-type': 'text/plain' })
    res.end('object storage unavailable')
  })
  const code = status === 404 ? 'JINGLIU_MEDIA_NOT_FOUND' : 'JINGLIU_MEDIA_UNAVAILABLE'
  await expect(media(host).open(session, path, new AbortController().signal)).rejects.toMatchObject({ code })
  expect(seen.at(-1)).toMatchObject({ url: '/tos/cover', cookie: undefined })
})

it.each(['unassigned', 'mailto:media@example.invalid'])('routes unusable storage links like %s through the Host', async (url) => {
  const path = '/fw/media/generated/cover.png'
  const bytes = Buffer.from('face')
  const { session, host, seen } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [null, { path, size: '4', etag: 'revision' }, { path, size: bytes.length, etag: 'revision', url }] })
      return
    }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(bytes)
  })
  const warn = vi.fn()
  const result = await media(host, { warn }).open(session, path, new AbortController().signal)
  expect(await result.text()).toBe('face')
  expect(seen.at(-1)).toMatchObject({ cookie: 'muse=private' })
  expect(warn.mock.calls[0]?.[0]).toContain('an invalid link')
})

it.each(['object', 'host', 'missing'] as const)('refreshes storage links and uses the new %s resolution', async (replacement) => {
  const path = '/fw/media/generated/clip.mp4'
  const bytes = Buffer.from('video bytes')
  let resolutions = 0
  const { session, host, seen, check } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      resolutions += 1
      const cloud = { path, url: `http://${host}/tos/${resolutions === 1 ? 'expired' : 'new'}`, size: bytes.length, etag: 'new-revision' }
      const source = resolutions === 1 || replacement === 'object' ? cloud
        : replacement === 'host' ? { path, error: 'not_in_tos' } : { path, error: 'not_found' }
      json(res, 200, { items: [source] })
      return
    }
    if (req.url === '/tos/expired') { res.writeHead(503); res.end(); return }
    if (req.url === '/tos/new') { objectStore(res, req, { new: bytes }); return }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length })
    res.end(bytes)
  })
  const root = await folder()
  const signal = new AbortController().signal
  const result = media(host).files(session, [path], root, { keep: true, evict: false, signal })
  if (replacement === 'missing') {
    await expect(result).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_NOT_FOUND' })
    await expect(stat(join(root, 'generated', 'clip.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  } else {
    const local = (await result).get(path)
    expect(local?.file).toBe(join(root, 'generated', 'clip.mp4'))
    expect(await readFile(join(root, 'generated', 'clip.mp4'))).toEqual(bytes)
  }
  expect(resolutions).toBe(2)
  expect(seen.filter(call => call.url.startsWith('/tos/')).every(call => call.cookie === undefined)).toBe(true)
  if (replacement === 'host') expect(check).toHaveBeenCalledTimes(2)
})

it.each(['wrong range', 'ignored range'] as const)('re-reads a complete object after storage returns a %s', async (behavior) => {
  const path = '/fw/media/generated/clip.mp4'
  const bytes = Buffer.from('real video bytes')
  const { session, host, seen } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path, url: `http://${host}/tos/clip`, size: bytes.length, etag: md5(bytes) }] })
      return
    }
    if (req.headers.range !== undefined) {
      if (behavior === 'wrong range') {
        res.writeHead(206, { 'content-range': `bytes 0-3/${String(bytes.length)}` })
        res.end(bytes.subarray(0, 4))
      } else {
        res.writeHead(200); res.end(bytes)
      }
      return
    }
    objectStore(res, req, { clip: bytes })
  })
  const root = await folder()
  const directory = join(root, 'generated')
  await mkdir(directory)
  const file = join(directory, 'clip.mp4')
  await writeFile(file + '.part', 'older')
  await writeFile(file + '.part.json', JSON.stringify({ etag: md5(bytes), size: bytes.length }))
  const signal = new AbortController().signal
  await media(host).files(session, [path], root, { keep: true, evict: false, signal })
  expect(await readFile(file)).toEqual(bytes)
  const ranges = behavior === 'wrong range' ? ['bytes=5-', undefined] : ['bytes=5-']
  expect(seen.filter(call => call.url === '/tos/clip').map(call => call.range)).toEqual(ranges)
  await expect(stat(file + '.part.json')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not confirm an upload cancelled while storage is returning its response', async () => {
  const putting = Promise.withResolvers<undefined>()
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/upload-url') {
      json(res, 200, { path: '/fw/media/uploads/new.png', token: 'test-token', upload_url: `http://${host}/tos/new` })
      return
    }
    putting.resolve(undefined)
  })
  const root = await folder()
  const file = join(root, 'new.png')
  await writeFile(file, 'image bytes')
  const controller = new AbortController()
  const stopped = new Error('User cancelled upload')
  const operation = media(host).upload(session, file, { signal: controller.signal })
  const rejected = expect(operation).rejects.toBe(stopped)
  try {
    await Promise.race([putting.promise, operation])
  } finally {
    controller.abort(stopped)
  }
  await rejected
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/upload-url', '/tos/new'])
  expect(seen.at(-1)).toMatchObject({ method: 'PUT', cookie: undefined })
})

it('rejects an upload if the file changes while the studio prepares its link', async () => {
  const root = await folder()
  const file = join(root, 'new.png')
  await writeFile(file, 'image')
  const { session, seen, host } = await studio(async (_req, _body, res) => {
    await writeFile(file, 'different image')
    json(res, 200, { path: '/fw/media/uploads/new.png', token: 'test-token', upload_url: `http://${host}/tos/new` })
  })
  await expect(media(host).upload(session, file, { signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_CHANGED' })
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/upload-url'])
})

it('keeps the studio HTTP error distinct from a disabled upload', async () => {
  const root = await folder()
  const file = join(root, 'new.png')
  await writeFile(file, 'image')
  const rejected = new WorkbenchHttpError(503, 'SERVICE_BUSY', 'Studio is temporarily busy')
  const session = localSession(vi.fn<WorkbenchSession['request']>().mockRejectedValue(rejected))
  await expect(media('storage.invalid').upload(session, file, { signal: new AbortController().signal })).rejects.toBe(rejected)
})

it('distinguishes an unavailable resolver from a studio version without the resolve route', async () => {
  const path = '/fw/media/generated/clip.mp4'
  const busy = new WorkbenchHttpError(503, 'SERVICE_BUSY', 'Studio is temporarily busy')
  const old = new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', 'Resolve is unavailable')
  const request = vi.fn<WorkbenchSession['request']>().mockRejectedValueOnce(busy).mockRejectedValueOnce(old)
  const { session, host } = await studio((_req, _body, res) => { res.writeHead(404); res.end() })
  const store = media(host)
  const scoped = { ...session, request }
  const signal = new AbortController().signal
  await expect(store.resolve(scoped, [path], signal)).rejects.toBe(busy)
  expect((await store.resolve(scoped, [path], signal)).get(path)).toEqual({ kind: 'host', path })
  expect((await store.resolve(scoped, [path], signal)).get(path)).toEqual({ kind: 'host', path })
  expect(request).toHaveBeenCalledTimes(2)
})

it.each([null, 'mailto:media@example.invalid'])('refuses a redirect with no permitted storage location (%s)', async (location) => {
  const path = '/fw/media/generated/clip.mp4'
  const { session, host, seen } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path, local: true }] })
      return
    }
    res.writeHead(307, location === null ? {} : { location })
    res.end()
  })
  await expect(media(host).open(session, path, new AbortController().signal))
    .rejects.toMatchObject({ code: 'JINGLIU_MEDIA_REDIRECT_REFUSED' })
  expect(seen).toHaveLength(2)
})

it.each(['http error', 'lost connection'] as const)('leaves an upload unconfirmed after storage reports %s', async (mode) => {
  const { session, seen, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/upload-url') {
      json(res, 200, { path: '/fw/media/uploads/new.png', token: 'test-token', upload_url: `http://${host}/tos/new` })
      return
    }
    if (mode === 'http error') { res.writeHead(503); res.end('busy'); return }
    res.destroy()
  })
  const root = await folder()
  const file = join(root, 'new.png')
  await writeFile(file, 'image')
  await expect(media(host).upload(session, file, { signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_FAILED' })
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/upload-url', '/tos/new'])
})

it.each([
  { name: 'an array of upload headers', headers: [{ header: 'value' }] },
  { name: 'a non-string upload header', headers: { 'x-meta-sequence': 1 } },
])('rejects $name before contacting storage', async ({ headers }) => {
  const { session, seen, host } = await studio((_req, _body, res) => {
    json(res, 200, { path: '/fw/media/uploads/new.png', token: 'test-token', headers,
      upload_url: `http://${host}/tos/new`,
    })
  })
  const root = await folder()
  const file = join(root, 'new.png')
  await writeFile(file, 'image')
  await expect(media(host).upload(session, file, { signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INVALID_RESULT' })
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/upload-url'])
})

it.each([
  { name: 'missing body', body: null, length: undefined, code: 'JINGLIU_MEDIA_UNAVAILABLE' },
  { name: 'stated size above the limit', body: 'clip', length: '17', code: 'JINGLIU_MEDIA_TOO_LARGE' },
  { name: 'short body', body: 'clip', length: '6', code: 'JINGLIU_MEDIA_INTEGRITY' },
  { name: 'body above the limit with no stated size', body: 'longer than the limit', length: undefined, code: 'JINGLIU_MEDIA_INTEGRITY' },
])('does not publish a Host download with $name', async ({ body, length, code }) => {
  const path = '/fw/media/generated/clip.mp4'
  const { session, host, check } = await studio((_req, _body, res) => { json(res, 200, { items: [{ path, local: true }] }) })
  const headers = length === undefined ? {} : { 'content-length': length }
  const fetch = vi.fn<WorkbenchSession['fetch']>().mockResolvedValue(new Response(body, { headers }))
  const root = await folder()
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  await expect(media(host, { maxBytes: 8 }).files({ ...session, fetch }, [path], root, options)).rejects.toMatchObject({ code })
  await expect(stat(join(root, 'generated', 'clip.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(check).toHaveBeenCalledTimes(1)
})

it('reports a filesystem readback failure when the expected cached file cannot be checked', async () => {
  const root = await folder()
  const path = '/fw/media/generated/clip.mp4'
  const files = { [path]: { size: 4, etag: 'current', type: 'video/mp4', used: 1, keep: true } }
  await writeFile(join(root, '.muse-media.json'), JSON.stringify({ version: 1, files }))
  const error = Object.assign(new Error('Media path cannot be checked'), { code: 'EACCES' })
  vi.mocked(stat).mockRejectedValueOnce(error)
  const { session, host, seen } = await studio((_req, _body, res) => { res.writeHead(404); res.end() })
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  await expect(media(host).files(session, [path], root, options)).rejects.toBe(error)
  expect(seen).toEqual([])
})

it.each(['malformed JSON', 'unknown schema'] as const)('rebuilds the cache after %s and keeps successful downloads', async (mode) => {
  const path = '/fw/media/generated/clip.mp4'
  const unavailable = '/fw/media/generated/unavailable.mp4'
  const bytes = Buffer.from('data')
  const { session, host, seen } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path, local: true }, { path: unavailable, error: 'not_found' }] })
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(bytes)
  })
  const root = await folder()
  const index = join(root, '.muse-media.json')
  await writeFile(index, mode === 'malformed JSON' ? '{' : JSON.stringify({ version: 0, files: [] }))
  const store = media(host)
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  await expect(store.files(session, [path, unavailable], root, options)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_NOT_FOUND' })
  expect(await readFile(join(root, 'generated', 'clip.mp4'))).toEqual(bytes)
  expect(JSON.parse(await readFile(index, 'utf8'))).toMatchObject({ version: 1, files: { [path]: { size: 4, keep: true } } })
  expect((await store.files(session, [path], root, options)).get(path)?.size).toBe(bytes.length)
  expect(seen).toHaveLength(2)
})

it('discards invalid and noncanonical cache records while preserving a verified file', async () => {
  const root = await folder()
  const path = '/fw/media/generated/clip.mp4'
  const index = join(root, '.muse-media.json')
  const cached = { size: 4, etag: 'current', type: 'video/mp4', used: 1, keep: false }
  await mkdir(join(root, 'generated'))
  await writeFile(join(root, 'generated', 'clip.mp4'), 'clip')
  await writeFile(index, JSON.stringify({ version: 1, files: { [path]: cached, '/fwp/media/generated/another.mp4': cached,
    '/fw/media/new-category/clip.mp4': cached, '/fw/media/generated/incomplete.mp4': { size: '4' },
  } }))
  const { session, host, seen } = await studio((_req, _body, res) => { res.writeHead(404); res.end() })
  const store = media(host, { cacheBytes: 100 })
  const result = await store.files(session, [path], root, { keep: false, evict: true, signal: new AbortController().signal })
  expect(result.get(path)).toMatchObject({ size: 4 })
  expect(seen).toEqual([])
  const saved = JSON.parse(await readFile(index, 'utf8')) as { files: Record<string, unknown> }
  expect(Object.keys(saved.files)).toEqual([path])
})

it('copies a verified file when hard links are unavailable and preserves an existing destination', async () => {
  const root = await folder()
  const source = join(root, 'clip.mp4')
  const target = join(root, 'copy.mp4')
  await writeFile(source, 'clip')
  const local = { file: source, path: '/fw/media/generated/clip.mp4', size: 4, contentType: 'video/mp4' }
  const store = media('storage.invalid')
  vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('Different volume'), { code: 'EXDEV' }))
  await store.place(local, target)
  expect(await readFile(target, 'utf8')).toBe('clip')
  await expect(store.place(local, target)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(target, 'utf8')).toBe('clip')
  await expect(store.place({ ...local, size: 1 }, join(root, 'damaged.mp4'))).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INTEGRITY' })
})

it('preserves earlier resolutions when a later batch needs the Host fallback', async () => {
  const many = Array.from({ length: 201 }, (_, index) => `/fw/media/generated/${String(index)}.png`)
  const first = many.slice(0, 200).map(path => ({ path, error: 'not_in_tos' }))
  const notSupported = new WorkbenchHttpError(405, 'METHOD_NOT_ALLOWED', 'Resolve is unavailable')
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValueOnce(false)
    .mockResolvedValueOnce({ items: first }).mockRejectedValueOnce(notSupported)
  const session = localSession(request)
  const store = media('storage.invalid')
  const signal = new AbortController().signal
  await expect(store.resolve(session, many, signal)).rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INVALID_RESULT' })
  const result = await store.resolve(session, many, signal)
  expect([...result.keys()]).toEqual(many)
  expect([...result.values()].every(item => item.kind === 'host')).toBe(true)
  expect(request).toHaveBeenCalledTimes(3)
})

it('retains generic content type for an unrecognized media extension', async () => {
  const path = '/fw/media/exports/data.bin'
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValue({ items: [{ path, local: true }] })
  const fetch = vi.fn<WorkbenchSession['fetch']>().mockResolvedValue(new Response('data', { headers: { 'content-type': 'application/octet-stream' } }))
  const response = await media('storage.invalid').open(localSession(request, fetch), path, new AbortController().signal)
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(await response.text()).toBe('data')
})

it('shares one in-flight download for two local readers of the same file', async () => {
  const root = await folder()
  const path = '/fw/media/generated/clip.mp4'
  const response = { items: [{ path, local: true }] }
  const opened = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const secondResolved = Promise.withResolvers<undefined>()
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValueOnce(response).mockImplementationOnce(async () => {
    secondResolved.resolve(undefined)
    return response
  })
  const fetch = vi.fn<WorkbenchSession['fetch']>(async () => {
    opened.resolve(undefined)
    await released.promise
    return new Response('clip', { headers: { 'content-type': 'video/mp4' } })
  })
  const session = localSession(request, fetch)
  const store = media('storage.invalid')
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  const first = store.files(session, [path], root, options)
  let second: typeof first
  try {
    await Promise.race([opened.promise, first])
    second = store.files(session, [path], root, options)
    await Promise.race([secondResolved.promise, second])
    await nextTurn()
  } finally {
    released.resolve(undefined)
  }
  const [left, right] = await Promise.all([first, second])
  expect(left.get(path)).toEqual(right.get(path))
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('moves past a cancelled queue entry to download the next file', async () => {
  const root = await folder()
  const activePath = '/fw/media/generated/active.mp4'
  const stoppedPath = '/fw/media/generated/stopped.mp4'
  const nextPath = '/fw/media/generated/next.mp4'
  const active = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const stoppedResolved = Promise.withResolvers<undefined>()
  const nextResolved = Promise.withResolvers<undefined>()
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValueOnce({ items: [{ path: activePath, local: true }] })
    .mockImplementationOnce(async () => {
      stoppedResolved.resolve(undefined)
      return { items: [{ path: stoppedPath, local: true }] }
    }).mockImplementationOnce(async () => {
      nextResolved.resolve(undefined)
      return { items: [{ path: nextPath, local: true }] }
    })
  const fetch = vi.fn<WorkbenchSession['fetch']>(async (url) => {
    if (url.pathname.endsWith('active.mp4')) {
      active.resolve(undefined)
      await released.promise
    }
    return new Response('clip', { headers: { 'content-type': 'video/mp4' } })
  })
  const session = localSession(request, fetch)
  const store = media('storage.invalid', { downloads: 1 })
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  const controller = new AbortController()
  const reason = new Error('Queued transfer cancelled')
  const first = store.files(session, [activePath], root, options)
  let stoppedResult: Promise<unknown>
  let next: typeof first
  try {
    await Promise.race([active.promise, first])
    const stopped = store.files(session, [stoppedPath], root, { ...options, signal: controller.signal })
    stoppedResult = expect(stopped).rejects.toBe(reason)
    await Promise.race([stoppedResolved.promise, stopped])
    next = store.files(session, [nextPath], root, options)
    await Promise.race([nextResolved.promise, next])
    await nextTurn()
    controller.abort(reason)
  } finally {
    released.resolve(undefined)
  }
  await Promise.all([first, next, stoppedResult])
  expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(['/fwp/media/generated/active.mp4', '/fwp/media/generated/next.mp4'])
})

it('returns the filesystem error when a cache index cannot be read', async () => {
  const root = await folder()
  await mkdir(join(root, '.muse-media.json'))
  const request = vi.fn<WorkbenchSession['request']>()
  const signal = new AbortController().signal
  await expect(media('storage.invalid').files(localSession(request), ['/fw/media/generated/clip.mp4'], root, { keep: false, evict: true, signal }))
    .rejects.toMatchObject({ code: 'EISDIR' })
  expect(request).not.toHaveBeenCalled()
})

it('reports a short object response as damaged without publishing it', async () => {
  const path = '/fw/media/generated/clip.mp4'
  const { session, host } = await studio((req, _body, res) => {
    if (req.url === '/fwp/v2/media/resolve') {
      json(res, 200, { items: [{ path, url: `http://${host}/tos/clip`, size: 6, etag: 'revision' }] })
      return
    }
    res.writeHead(200); res.end('clip')
  })
  const root = await folder()
  const directory = join(root, 'generated')
  await mkdir(directory)
  await writeFile(join(directory, 'clip.mp4.part.json'), '{')
  await expect(media(host).files(session, [path], root, { keep: false, evict: true, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: 'JINGLIU_MEDIA_INTEGRITY' })
  await expect(stat(join(directory, 'clip.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a read error from the partial-object receipt before requesting the object', async () => {
  const path = '/fw/media/generated/clip.mp4'
  const { session, host, seen } = await studio((_req, _body, res) => {
    json(res, 200, { items: [{ path, url: `http://${host}/tos/clip`, size: 4, etag: 'revision' }] })
  })
  const root = await folder()
  await mkdir(join(root, 'generated', 'clip.mp4.part.json'), { recursive: true })
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  await expect(media(host).files(session, [path], root, options)).rejects.toMatchObject({ code: 'EISDIR' })
  expect(seen.map(call => call.url)).toEqual(['/fwp/v2/media/resolve'])
})

it('reports a Host body interruption without publishing a file or cache entry', async () => {
  const root = await folder()
  const path = '/fw/media/generated/clip.mp4'
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValue({ items: [{ path, local: true }] })
  const interruption = new TypeError('Media body interrupted')
  const body = new ReadableStream({ start(controller) { controller.error(interruption) } })
  const fetch = vi.fn<WorkbenchSession['fetch']>().mockResolvedValue(new Response(body))
  const store = media('storage.invalid')
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  await expect(store.files(localSession(request, fetch), [path], root, options))
    .rejects.toMatchObject({ code: 'JINGLIU_MEDIA_UNAVAILABLE', cause: interruption })
  await expect(stat(join(root, 'generated', 'clip.mp4'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(root, '.muse-media.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves a cache record untouched while its replacement download is active', async () => {
  const root = await folder()
  const fresh = '/fw/media/generated/fresh.mp4'
  const viewed = '/fw/media/generated/viewed.mp4'
  const index = join(root, '.muse-media.json')
  const cached = { size: 4, etag: 'previous', type: 'video/mp4', used: 1, keep: false }
  await mkdir(join(root, 'generated'))
  await writeFile(join(root, 'generated', 'fresh.mp4'), 'old bytes')
  await writeFile(join(root, 'generated', 'viewed.mp4'), 'view')
  await writeFile(index, JSON.stringify({ version: 1, files: { [fresh]: cached, [viewed]: { ...cached, used: 2 } } }))
  const request = vi.fn<WorkbenchSession['request']>().mockResolvedValueOnce({ items: [{ path: fresh, local: true }] })
  const opened = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  const fetch = vi.fn<WorkbenchSession['fetch']>(async () => {
    opened.resolve(undefined)
    await released.promise
    return new Response('clip', { headers: { 'content-type': 'video/mp4' } })
  })
  const session = localSession(request, fetch)
  const store = media('storage.invalid', { cacheBytes: 0 })
  const options = { keep: false, evict: false, signal: new AbortController().signal }
  const replacing = store.files(session, [fresh], root, options)
  try {
    await Promise.race([opened.promise, replacing])
    await store.files(session, [viewed], root, { ...options, evict: true })
    expect(await readFile(join(root, 'generated', 'fresh.mp4'), 'utf8')).toBe('old bytes')
    expect(JSON.parse(await readFile(index, 'utf8'))).toMatchObject({ files: { [fresh]: cached } })
  } finally {
    released.resolve(undefined)
    await replacing
  }
  expect(await readFile(join(root, 'generated', 'fresh.mp4'), 'utf8')).toBe('clip')
  expect(request).toHaveBeenCalledTimes(1)
})

it('does not recreate a cache record removed before a verified read is indexed', async () => {
  const root = await folder()
  const path = '/fw/media/generated/clip.mp4'
  const index = join(root, '.muse-media.json')
  const file = join(root, 'generated', 'clip.mp4')
  const cached = { size: 4, etag: 'saved', type: 'video/mp4', used: 1, keep: false }
  await mkdir(join(root, 'generated'))
  await writeFile(file, 'clip')
  await writeFile(index, JSON.stringify({ version: 1, files: { [path]: cached } }))
  const verified = await stat(file)
  vi.mocked(stat).mockImplementationOnce(async () => {
    await writeFile(index, JSON.stringify({ version: 1, files: {} }))
    return verified
  })
  const request = vi.fn<WorkbenchSession['request']>()
  const store = media('storage.invalid')
  const options = { keep: true, evict: false, signal: new AbortController().signal }
  const result = await store.files(localSession(request), [path], root, options)
  expect(result.get(path)?.file).toBe(file)
  expect(JSON.parse(await readFile(index, 'utf8'))).toEqual({ version: 1, files: {} })
  expect(request).not.toHaveBeenCalled()
})
