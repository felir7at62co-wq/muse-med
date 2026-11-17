import { describe, expect, it } from 'vitest'
import { loadManifest } from '../src/manifest.ts'
import type { Fetch } from '../src/station.ts'

const ORIGIN = 'https://muse.tos-cn-beijing.volces.com'
const DIRECTORY = 'download-video-date/hongguo/20261115/7470000000000000001/'
const MANIFEST_URL = `${ORIGIN}/${DIRECTORY}manifest-20261115T020000000Z.json`

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, platform: 'hongguo', work_id: '7470000000000000001', title: '剧名', bucket: 'muse', date: '20261115',
    directory: DIRECTORY, created_at: '2026-11-15T02:00:00.000Z',
    objects: [{ kind: 'video', key: `${DIRECTORY}video/001.mp4`, bytes: 7, sha256: 'a'.repeat(64), status: 'uploaded' }],
    ...overrides,
  }
}

function serving(body: unknown, status = 200): Fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }))
}

function signal(): AbortSignal {
  return new AbortController().signal
}

describe('loadManifest', () => {
  it('turns a manifest into the station upload payload', async () => {
    const encoded = `${ORIGIN}/download-video-date/hongguo/20261115/1/manifest-%E6%B8%85%E5%8D%95.json`
    await expect(loadManifest(serving(manifest({ objects: [{ kind: 'scripts', key: 'k', bytes: 0, sha256: 's', status: 'already_present' }] })),
      encoded, ORIGIN, 4096, signal())).resolves.toEqual({
      workId: '7470000000000000001',
      upload: {
        bucket: 'muse', date: '20261115', directory: DIRECTORY,
        objects: [{ kind: 'scripts', key: 'k', bytes: 0, sha256: 's', status: 'already_present' }],
        manifest: { key: 'download-video-date/hongguo/20261115/1/manifest-清单.json' },
      },
    })
  })

  it.each([
    ['another origin', 'https://example.com/m.json'],
    ['a query', `${MANIFEST_URL}?x=1`],
    ['a fragment', `${MANIFEST_URL}#x`],
  ])('rejects a manifest URL with %s', async (_label, url) => {
    await expect(loadManifest(serving(manifest()), url, ORIGIN, 4096, signal())).rejects.toMatchObject({ code: 'HIT_QUEUE_INVALID_REQUEST' })
  })

  it('reports unreadable manifests and keeps caller cancellation', async () => {
    const failing: Fetch = () => Promise.reject(new TypeError('fetch failed'))
    await expect(loadManifest(failing, MANIFEST_URL, ORIGIN, 4096, signal())).rejects.toMatchObject({ code: 'HIT_QUEUE_MANIFEST_UNAVAILABLE' })
    await expect(loadManifest(serving({}, 404), MANIFEST_URL, ORIGIN, 4096, signal())).rejects.toThrow('HTTP 404')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(loadManifest(failing, MANIFEST_URL, ORIGIN, 4096, controller.signal)).rejects.toThrow('stopped')
  })

  it.each([
    ['a list body', [1]],
    ['a text body', 'text'],
    ['another version', manifest({ version: 2 })],
    ['a novel manifest', manifest({ platform: 'fanqie' })],
    ['no objects', manifest({ objects: [] })],
    ['objects that are not a list', manifest({ objects: {} })],
    ['a non-object entry', manifest({ objects: [null] })],
    ['a fractional size', manifest({ objects: [{ kind: 'v', key: 'k', bytes: 1.5, sha256: 's', status: 'uploaded' }] })],
    ['a negative size', manifest({ objects: [{ kind: 'v', key: 'k', bytes: -1, sha256: 's', status: 'uploaded' }] })],
    ['a text size', manifest({ objects: [{ kind: 'v', key: 'k', bytes: '1', sha256: 's', status: 'uploaded' }] })],
    ['an unknown status', manifest({ objects: [{ kind: 'v', key: 'k', bytes: 1, sha256: 's', status: 'skipped' }] })],
    ['a missing key', manifest({ objects: [{ kind: 'v', bytes: 1, sha256: 's', status: 'uploaded' }] })],
    ['an empty bucket', manifest({ bucket: '' })],
    ['a missing work id', manifest({ work_id: undefined })],
  ])('rejects %s', async (_label, body) => {
    await expect(loadManifest(serving(body), MANIFEST_URL, ORIGIN, 4096, signal())).rejects.toMatchObject({ code: 'HIT_QUEUE_MANIFEST_INVALID' })
  })
})
