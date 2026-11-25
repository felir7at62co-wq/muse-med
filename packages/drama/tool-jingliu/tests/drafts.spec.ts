/** Jingliu-planned drafts: one download per material, linked into each draft, local cover, fingerprint by plan digest. */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { JingliuHttpError, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { plannedDrafts, type PlannedDraftBatch } from '../src/library.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, stat: vi.fn(fs.stat) }
})

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.mocked(stat).mockReset()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function plan(episode: number, sha: string, subtitles: Record<string, unknown> = { status: 'fresh', stale: [], missing: [], unverified: [] }) {
  return { episode, name: `测试剧-第${String(episode)}集`,
    draft_content: { duration: 7_000_000, name: 'x', tracks: [{ type: 'video', segments: [{}, {}] }],
      materials: { videos: [{ path: '__SFMAT__/a1.mp4' }, { path: '__SFMAT__/a1-2.mp4' }] } },
    draft_meta_info: { draft_id: 'x', draft_name: 'x', draft_fold_path: '__SFDRAFT__', draft_root_path: '__SFROOT__', draft_cover: '__SFDRAFT__/draft_cover.jpg' },
    materials: [{ path: '/fw/media/generated/a.mp4', name: 'a1.mp4', size: 5, etag: '"a"' },
      { path: '/fw/media/generated/a.mp4', name: 'a1-2.mp4', size: 5, etag: '"a"' }],
    draft_sha256: sha.repeat(64), duration_us: 7_000_000, shots: 2, subtitles: { ...subtitles, switch: true, cues: 2 },
    music: { switch: true, clips: 0 }, cover: { file: 'draft_cover.jpg', path: '/fw/media/generated/a.mp4', name: 'a1.mp4', source_in_us: 500_000 },
    warnings: [] }
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'muse-jingliu-drafts-'))
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'drafts'), folder = join(base, 'ws', 'jingliu', 'p1')
  await mkdir(root, { recursive: true })
  const requests: unknown[] = [], downloads: string[][] = [], covers: number[] = []
  const state = { outdated: false, episodes: new Map<number, unknown>([[1, plan(1, 'a')], [2, plan(2, 'b', { status: 'stale', stale: [4, 5], missing: [], unverified: [] })],
    [3, { episode: 3, error: 'no_shots' }]]) }
  const session: JingliuSession = {
    identity: 'alice',
    request: async (path, options = {}) => {
      if (state.outdated) throw new JingliuHttpError(404, 'JINGLIU_HTTP_ERROR', 'Not Found')
      expect(path).toBe('/projects/p1/jianying/plan')
      const body = options.body as { episodes: number[] }
      requests.push(body)
      return { project_id: 'p1', tokens: {}, unsupported: ['ending'], episodes: body.episodes.map(episode => state.episodes.get(episode)) }
    },
    download: async (paths, target) => {
      downloads.push([...paths])
      const out = new Map<string, LocalMedia>()
      for (const path of paths) {
        const file = join(target, 'generated', path.split('/').at(-1)!)
        await mkdir(join(target, 'generated'), { recursive: true })
        await writeFile(file, 'video')
        out.set(path, { path, file, size: 5, contentType: 'video/mp4' })
      }
      return out
    },
    place: async (file, target) => { await copyFile(file.file, target) },
  }
  const batch = (episodes: number[]): PlannedDraftBatch => ({ project: 'p1', episodes, switches: { ending: true }, root, mediaFolder: folder,
    cover: async (_video, seconds, target) => { covers.push(seconds); await writeFile(target, 'jpg'); return true } })
  return { root, session, state, requests, downloads, covers, batch }
}

