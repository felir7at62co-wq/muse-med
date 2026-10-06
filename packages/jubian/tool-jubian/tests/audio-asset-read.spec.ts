/** Audio asset reads preserve remote identities and distinguish absence from unreadable pages. */
import { describe, expect, it } from 'vitest'
import { JubianClient } from '@deepseek-ai/dsh-jubian'
import { getAudioAsset, listAudioAssetMaterialUrls, listAudioAssets, readAudioAsset } from '../src/audio-asset-read.ts'

const AUDIO_URL = 'https://media.example/zhou.wav'
const AUDIO = { id: 77, scriptId: 2708, assetType: 4, assetName: '周海生声音', url: AUDIO_URL, isLocal: 1 }
const EXPECTED = { asset_id: 77, script_id: 2708, asset_type: 4, name: '周海生声音', url: AUDIO_URL,
  audio_duration: null, is_local: true }

/** The shared transport handles envelopes; this fixture replaces only the external HTTP service. */
function fixture(payload: unknown, status = 200, bare = false): { client: JubianClient; requests: URL[] } {
  const requests: URL[] = []
  const client = new JubianClient({ credential: async () => 'test-token',
    fetch: async (input: string | URL | Request) => {
      requests.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
      return new Response(JSON.stringify(bare ? payload : { code: 200, data: payload }), { status })
    } })
  return { client, requests }
}

describe('readAudioAsset', () => {
  it('reads a project audio identity without treating generated duration as measured audio', () => {
    expect(readAudioAsset({ ...AUDIO, modelConfig: '{"duration":10}', audioDuration: 10 }, 2708, 77)).toEqual(EXPECTED)
  })

  it('reads the observed assetUrl and name field spellings', () => {
    expect(readAudioAsset({ id: '77', scriptId: '2708', assetType: 4, assetUrl: AUDIO_URL, name: '声音', isLocal: 0 }, 2708))
      .toEqual({ ...EXPECTED, name: '声音', is_local: false })
  })

  it('reports missing media separately from a missing asset', () => {
    expect(readAudioAsset({ id: 77, scriptId: 2708, assetType: 4 }, 2708)).toEqual({
      ...EXPECTED, name: null, url: null, is_local: false,
    })
  })

  it.each([
    { ...AUDIO, id: 78 }, { ...AUDIO, scriptId: 2709 }, { ...AUDIO, assetType: 1 },
    { ...AUDIO, scriptId: undefined }, { ...AUDIO, url: 123 }, { ...AUDIO, assetName: [] }, null, [],
  ])('rejects unreadable or mismatched audio identity %#', (data) => {
    expect(() => readAudioAsset(data, 2708, 77)).toThrow(expect.objectContaining({ code: 'CONTRACT_CHANGED' }))
  })
})

