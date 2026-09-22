import { describe, expect, it } from 'vitest'
import { MEDIA_ALLOWED_ORIGINS, downloadMedia } from '../src/download.ts'

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

  it('bounds the payload by the ceiling for its kind', async () => {
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(PNG), maxBytes: 8 }))
      .rejects.toThrow()
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: transport(PNG), maxBytes: 999_999_999 }))
      .rejects.toThrow()
  })

  it('reports a transport failure as a network error', async () => {
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image',
      fetch: transport(PNG, { status: 500 }) })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    const failing = (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    await expect(downloadMedia(`${CDN}/a.png`, { kind: 'image', fetch: failing }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })
})
