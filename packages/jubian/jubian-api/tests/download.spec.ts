import { describe, expect, it, vi } from 'vitest'
import { MEDIA_ALLOWED_ORIGINS, downloadMedia } from '../src/download.ts'
import { JubianError } from '@deepseek-ai/dsh-jubian'

const CDN = MEDIA_ALLOWED_ORIGINS[0]

/** A 1x1 PNG, enough for the header check. */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))

/** A minimal but well-formed MP4 header. */
function mp4(): Uint8Array {
  const bytes = new Uint8Array(24)
  const view = Buffer.from(bytes.buffer)
  view.writeUInt32BE(24, 0)
  view.write('ftypisom', 4, 'ascii')
  return bytes
}

/**
 * A transport answering every request with `body`, copied into the `ArrayBuffer`-backed
 * bytes a `Response` body accepts.
 */
function transport(body: Uint8Array, init: { status?: number; seen?: RequestInit[] } = {}): typeof fetch {
  return async (_url: string | URL | Request, request?: RequestInit) => {
    init.seen?.push(request ?? {})
    return new Response(body.slice(), { status: init.status ?? 200 })
  }
}

describe('downloadMedia', () => {
  it('downloads from an allowed origin without any credential', async () => {
    const seen: RequestInit[] = []
    const result = await downloadMedia(`${CDN}/a/b.png`, { kind: 'image', fetch: transport(PNG, { seen }) })
    expect(result.kind).toBe('image')
    expect(result.media_type).toBe('image/png')
    expect(result.sha256).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(seen[0]!.credentials).toBe('omit')
    expect(seen[0]!.redirect).toBe('error')
    expect(seen[0]!.headers).toBeUndefined()
  })

  it('refuses an origin outside the allowlist', async () => {
    await expect(downloadMedia('https://evil.example/a.png', { kind: 'image', fetch: transport(PNG) })).rejects.toThrow()
    await expect(downloadMedia('http://jubian-aigc.tos-cn-beijing.volces.com/a.png',
      { kind: 'image', fetch: transport(PNG) })).rejects.toThrow()
  })

  it('refuses a payload whose header contradicts the requested kind', async () => {
    await expect(downloadMedia(`${CDN}/v.mp4`, { kind: 'video', fetch: transport(PNG) })).rejects.toThrow()
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(mp4()) })).rejects.toThrow()
  })

  it('accepts a well-formed MP4 as video and an unknown header as nothing at all', async () => {
    const result = await downloadMedia(`${CDN}/v.mp4`, { kind: 'video', fetch: transport(mp4()) })
    expect(result.media_type).toBe('video/mp4')
    await expect(downloadMedia(`${CDN}/x.bin`, { kind: 'image',
      fetch: transport(Uint8Array.from([1, 2, 3, 4])) })).rejects.toThrow()
  })

  it('accepts a bounded QuickTime ftyp video but still rejects a mismatched kind', async () => {
    const qt = mp4()
    Buffer.from(qt.buffer).write('qt  ', 8, 'ascii')
    const result = await downloadMedia(`${CDN}/v.mp4`, { kind: 'video', fetch: transport(qt) })
    expect(result).toMatchObject({ kind: 'video', media_type: 'video/mp4' })
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(qt) })).rejects.toThrow()
  })

  it('bounds the payload by the ceiling for its kind', async () => {
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(PNG), maxBytes: 8 }))
      .rejects.toThrow()
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(PNG), maxBytes: 999_999_999 }))
      .rejects.toThrow()
  })

  it('reports a transport failure as a network error', async () => {
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image',
      fetch: transport(PNG, { status: 500 }) })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const failing = (async () => { throw new Error('socket hang up') }) as typeof fetch
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: failing }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it.each(['https://', `${CDN}/a.png#fragment`, `https://user:password@${new URL(CDN).host}/a.png`,
    `${CDN}/a b.png`, `${CDN}/\ud800.png`, `${CDN}/${'a'.repeat(16385)}`])
  ('rejects an unsafe media URL before contacting its transport: %j', async (source) => {
    let requests = 0
    await expect(downloadMedia(source, { kind: 'image', fetch: async () => {
      requests++; return new Response(PNG.slice())
    } })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(requests).toBe(0)
  })

  it('recognizes JPEG and WebP bytes without trusting the filename', async () => {
    for (const [bytes, media_type] of [
      [Uint8Array.from([0xff, 0xd8, 0xff, 0]), 'image/jpeg'],
      [Uint8Array.from(Buffer.from('RIFF0000WEBP')), 'image/webp'],
    ] as const) {
      expect(await downloadMedia(`${CDN}/file.bin`, { kind: 'image', fetch: transport(bytes) }))
        .toMatchObject({ kind: 'image', media_type, bytes })
    }
  })

  it('rejects an unbounded or invalid MP4 file-type box', async () => {
    for (const size of [15, 25]) {
      const bytes = mp4(); Buffer.from(bytes.buffer).writeUInt32BE(size, 0)
      await expect(downloadMedia(`${CDN}/file.mp4`, { kind: 'video', fetch: transport(bytes) }))
        .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    }
    const unknown = mp4(); Buffer.from(unknown.buffer).write('xxxx', 8)
    await expect(downloadMedia(`${CDN}/file.mp4`, { kind: 'video', fetch: transport(unknown) }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it.each([{ timeoutMs: 0 }, { timeoutMs: 300001 }, { allowedOrigins: [] }, { maxBytes: 0 }])
  ('rejects invalid explicit download limits before fetching: %j', async (limits) => {
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', ...limits, fetch: transport(PNG) }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('requires a readable response body and releases its reader after a stream failure', async () => {
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', fetch: async () => new Response(null) }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('truncated stream')) } })
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', fetch: async () => new Response(body) }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
    expect(body.locked).toBe(false)
  })

  it('retains a transport-owned typed stream failure and contains HTTP-body cancellation errors', async () => {
    const failure = new JubianError('NETWORK_ERROR')
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(failure) } })
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', fetch: async () => new Response(body) }))
      .rejects.toBe(failure)
    let cancelled = false
    const rejected = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; throw new Error('cancel failed') } })
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', fetch: async () => new Response(rejected, { status: 500 }) }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    expect(cancelled).toBe(true)
  })

  it('passes caller cancellation to the credential-free media transport', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(downloadMedia(`${CDN}/file.png`, { kind: 'image', signal: controller.signal,
      fetch: async (_url, init) => { expect(init?.signal?.aborted).toBe(true); throw controller.signal.reason } }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('uses the native fetch entry when the deployment supplies no transport override', async () => {
    const native = vi.spyOn(globalThis, 'fetch').mockImplementation(transport(PNG))
    try {
      expect(await downloadMedia(`${CDN}/default-transport.png`, { kind: 'image' }))
        .toMatchObject({ media_type: 'image/png', bytes: PNG })
      expect(native).toHaveBeenCalledOnce()
    } finally { native.mockRestore() }
  })
})


it('downloads the observed Jubian media host without accepting lookalike hosts', async () => {
  expect((await downloadMedia('https://101.aigc.jubianai.net/a.mp4', {
    kind: 'video', fetch: transport(mp4()),
  })).kind).toBe('video')
  await expect(downloadMedia('https://101.aigc.jubianai.net.evil.example/a.mp4', {
    kind: 'video', fetch: transport(mp4()),
  })).rejects.toThrow()
})