it('installs a planned draft once, refuses stale subtitles by shot order and reports episodes without shots', async () => {
  const { root, session, requests, downloads, covers, batch } = await setup()
  const outcome = await plannedDrafts(session, batch([1, 2, 3]), new AbortController().signal)
  expect(outcome).toMatchObject({ existing: [], music_missing: [1], unsupported: ['ending'], refused: [
    { episode: 2, reason: 'subtitles_stale', changed_shots: [4, 5] }, { episode: 3, reason: 'not_selected', detail: 'no_shots' }] })
  expect(requests).toEqual([{ episodes: [1, 2, 3], switches: { ending: true } }])
  expect(downloads).toEqual([['/fw/media/generated/a.mp4']])
  expect(covers).toEqual([1.5])
  const path = (outcome.created[0] as { path: string }).path
  expect(path).toMatch(/测试剧-第1集 - Muse [0-9a-f]{10}$/u)
  expect((await readdir(join(path, 'media'))).sort()).toEqual(['a1-2.mp4', 'a1.mp4'])
  const content = JSON.parse(await readFile(join(path, 'draft_content.json'), 'utf8')) as { materials: { videos: { path: string }[] } }
  const draftPath = path.split('\\').join('/')
  expect(content.materials.videos[0]!.path).toBe(`${draftPath}/media/a1.mp4`)
  const meta = JSON.parse(await readFile(join(path, 'draft_meta_info.json'), 'utf8')) as Record<string, string>
  expect(meta).toMatchObject({ draft_fold_path: draftPath, draft_root_path: root.split('\\').join('/'), draft_cover: `${draftPath}/draft_cover.jpg` })
  expect((await stat(join(path, 'draft_cover.jpg'))).size).toBe(3)
  expect(await readFile(join(path, 'draft_info.json'), 'utf8')).toBe(await readFile(join(path, 'draft_content.json'), 'utf8'))

  const again = await plannedDrafts(session, batch([1]), new AbortController().signal)
  expect(again).toMatchObject({ created: [], existing: [{ episode: 1, path }] })
  expect((await readdir(root)).filter(name => !name.startsWith('.'))).toHaveLength(1)
})

it('installs a new draft beside the old one when the plan changes, and drops the cover it could not cut', async () => {
  const { root, session, state, batch } = await setup()
  await plannedDrafts(session, batch([1]), new AbortController().signal)
  state.episodes.set(1, plan(1, 'c'))
  const outcome = await plannedDrafts(session, { ...batch([1]), cover: async () => false }, new AbortController().signal)
  expect(outcome.refused).toEqual([])
  const path = (outcome.created[0] as { path: string }).path
  expect((await readdir(root)).filter(name => !name.startsWith('.'))).toHaveLength(2)
  expect(JSON.parse(await readFile(join(path, 'draft_meta_info.json'), 'utf8'))).not.toHaveProperty('draft_cover')
})

it('splits episodes into plan requests of ten and reports an old Jingliu as outdated', async () => {
  const { session, state, requests, batch } = await setup()
  for (let episode = 4; episode <= 12; episode++) state.episodes.set(episode, { episode, error: 'no_shots' })
  await plannedDrafts(session, batch([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 1]), new AbortController().signal)
  expect((requests as { episodes: number[] }[]).map(body => body.episodes.length)).toEqual([10, 1])
  state.outdated = true
  expect(await plannedDrafts(session, batch([1, 2]), new AbortController().signal)).toMatchObject({ created: [],
    refused: [{ episode: 1, reason: 'jingliu_outdated' }, { episode: 2, reason: 'jingliu_outdated' }] })
})

it('refuses unverified subtitles unless the user chose to keep the legacy rows', async () => {
  const { session, state, batch } = await setup()
  state.episodes.set(4, plan(4, 'd', { status: 'unverified', stale: [], missing: [], unverified: [7] }))
  expect(await plannedDrafts(session, batch([4]), new AbortController().signal)).toMatchObject({ created: [],
    refused: [{ episode: 4, reason: 'subtitles_unverified', shots: [7] }] })
  const kept = await plannedDrafts(session, { ...batch([4]), keepLegacy: true }, new AbortController().signal)
  expect(kept).toMatchObject({ refused: [], created: [{ episode: 4 }] })
})

it('reports the shot order for missing subtitles without downloading any material', async () => {
  const { root, session, state, downloads, batch } = await setup()
  state.episodes.set(4, plan(4, 'd', { status: 'missing', missing: [2, 'unknown', 3.5, 8] }))
  const outcome = await plannedDrafts(session, batch([4]), new AbortController().signal)
  expect(outcome).toMatchObject({ created: [], refused: [{ episode: 4, reason: 'subtitles_missing', shots: [2, 8] }] })
  expect(downloads).toEqual([])
  expect(await readdir(root)).toEqual([])
})

