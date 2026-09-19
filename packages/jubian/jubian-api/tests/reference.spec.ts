import { describe, expect, it } from 'vitest'
import {
  REFERENCE_ALIGNMENT, alignReferenceEdge, alignedReferenceSize, buildReferenceObjectKey,
  extractAppScriptUrl, extractTosUploadConfig, readReferenceImage, referenceMaterialItem, signTosObjectPut,
} from '../src/reference.ts'

/** The ASCII bytes of a short tag, for building container headers in a fixture. */
function tag(text: string): number[] {
  return Array.from(text, character => character.charCodeAt(0))
}

/** A PNG header only: the reader is a header reader, so no pixel data is needed. */
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

/** A baseline JPEG header: SOI, one APP0 segment, then the frame header. */
function jpegHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(31)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xffd8)
  view.setUint16(2, 0xffe0)
  view.setUint16(4, 16)
  bytes.set(tag('JFIF\u0000'), 6)
  view.setUint16(20, 0xffc0)
  view.setUint16(22, 17)
  bytes[24] = 8
  view.setUint16(25, height)
  view.setUint16(27, width)
  view.setUint16(29, 0xffd9)
  return bytes
}

/** A lossless WebP header: RIFF container, VP8L chunk and the packed dimensions. */
function webpHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25)
  bytes.set(tag('RIFF'), 0)
  bytes.set(tag('WEBP'), 8)
  bytes.set(tag('VP8L'), 12)
  bytes[20] = 0x2f
  const packed = (width - 1) | ((height - 1) << 14)
  bytes[21] = packed & 0xff
  bytes[22] = (packed >> 8) & 0xff
  bytes[23] = (packed >> 16) & 0xff
  bytes[24] = (packed >> 24) & 0x0f
  return bytes
}

describe('reference image headers', () => {
  it('reads the true size of every accepted container', () => {
    expect(readReferenceImage(pngHeader(1680, 944))).toMatchObject(
      { format: 'png', width: 1680, height: 944, content_type: 'image/png', extension: '.png' })
    expect(readReferenceImage(jpegHeader(1024, 1536))).toMatchObject(
      { format: 'jpeg', width: 1024, height: 1536, content_type: 'image/jpeg', extension: '.jpg' })
    expect(readReferenceImage(webpHeader(800, 600))).toMatchObject(
      { format: 'webp', width: 800, height: 600, content_type: 'image/webp', extension: '.webp' })
  })

  it('reads a progressive JPEG frame header too', () => {
    const bytes = jpegHeader(1920, 1080)
    new DataView(bytes.buffer).setUint16(20, 0xffc2)
    expect(readReferenceImage(bytes)).toMatchObject({ format: 'jpeg', width: 1920, height: 1080 })
  })

  it('refuses a file whose header is not a supported image', () => {
    expect(() => readReferenceImage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/CONTRACT_CHANGED|envelope/u)
  })
})

describe('reference alignment', () => {
  it('rounds each edge to the nearest multiple of sixteen, never below it', () => {
    expect(REFERENCE_ALIGNMENT).toBe(16)
    expect(alignReferenceEdge(1675)).toBe(1680)
    expect(alignReferenceEdge(941)).toBe(944)
    expect(alignReferenceEdge(1)).toBe(16)
    expect(alignReferenceEdge(8)).toBe(16)
    expect(alignReferenceEdge(40)).toBe(48)
  })

  it('reports an already-aligned image as needing no re-encode', () => {
    expect(alignedReferenceSize({ width: 1680, height: 944 })).toEqual({ width: 1680, height: 944, aligned: true })
    expect(alignedReferenceSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1088, aligned: false })
  })
})

describe('object key and material item', () => {
  it('mints a dated, prefixed key under the workbench path', () => {
    const key = buildReferenceObjectKey(new Date('2026-09-20T10:00:00Z'), 'a'.repeat(32), '.jpg')
    expect(key).toBe(`prod/sys-material-image/2026/09/20/${'a'.repeat(32)}.jpg`)
  })

  it('refuses a token or extension that could escape the prefix', () => {
    expect(() => buildReferenceObjectKey(new Date(), '../etc', '.jpg')).toThrow()
    expect(() => buildReferenceObjectKey(new Date(), 'a'.repeat(32), '.jpeg2000')).toThrow()
  })

  it('builds the exact three-field item an asset request accepts', () => {
    expect(referenceMaterialItem('https://jubian-aigc.tos-cn-beijing.volces.com/prod/a.jpg', 1))
      .toEqual({ materialUrl: 'https://jubian-aigc.tos-cn-beijing.volces.com/prod/a.jpg',
        materialType: 'image', sortOrder: 1 })
    expect(() => referenceMaterialItem('http://insecure/a.jpg', 1)).toThrow()
    expect(() => referenceMaterialItem('https://ok/a.jpg', 0)).toThrow()
  })
})

