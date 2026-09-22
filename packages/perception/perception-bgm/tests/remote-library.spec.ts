/** Public catalogue and selected-track transfer with an offline HTTP fixture. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/index.ts'
import { EmotionWorker } from '../src/worker.ts'
import { resolveCatalogConfig } from '../src/config.ts'

const catalogUrl = 'https://muse.tos-cn-beijing.volces.com/bgm/catalog.json'
const audio = Buffer.from('fixture audio bytes')
const hex = createHash('sha256').update(audio).digest('hex')
const track = { id: `sha256:${hex}`, name: '明亮.mp3', sha256: `sha256:${hex}`, bytes: audio.length,
  url: `https://muse.tos-cn-beijing.volces.com/bgm/tracks/${hex}.mp3`,
  valence: 8, arousal: 7, moods: ['happy'] }
const catalog = { version: 1, tracks: [track] }
const disposers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(import.meta.dirname, 'remote-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const cacheDir = join(root, 'cache')
  const ctx = new Context()
  disposers.push(() => ctx.fiber.dispose())
  let definition: { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> } | undefined
  ctx.provide('tools', { register(value: typeof definition) { definition = value; return () => {} } })
  await ctx.plugin({ apply, inject, name: 'perception-bgm' }, {
    catalogUrl, cacheDir, pythonExecutable: join(root, 'missing-python'),
    indexPath: join(root, 'no-local-index'), ...config,
  })
  if (!definition) throw new Error('Missing bgm_match')
  const tool = definition
  return { root, cacheDir, dispose: () => ctx.fiber.dispose(),
    run: (args: Record<string, unknown>, signal = new AbortController().signal) => tool.execute(args, { signal }) }
}

function transport(document: unknown = catalog, payload: Uint8Array = audio) {
  const fetch = vi.fn(async (input: string | URL, options?: RequestInit) => {
    expect(options?.credentials).toBe('omit')
    expect(options?.redirect).toBe('error')
    expect(options?.headers).toBeUndefined()
    return String(input) === catalogUrl
      ? new Response(JSON.stringify(document))
      : new Response(payload as Uint8Array<ArrayBuffer>, { headers: { 'content-length': String(payload.length) } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('matches public measurements without Python or downloading candidates', async () => {
  const fetch = transport()
  const start = vi.spyOn(EmotionWorker.prototype, 'start').mockRejectedValue(new Error('No Python'))
  const { run, cacheDir } = await mount()
  expect(await run({ method: 'match', valence: 8, arousal: 7, limit: 1 })).toEqual({
    target: { valence: 8, arousal: 7 }, evaluated_tracks: 1,
    candidates: [{ track_id: track.id, name: track.name, url: track.url,
      valence: 8, arousal: 7, moods: ['happy'], distance: 0 }],
    note: 'candidates are ranked by measured distance; choose one yourself.',
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(start).not.toHaveBeenCalled()
  await expect(readdir(cacheDir)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('downloads only the chosen ID, verifies bytes, and revalidates cached reuse', async () => {
  const fetch = transport()
  const { run, cacheDir } = await mount()
  const result = await run({ method: 'download', track_id: track.id }) as { path: string; cached: boolean }
  expect(result.path).toBe(join(cacheDir, `${hex}.mp3`))
  expect(result.cached).toBe(false)
  expect(await readFile(result.path)).toEqual(audio)
  expect(await run({ method: 'download', track_id: track.id })).toMatchObject({ path: result.path, cached: true })
  expect(fetch.mock.calls.filter(([url]) => String(url) === track.url)).toHaveLength(1)
  await writeFile(result.path, Buffer.alloc(audio.length, 0))
  expect(await run({ method: 'download', track_id: track.id })).toMatchObject({ cached: false })
  expect(await readFile(result.path)).toEqual(audio)
  expect(await readdir(cacheDir)).toEqual([`${hex}.mp3`])
})

it.each([
  ['cross-origin', { ...track, url: track.url.replace('muse.', 'other.') }],
  ['HTTP', { ...track, url: track.url.replace('https:', 'http:') }],
  ['credentials', { ...track, url: track.url.replace('https://', 'https://user:pass@') }],
  ['query', { ...track, url: track.url + '?token=secret' }],
  ['wrong object key', { ...track, url: track.url.replace('/tracks/', '/other/') }],
  ['wrong content ID', { ...track, id: 'sha256:' + '0'.repeat(64) }],
  ['unsafe filename', { ...track, name: '../track.mp3' }],
  ['negative size', { ...track, bytes: -1 }],
  ['fractional size', { ...track, bytes: 1.5 }],
  ['unbounded size', { ...track, bytes: Number.MAX_SAFE_INTEGER }],
  ['invalid score', { ...track, valence: 10 }],
  ['invalid tags', { ...track, moods: [4] }],
])('rejects %s catalogue data before audio fetch', async (_label, invalid) => {
  const fetch = transport({ version: 1, tracks: [invalid] })
  const { run, cacheDir } = await mount()
  await expect(run({ method: 'download', track_id: track.id })).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
  await expect(readdir(cacheDir)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  { version: 2, tracks: [track] }, { version: 1, tracks: [track, track] },
  { version: 1, tracks: null },
])('rejects invalid catalogue version/list/duplicate IDs', async (document) => {
  const fetch = transport(document)
  const { run } = await mount()
  await expect(run({ method: 'match', valence: 5, arousal: 5 })).rejects.toThrow(/catalog/i)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each(['wrong hash', 'too short', 'too long'])('cleans staged files on %s', async (failure) => {
  const payload = failure === 'wrong hash' ? Buffer.alloc(audio.length, 0)
    : failure === 'too short' ? audio.subarray(1) : Buffer.concat([audio, audio])
  const fetch = transport()
  fetch.mockImplementation(async input => String(input) === catalogUrl
    ? new Response(JSON.stringify(catalog)) : new Response(payload))
  const { run, cacheDir } = await mount()
  await expect(run({ method: 'download', track_id: track.id })).rejects.toThrow()
  expect(await readdir(cacheDir)).toEqual([])
})

it('rejects an unknown ID without requesting an audio object', async () => {
  const fetch = transport()
  const { run } = await mount()
  await expect(run({ method: 'download', track_id: 'sha256:' + '0'.repeat(64) })).rejects.toThrow(/track/i)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('bounds catalogue bytes and refuses redirects or HTTP errors', async () => {
  const fetch = transport()
  const { run } = await mount({ maxCatalogBytes: 32 })
  await expect(run({ method: 'match', valence: 5, arousal: 5 })).rejects.toThrow(/size|bytes|limit/i)
  for (const status of [302, 404, 206]) {
    fetch.mockResolvedValue(new Response('bad', { status }))
    await expect(run({ method: 'match', valence: 5, arousal: 5 })).rejects.toThrow()
  }
})

it.each([0, 10])('rejects out-of-scale matching targets (%s)', async (valence) => {
  const fetch = transport()
  const { run } = await mount()
  await expect(run({ method: 'match', valence, arousal: 5 })).rejects.toThrow(/1–9/)
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  { catalogUrl: 'http://example.com/bgm/index.json' },
  { catalogUrl: 'https://user:pass@example.com/bgm/index.json' },
  { catalogUrl: 'https://example.com/bgm/index.json?token=secret' },
  { catalogUrl: 'https://example.com/bgm/index.json#fragment' },
  { catalogUrl: ' https://example.com/bgm/index.json' },
  { catalogUrl, cacheDir: 'relative-cache' },
  { catalogUrl, networkTimeoutMs: 0 }, { catalogUrl, maxCatalogBytes: 0 },
  { catalogUrl, maxTrackBytes: -1 }, { catalogUrl, networkTimeoutMs: 2147483648 },
])('fails early for invalid remote configuration', (config) => {
  expect(() => resolveCatalogConfig(config)).toThrow()
})

it('does not publish a file when the audio body fails mid-stream', async () => {
  const fetch = transport()
  fetch.mockImplementation(async (input) => {
    if (String(input) === catalogUrl) return new Response(JSON.stringify(catalog))
    let sent = false
    return new Response(new ReadableStream({ pull(controller) {
      if (sent) controller.error(new Error('interrupted'))
      else { sent = true; controller.enqueue(audio.subarray(0, 3)) }
    } }))
  })
  const { run, cacheDir } = await mount()
  await expect(run({ method: 'download', track_id: track.id })).rejects.toThrow(/interrupted/)
  expect(await readdir(cacheDir)).toEqual([])
})

it('rejects oversized response headers and removes corrupt cache on failed replacement', async () => {
  const fetch = transport()
  const { run, cacheDir } = await mount()
  const result = await run({ method: 'download', track_id: track.id }) as { path: string }
  await writeFile(result.path, 'bad')
  fetch.mockImplementation(async input => String(input) === catalogUrl
    ? new Response(JSON.stringify(catalog))
    : new Response(audio, { headers: { 'content-length': String(audio.length + 1) } }))
  await expect(run({ method: 'download', track_id: track.id })).rejects.toThrow(/byte limit/)
  expect(await readdir(cacheDir)).toEqual([])
})

it('uses independent temporary files for concurrent downloads of one track', async () => {
  const fetch = transport()
  let arrivals = 0
  const ready = Promise.withResolvers<undefined>()
  fetch.mockImplementation(async (input) => {
    if (String(input) === catalogUrl) return new Response(JSON.stringify(catalog))
    if (++arrivals === 2) ready.resolve(undefined)
    await ready.promise
    return new Response(audio)
  })
  const { run, cacheDir } = await mount()
  const results = await Promise.all([
    run({ method: 'download', track_id: track.id }), run({ method: 'download', track_id: track.id }),
  ])
  expect(results).toHaveLength(2)
  expect(await readFile(join(cacheDir, `${hex}.mp3`))).toEqual(audio)
  expect(await readdir(cacheDir)).toEqual([`${hex}.mp3`])
})

it.each(['caller', 'unload'])('aborts a pending request on %s cancellation', async (mode) => {
  const pending = Promise.withResolvers<undefined>()
  const fetch = vi.fn((_input: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    pending.resolve(undefined)
    options.signal?.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
  }))
  vi.stubGlobal('fetch', fetch)
  const { run, dispose } = await mount()
  const controller = new AbortController()
  const result = run({ method: 'match', valence: 5, arousal: 5 }, controller.signal)
  const failure = expect(result).rejects.toThrow(/aborted/)
  await pending.promise
  if (mode === 'caller') controller.abort()
  else await dispose()
  await failure
})
