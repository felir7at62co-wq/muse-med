import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { cutProjectDetail, cutMediaUrl } from '../src/cut-import-source.ts'
import { fetchCutVideo, registerCutImport } from '../src/cut-import-host.ts'

afterEach(() => vi.unstubAllGlobals())
const studio = 'https://studio.example'
const project = { id: 'p', title: 'Story', base_aspect: '9:16', shots: [
  { episode: 1, order: 3, duration_sec: 6, clip_in_sec: 1, clip_dur_sec: 2, transform_meta: { speed: 2 },
    video_url: '/fw/media/generated/ready.mp4', track_index: 1, overlay_start_sec: 4 },
  { episode: 1, order: 1, duration_sec: 8, video_url: '/fwp/media/generated/first.mp4' },
  { episode: 1, order: 2, disabled: true, duration_sec: 3, video_url: '/fw/media/generated/old.mp4' },
  { episode: 1, order: 4, duration_sec: 8 }, { episode: 2, order: 5, duration_sec: 5 },
] }

it('imports the ordered adopted windows, counts missing media and excludes disabled shots', () => {
  const source = cutProjectDetail(project, 'p', studio)
  expect(source.episodes).toEqual([{ order: 1, ready: 2, total: 3 }, { order: 2, ready: 0, total: 1 }])
  const chosen = source.select(1)
  expect(chosen.map(s => s.edit.order)).toEqual([1, 3])
  expect(chosen[1]?.edit).toEqual({ order: 3, inSec: 1, durationSec: 2, speed: 2, track: 1, overlayStart: 4 })
  expect(chosen[1]?.url.href).toBe('https://studio.example/fwp/media/generated/ready.mp4')
  expect(() => source.select(2)).toThrow()
  expect(() => cutProjectDetail(project, 'other', studio)).toThrow()
})

it.each(['/fw/media/../private/target.mp4', '//elsewhere.example/fwp/media/v.mp4', '/fw/media/%252e%252e/file.mp4',
  '/fw/media/url.mp4?path=elsewhere', 'https://account@studio.example/fw/media/a.mp4', '/fw/media/a.svg'])('rejects unrelated media %s', (value) => {
  expect(cutMediaUrl(studio, value)).toBeUndefined()
})

it('follows the studio media redirect only to a signed public TOS object without credentials', async () => {
  const origin = new URL(studio + '/fwp/media/generated/video.mp4')
  const request = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', request)
  request.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'http://127.0.0.1/private' } }))
  await expect(fetchCutVideo(origin, new AbortController().signal)).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
  request.mockResolvedValueOnce(new Response(null, { status: 307, headers: {
    location: 'https://bucket.tos-cn-shanghai.volces.com/obj.mp4?X-Tos-Signature=example' } }))
  request.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } }))
  const media = await fetchCutVideo(origin, new AbortController().signal)
  const chunks: Uint8Array[] = []
  for await (const chunk of media.chunks) chunks.push(chunk)
  expect(Array.from(Buffer.concat(chunks))).toEqual([1, 2, 3])
  expect(request.mock.calls[2]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
  expect(request.mock.calls[2]?.[1]?.headers).toBeUndefined()
})

it('requires Muse HTTP trust, visible project ownership and the selecting account for media tickets', async () => {
  const ctx = new Context()
  let route: WebRoute | undefined
  let identity = 'account-a'
  let detailReads = 0
  const routes = createServer((req, res) => { if (route) void route.handler(req, res); else res.end() })
  await new Promise<void>(resolve => routes.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    routes.closeAllConnections()
    await new Promise<void>(resolve => routes.close(() => resolve()))
    await ctx.fiber.dispose()
  })
  const root = 'http://127.0.0.1:' + String((routes.address() as AddressInfo).port)
  class Web extends Service {
    constructor(ctx: Context) { super(ctx, 'webServer') }
    register(r: WebRoute) { route = r; return () => { route = undefined } }
  }
  class Trust extends Service {
    constructor(ctx: Context) { super(ctx, 'connection') }
    requestRejection(req: { headers: { cookie?: string } }) { return req.headers.cookie === 'owner=true' ? undefined : 401 }
  }
  class Account extends Service {
    constructor(ctx: Context) { super(ctx, 'jingliuConnection') }
    async connection() {
      return { identity, request: async (path: string) => {
        if (path === '/projects?trash=false') return { projects: [project] }
        detailReads++
        return project
      } }
    }
  }
  await ctx.plugin(Web).await()
  await ctx.plugin(Trust).await()
  await ctx.plugin(Account).await()
  registerCutImport(ctx, studio)
  await vi.waitFor(() => expect(route).toBeDefined())
  const query = (path: string, auth = true) => fetch(root + '/api/jingliu/cut-import' + path, { headers: auth ? { cookie: 'owner=true' } : {} })
  expect((await query('/projects', false)).status).toBe(401)
  expect(await (await query('/projects')).json()).toEqual([{ id: 'p', title: 'Story' }])
  expect((await query('/projects/other/episodes')).status).toBe(404)
  expect(detailReads).toBe(0)
  const selection = await (await query('/projects/p/episodes/1')).json() as { ticket: string }
  expect(selection.ticket).toMatch(/^[\da-f-]{36}$/u)
  identity = 'account-b'
  const media = '/media/' + selection.ticket + '/0'
  expect((await query(media)).status).toBe(404)
  identity = 'account-a'
  ctx.emit('muse-account/session-changed')
  expect((await query(media)).status).toBe(404)
})