it('installs a text-only plan without media transfers and sends the explicit draft switches and prefix', async () => {
  const { root, session, batch, covers } = await setup()
  const original = plan(1, 'e')
  const textOnly = { episode: 1, name: ' ... ', draft_sha256: original.draft_sha256,
    draft_content: { text: '片名' }, draft_meta_info: original.draft_meta_info,
    materials: [], subtitles: { status: 'missing' }, music: {}, cover: null }
  const request = vi.fn<JingliuSession['request']>().mockResolvedValue({ episodes: [textOnly], unsupported: ['ending', 2, 'ending'] })
  const download = vi.fn<NonNullable<JingliuSession['download']>>()
  const options = { ...batch([1]), switches: { subtitles: false, music: false }, namePrefix: '试片' }
  const signal = new AbortController().signal

  const outcome = await plannedDrafts({ ...session, request, download }, options, signal)
  expect(outcome).toMatchObject({ refused: [], unsupported: ['ending'], music_missing: [], created: [{ episode: 1 }] })
  expect(request).toHaveBeenCalledExactlyOnceWith('/projects/p1/jianying/plan', {
    method: 'POST', signal, body: { episodes: [1], switches: options.switches, name_prefix: '试片' },
  })
  const [folder] = await readdir(root)
  expect(folder).toMatch(/^Jingliu - Muse /u)
  if (folder === undefined) throw new Error('Draft directory missing')
  const path = join(root, folder)
  expect(JSON.parse(await readFile(join(path, '.muse-jingliu.json'), 'utf8')))
    .toMatchObject({ path, shots: 0, materials: 0, bytes: 0, cover: false, tracks: [] })
  expect(JSON.parse(await readFile(join(path, 'draft_meta_info.json'), 'utf8'))).not.toHaveProperty('draft_cover')
  expect(download).not.toHaveBeenCalled()
  expect(covers).toEqual([])
})

it('uses observed material sizes and retries the cover at the clip start when the later frame fails', async () => {
  const { root, session, state, batch } = await setup()
  const planned = plan(1, 'f')
  state.episodes.set(1, { ...planned, materials: planned.materials.map(item => ({ ...item, size: null })),
    music: { clips: 1 }, warnings: ['音乐轨已保留', 4] })
  const options = batch([1])
  const cover = vi.fn<PlannedDraftBatch['cover']>(options.cover).mockResolvedValueOnce(false)
  const outcome = await plannedDrafts(session, { ...options, cover }, new AbortController().signal)
  expect(outcome).toMatchObject({ refused: [], music_missing: [], created: [{ episode: 1, warnings: ['音乐轨已保留'] }] })
  expect(cover.mock.calls.map(([, time]) => time)).toEqual([1.5, 0.5])
  const [folder] = await readdir(root)
  if (folder === undefined) throw new Error('Draft directory missing')
  expect(JSON.parse(await readFile(join(root, folder, '.muse-jingliu.json'), 'utf8')))
    .toMatchObject({ materials: 2, bytes: 10, cover: true })
})

const valid = plan(1, 'a')
it.each([
  { name: 'a non-plan response', response: null },
  { name: 'a malformed episode entry', response: { episodes: [false] } },
  { name: 'a different episode', response: { episodes: [plan(2, 'b')] } },
  { name: 'a fractional episode number', response: { episodes: [{ ...valid, episode: 1.5 }] } },
  { name: 'an invalid draft digest', response: { episodes: [{ ...valid, draft_sha256: 'missing' }] } },
  { name: 'two materials with colliding names', response: { episodes: [{ ...valid,
    materials: [{ path: '/fw/media/generated/first.mp4', name: 'Clip.mp4', size: 1 }, { path: '/fw/media/generated/second.mp4', name: 'clip.mp4', size: 2 }],
  }] } },
  { name: 'a malformed cover timestamp', response: { episodes: [{ ...valid, cover: { ...valid.cover, source_in_us: 'later' } }] } },
])('rejects $name before staging a draft', async ({ response }) => {
  const { root, session, downloads, batch } = await setup()
  const request = vi.fn<JingliuSession['request']>().mockResolvedValue(response)
  await expect(plannedDrafts({ ...session, request }, batch([1]), new AbortController().signal))
    .rejects.toMatchObject({ code: 'JINGLIU_INVALID_DRAFT' })
  expect(downloads).toEqual([])
  expect(await readdir(root)).toEqual([])
})