const APP_JS = 'var modules={{"6c3d":function(e,t,n){var o=(t.default,"AKIDEXAMPLE");'
  + 'var s="SECRETEXAMPLE";var r="cn-beijing";var u="jubian-aigc";'
  + 'var l="tos-cn-beijing.volces.com";return o+s+r+u+l}},"6ea0":function(){return 1}}'

describe('frontend upload configuration', () => {
  it('reads the destination out of the bundle the workbench serves', () => {
    expect(extractTosUploadConfig(APP_JS)).toEqual({ access_key_id: 'AKIDEXAMPLE',
      access_key_secret: 'SECRETEXAMPLE', region: 'cn-beijing', bucket: 'jubian-aigc',
      endpoint: 'tos-cn-beijing.volces.com' })
  })

  it('fails closed when the bundle no longer carries that module', () => {
    expect(() => extractTosUploadConfig('var modules={{"1111":function(){}},"2222":function(){}}')).toThrow()
  })

  it('resolves the entry script from the document and refuses a document without one', () => {
    expect(extractAppScriptUrl('<html><script src="/static/js/app.abc123.js"></script></html>',
      'https://web.jubianai.net/')).toBe('https://web.jubianai.net/static/js/app.abc123.js')
    expect(() => extractAppScriptUrl('<html><script src="/static/js/vendor.js"></script></html>',
      'https://web.jubianai.net/')).toThrow()
  })
})

describe('object upload signature', () => {
  const config = { access_key_id: 'AKIDEXAMPLE', access_key_secret: 'SECRETEXAMPLE',
    region: 'cn-beijing', bucket: 'jubian-aigc', endpoint: 'tos-cn-beijing.volces.com' }
  const now = new Date('2026-09-20T10:11:12Z')

  it('signs with the provider SDK’s own scheme: unsigned payload, three signed headers', () => {
    const signed = signTosObjectPut({ config, key: 'prod/sys-material-image/a.png',
      payload: new TextEncoder().encode('pixels'), content_type: 'image/png', now })
    expect(signed.url).toBe('https://jubian-aigc.tos-cn-beijing.volces.com/prod/sys-material-image/a.png')
    expect(signed.headers['x-tos-date']).toBe('20260920T101112Z')
    expect(signed.headers.host).toBe('jubian-aigc.tos-cn-beijing.volces.com')
    expect(signed.headers['content-type']).toBe('image/png')
    // The workbench's SDK declares the payload instead of hashing it, and signs
    // only `host` and the `x-tos-*` headers. Both are load-bearing: any other
    // choice makes the bucket answer SignatureDoesNotMatch.
    expect(signed.headers['x-tos-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(signed.headers.Authorization).toContain('TOS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260920/cn-beijing/tos/request')
    expect(signed.headers.Authorization).toContain('SignedHeaders=host;x-tos-content-sha256;x-tos-date')
    expect(signed.headers.Authorization).toMatch(/Signature=[0-9a-f]{64}$/u)
    expect(signed.headers.Authorization).not.toContain('SECRETEXAMPLE')
  })

  it('changes the signature with the key and the time, and is stable for one key', () => {
    const sign = (key: string, at: Date): string =>
      signTosObjectPut({ config, key, payload: new TextEncoder().encode('a'),
        content_type: 'image/png', now: at }).headers.Authorization ?? ''
    const base = sign('prod/a.png', now)
    expect(sign('prod/b.png', now)).not.toBe(base)
    expect(sign('prod/a.png', new Date('2026-09-20T10:11:13Z'))).not.toBe(base)
    expect(sign('prod/a.png', now)).toBe(base)
  })

  it('refuses a key that could leave its prefix', () => {
    expect(() => signTosObjectPut({ config, key: '../secret', payload: new Uint8Array(1),
      content_type: 'image/png', now })).toThrow()
  })
})