describe('getAudioAsset', () => {
  it('reads the exact asset and checks its project and category', async () => {
    const f = fixture(AUDIO)
    expect(await getAudioAsset(f.client, 2708, 77)).toEqual(EXPECTED)
    expect(f.requests.map(url => url.pathname)).toEqual(['/prod-api/aigc/asset/77'])
  })

  it('returns null only when a successful asset payload states absence', async () => {
    const f = fixture(null)
    expect(await getAudioAsset(f.client, 2708, 77)).toBeNull()
  })

  it('does not treat an HTTP failure as successful deletion readback', async () => {
    const f = fixture(null, 404)
    await expect(getAudioAsset(f.client, 2708, 77)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('does not treat unreadable data as absence', async () => {
    const f = fixture({})
    await expect(getAudioAsset(f.client, 2708, 77)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })
})

describe('listAudioAssets', () => {
  it('queries project audio parents and preserves the total of a partial page', async () => {
    const f = fixture({ rows: [AUDIO], total: 3 })
    expect(await listAudioAssets(f.client, { script_id: 2708, page_num: 1, page_size: 1, asset_name: '周海生 & 声音' }))
      .toEqual({ script_id: 2708, page_num: 1, page_size: 1, total: 3, returned: 1,
        complete: false, has_more: true, assets: [EXPECTED] })
    expect(Object.fromEntries(f.requests[0]!.searchParams)).toEqual({
      scriptId: '2708', assetType: '4', isParent: '1', pageNum: '1', pageSize: '1', assetName: '周海生 & 声音',
    })
  })

  it('marks a full first page complete', async () => {
    const f = fixture({ rows: [AUDIO], total: 1 })
    expect(await listAudioAssets(f.client, { script_id: 2708, page_num: 1, page_size: 10 }))
      .toMatchObject({ total: 1, returned: 1, complete: true, has_more: false })
  })

  it('does not mark the final page as a complete project inventory', async () => {
    const f = fixture({ rows: [AUDIO], total: 3 })
    expect(await listAudioAssets(f.client, { script_id: 2708, page_num: 3, page_size: 1 }))
      .toMatchObject({ total: 3, returned: 1, complete: false, has_more: false })
  })

  it('distinguishes an explicitly empty project inventory', async () => {
    const f = fixture({ rows: [], total: 0 })
    expect(await listAudioAssets(f.client, { script_id: 2708, page_num: 1, page_size: 10 }))
      .toMatchObject({ total: 0, returned: 0, complete: true, has_more: false, assets: [] })
  })

  it.each([
    null, [], {}, { rows: [] }, { rows: [], total: -1 }, { rows: [AUDIO], total: 0 },
    { rows: [AUDIO, AUDIO], total: 2 }, { rows: [{ ...AUDIO, scriptId: 2709 }], total: 1 },
    { rows: [{ ...AUDIO, assetType: 1 }], total: 1 },
  ])('refuses unreadable or inconsistent audio pages %#', async (payload) => {
    const f = fixture(payload)
    await expect(listAudioAssets(f.client, { script_id: 2708, page_num: 1, page_size: 10 }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('refuses more rows than the requested page can contain', async () => {
    const f = fixture({ rows: [AUDIO, { ...AUDIO, id: 78 }], total: 2 })
    await expect(listAudioAssets(f.client, { script_id: 2708, page_num: 1, page_size: 1 }))
      .rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })
})

describe('listAudioAssetMaterialUrls', () => {
  it('reads all material URLs from the observed unpaged bare array', async () => {
    const older = 'https://media.example/zhou-v1.wav'
    const f = fixture([{ assetUrl: AUDIO_URL }, { assetUrl: older }, { assetUrl: AUDIO_URL }], 200, true)
    expect(await listAudioAssetMaterialUrls(f.client, 2708, 77)).toEqual({
      urls: [older, AUDIO_URL], material_count: 3, complete: true,
    })
    expect(f.requests[0]!.pathname).toBe('/prod-api/aigc/material/selectNoPage')
    expect(Object.fromEntries(f.requests[0]!.searchParams)).toEqual({ assetId: '77', scriptId: '2708' })
  })

  it('accepts an explicitly empty complete enumeration', async () => {
    const f = fixture([], 200, true)
    expect(await listAudioAssetMaterialUrls(f.client, 2708, 77)).toEqual({ urls: [], material_count: 0, complete: true })
  })

  it('checks parent and project identities when the material states them', async () => {
    const f = fixture([{ assetUrl: AUDIO_URL, assetId: '77', scriptId: '2708' }], 200, true)
    expect(await listAudioAssetMaterialUrls(f.client, 2708, 77)).toEqual({
      urls: [AUDIO_URL], material_count: 1, complete: true,
    })
  })

  it.each([
    null, {}, { rows: [], total: 0 }, '[]', [null], [{}], [{ url: AUDIO_URL }],
    [{ assetUrl: null }], [{ assetUrl: '' }], [{ assetUrl: 123 }],
    [{ assetUrl: AUDIO_URL, assetId: 78 }], [{ assetUrl: AUDIO_URL, scriptId: 2709 }],
    [{ assetUrl: 'http://media.example/zhou.wav' }], [{ assetUrl: 'https://user:secret@media.example/zhou.wav' }],
    [{ assetUrl: 'not-a-url' }],
  ])('refuses an unreadable or unrelated complete enumeration %#', async (payload) => {
    const f = fixture(payload)
    await expect(listAudioAssetMaterialUrls(f.client, 2708, 77)).rejects.toMatchObject({ code: 'CONTRACT_CHANGED' })
  })

  it('keeps a failed material read distinct from an empty enumeration', async () => {
    const f = fixture([], 404)
    await expect(listAudioAssetMaterialUrls(f.client, 2708, 77)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })
})