it('distinguishes a studio without the plan route from a project-specific error', async () => {
  const { session, batch } = await setup()
  const request = vi.fn<JingliuSession['request']>()
  const runtime = { ...session, request }
  request.mockRejectedValueOnce(new JingliuHttpError(404, 'JINGLIU_INVALID_RESPONSE', 'Unknown route response'))
  await expect(plannedDrafts(runtime, batch([1]), new AbortController().signal)).resolves.toMatchObject({
    refused: [{ episode: 1, reason: 'jingliu_outdated' }],
  })
  const unknownProject = new JingliuHttpError(404, 'PROJECT_NOT_FOUND', '项目不存在')
  request.mockRejectedValueOnce(unknownProject)
  await expect(plannedDrafts(runtime, batch([1]), new AbortController().signal)).rejects.toBe(unknownProject)
})

it('keeps an existing draft without a matching receipt intact', async () => {
  const { root, session, downloads, batch } = await setup()
  const signal = new AbortController().signal
  await plannedDrafts(session, batch([1]), signal)
  const [folder] = await readdir(root)
  if (folder === undefined) throw new Error('Draft directory missing')
  const path = join(root, folder)
  await rm(join(path, '.muse-jingliu.json'))
  const edited = join(path, 'draft_content.json')
  await writeFile(edited, 'local edit')
  const outcome = await plannedDrafts(session, batch([1]), signal)
  expect(outcome).toMatchObject({ created: [], existing: [], refused: [{ episode: 1, reason: 'draft_failed' }] })
  expect(await readFile(edited, 'utf8')).toBe('local edit')
  expect(await readdir(root)).toEqual([folder])
  expect(downloads).toHaveLength(1)
})

it('does not stage a draft when the destination cannot be checked', async () => {
  const { root, session, downloads, batch } = await setup()
  vi.mocked(stat).mockRejectedValueOnce(Object.assign(new Error('Draft folder access denied'), { code: 'EACCES' }))
  await expect(plannedDrafts(session, batch([1]), new AbortController().signal)).resolves.toMatchObject({
    refused: [{ episode: 1, reason: 'draft_failed', error: 'Draft folder access denied' }],
  })
  expect(downloads).toEqual([])
  expect(await readdir(root)).toEqual([])
})

it('reports media failures per episode and removes all unfinished files', async () => {
  const { root, session, batch } = await setup()
  const signal = new AbortController().signal
  const remoteOnly: JingliuSession = { identity: session.identity, request: (path, options) => session.request(path, options) }
  const noLocalMedia = await plannedDrafts(remoteOnly, batch([1]), signal)
  expect(noLocalMedia.refused).toMatchObject([{ episode: 1, reason: 'draft_failed' }])
  expect(noLocalMedia.refused[0]?.error).toContain('桌面版 Muse')
  const download = vi.fn<NonNullable<JingliuSession['download']>>().mockResolvedValue(new Map())
  const missingMaterial = await plannedDrafts({ ...session, download }, batch([1]), signal)
  expect(missingMaterial.refused).toMatchObject([{ episode: 1, reason: 'draft_failed' }])
  expect(missingMaterial.refused[0]?.error).toContain('草稿包或素材清单')
  const place = vi.fn<NonNullable<JingliuSession['place']>>().mockRejectedValue('linked media unavailable')
  await expect(plannedDrafts({ ...session, place }, batch([1]), signal)).resolves.toMatchObject({
    refused: [{ episode: 1, reason: 'draft_failed', error: 'linked media unavailable' }],
  })
  expect(await readdir(root)).toEqual([])
})

it('cleans up staged media and the cover when installation is cancelled before publish', async () => {
  const { root, session, batch } = await setup()
  const controller = new AbortController()
  const cancelled = new Error('Draft cancelled')
  const cover = vi.fn<PlannedDraftBatch['cover']>(async (_video, _at, target, signal) => {
    expect(signal).toBe(controller.signal)
    await writeFile(target, 'jpeg')
    controller.abort(cancelled)
    return true
  })
  await expect(plannedDrafts(session, { ...batch([1]), cover }, controller.signal)).rejects.toBe(cancelled)
  expect(cover).toHaveBeenCalledTimes(1)
  expect(await readdir(root)).toEqual([])
})
