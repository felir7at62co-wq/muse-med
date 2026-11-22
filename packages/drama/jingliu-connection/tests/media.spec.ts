import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestJson } from '@deepseek-ai/dsh-workbench-connection'
import type { WorkbenchSession } from '@deepseek-ai/dsh-workbench-connection'
import { expect, it, onTestFinished, vi } from 'vitest'
import { JINGLIU } from '../src/http.ts'
import { JingliuMedia, mediaPath, projectMediaFolder, type MediaConfig } from '../src/media.ts'

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
  await expect(store.upload(session, file, { signal })).rejects.toMatchObject({ code: 'JINGLIU_UPLOAD_UNCONFIRMED' })
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
