import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { uploadReferenceMethod } from '../src/reference.ts'

const FRONTEND_HTML = '<html><script src="/static/js/app.abc123.js"></script></html>'
const APP_JS = 'var modules={{"6c3d":function(e,t,n){var o=(t.default,"AKIDEXAMPLE");'
  + 'var s="SECRETEXAMPLE";var r="cn-beijing";var u="jubian-aigc";'
  + 'var l="tos-cn-beijing.volces.com";return 1}},"6ea0":function(){return 1}}'

/** The ASCII bytes of a short tag, for building a container header in a fixture. */
function tag(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0))
}

/** A PNG header only: the reader is a header reader, so it needs no pixel data. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  const view = new DataView(bytes.buffer)
  view.setUint32(8, 13)
  bytes.set(tag('IHDR'), 12)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array
}

/** One stubbed request, in the shape this transport is actually called with. */
interface StubRequest {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

/** A transport that serves the workbench bundle and records the object PUT. */
function transport(options: { status?: number; failBundle?: boolean } = {}): {
  fetch: typeof fetch
  uploads: Recorded[]
  bundleLoads: number
} {
  const uploads: Recorded[] = []
  const state = { bundleLoads: 0 }
  const stub = async (url: string | URL, init?: StubRequest): Promise<Response> => {
    const target = url.toString()
    if (target === 'https://web.jubianai.net/') {
      state.bundleLoads += 1
      if (options.failBundle === true) return new Response('missing', { status: 500 })
      return new Response(FRONTEND_HTML, { status: 200 })
    }
    if (target.endsWith('/static/js/app.abc123.js')) {
      state.bundleLoads += 1
      return new Response(APP_JS, { status: 200 })
    }
    const body = init?.body
    uploads.push({ url: target, method: init?.method ?? 'GET', headers: { ...init?.headers },
      body: body instanceof Uint8Array ? body : new Uint8Array() })
    return new Response(null, { status: options.status ?? 200 })
  }
  return { fetch: stub as unknown as typeof fetch, uploads, get bundleLoads() { return state.bundleLoads } }
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'jubian-reference-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function file(name: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

describe('upload_reference', () => {
  it('uploads an already aligned image byte for byte and returns the material item', async () => {
    const png = pngHeader(1680, 944)
    const path = await file('aligned.png', png)
    const stub = transport()
    let scaled = 0
    const result = await uploadReferenceMethod({ image_path: path }, { fetch: stub.fetch,
      scaleImage: async () => { scaled += 1; return new Uint8Array() },
      now: () => new Date('2026-09-20T10:11:12Z') })
    expect(scaled).toBe(0)
    expect(stub.bundleLoads).toBe(2)
    expect(stub.uploads).toHaveLength(1)
    const upload = stub.uploads[0]!
    expect(upload.method).toBe('PUT')
    const expectedUrl = /^https:\/\/jubian-aigc\.tos-cn-beijing\.volces\.com\/prod\/sys-material-image\/2026\/09\/20\/[0-9a-f]{32}\.png$/u
    expect(upload.url).toMatch(expectedUrl)
    expect(upload.headers.Authorization)
      .toContain('TOS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260920/cn-beijing/tos/request')
    expect(upload.body.length).toBe(png.byteLength)
    expect([...upload.body]).toEqual([...png])
    expect(result).toMatchObject({ materialUrl: upload.url, materialType: 'image', sortOrder: 1,
      width: 1680, height: 944, source_width: 1680, source_height: 944, reencoded: false, format: 'png',
      bytes: png.byteLength })
    expect(String(result.sha256)).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(JSON.stringify(result)).not.toContain('SECRETEXAMPLE')
  })

  it('re-encodes an unaligned image through the injected seam before uploading', async () => {
    const path = await file('odd.png', pngHeader(1675, 941))
    const stub = transport()
    const seen: { width: number; height: number }[] = []
    const scaled = new Uint8Array([1, 2, 3, 4])
    const result = await uploadReferenceMethod({ image_path: path }, { fetch: stub.fetch,
      scaleImage: async (request) => {
        seen.push(request.target)
        expect(request).toMatchObject({ width: 1675, height: 941, format: 'png' })
        return scaled
      },
      now: () => new Date('2026-09-20T10:11:12Z') })
    expect(seen).toEqual([{ width: 1680, height: 944 }])
    expect(stub.uploads[0]?.body.length).toBe(scaled.byteLength)
    expect([...(stub.uploads[0]?.body ?? new Uint8Array())]).toEqual([...scaled])
    expect(result).toMatchObject({ width: 1680, height: 944, source_width: 1675, source_height: 941,
      reencoded: true, bytes: 4 })
  })

  it('refuses to upload an unaligned image when no re-encode is available, and names the target size', async () => {
    const path = await file('odd.png', pngHeader(1920, 1080))
    const stub = transport()
    const result = await uploadReferenceMethod({ image_path: path }, { fetch: stub.fetch,
      scaleImage: async () => { throw new Error('ffmpeg is not installed') } })
    expect(result).toMatchObject({ uploaded: false, status: 'alignment_required', source_width: 1920,
      source_height: 1080, required_width: 1920, required_height: 1088 })
    expect(String(result.guidance)).toContain('scale=1920:1088')
    expect(stub.uploads).toHaveLength(0)
  })

  it('refuses a missing file, a non-image file and a missing path', async () => {
    const stub = transport()
    await expect(uploadReferenceMethod({ image_path: join(root, 'absent.png') },
      { fetch: stub.fetch })).rejects.toThrow()
    const text = await file('notes.txt', new TextEncoder().encode('not an image at all'))
    await expect(uploadReferenceMethod({ image_path: text }, { fetch: stub.fetch })).rejects.toThrow()
    await expect(uploadReferenceMethod({}, { fetch: stub.fetch })).rejects.toThrow()
    expect(stub.uploads).toHaveLength(0)
    expect(stub.bundleLoads).toBe(0)
  })

  it('fails closed when the bucket refuses the object or the bundle cannot be read', async () => {
    const path = await file('aligned.png', pngHeader(1024, 1024))
    await expect(uploadReferenceMethod({ image_path: path }, { fetch: transport({ status: 403 }).fetch }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await expect(uploadReferenceMethod({ image_path: path }, { fetch: transport({ failBundle: true }).fetch }))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('fails closed when the bundle no longer carries the upload configuration', async () => {
    const path = await file('aligned.png', pngHeader(1024, 1024))
    const stub = async (url: string | URL): Promise<Response> =>
      new Response(url.toString().endsWith('.js') ? 'var modules={{"1":function(){}}}' : FRONTEND_HTML,
        { status: 200 })
    await expect(uploadReferenceMethod({ image_path: path },
      { fetch: stub as unknown as typeof fetch })).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })
})
