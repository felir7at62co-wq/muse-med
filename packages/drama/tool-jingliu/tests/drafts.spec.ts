/** Jingliu-planned drafts: one download per material, linked into each draft, local cover, fingerprint by plan digest. */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JingliuHttpError, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { plannedDrafts, type PlannedDraftBatch } from '../src/library.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

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
