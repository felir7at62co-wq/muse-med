/** A Jingliu project: shots from the edit plan, media downloaded once, corrected words stored through a segments job. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { JingliuHttpError, type JingliuSession, type LocalMedia } from '@deepseek-ai/dsh-jingliu-connection'
import { readSubtitleClockReceipt, type SubtitleClockReceiptV2 } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import { runEpisodeSubtitles, type EpisodeSubtitlesArgs } from '../src/tool.ts'
import { extractPcm, fakeRules, gateway, runnerMedia, settings, toolkit, type Script } from './fixture.ts'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })

type Timing = { clipIn: number; clipDur: number; speed: number }
type Shot = { id: string; order: number; video: string; tag: string; lines: string[]; status: string; legacy?: number } & Timing
type Word = { start: number; end: number; text: string }
type Segment = { shot_id: string; video_url: string; source_sha256: string; words: Word[]; decisions: { id: string; action: string }[] }

function pcm(seconds: number, tag: string): Buffer {
  const bytes = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  bytes.write(tag, 0, 'utf8')
  return bytes
}

/** The doubt item the fixture rules also produce, so the server and the preview agree on IDs. */
function doubts(segment: Segment) {
  return segment.words.filter(word => word.text.endsWith('吗')).map((word) => {
    const id = sha(JSON.stringify([segment.source_sha256, word.text, word.start])).slice(0, 12)
    return { id, kind: 'doubt', heard: word.text, script: '', start: word.start, end: word.end,
      decision: segment.decisions.find(row => row.id === id)?.action ?? null }
  })
}

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), 'muse-episode-subtitles-jingliu-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true }))
  const root = join(workspace, 'jingliu', 'p1')
  const shots: Shot[] = [
    { id: 'a1', order: 11, video: '/fw/media/generated/a1.mp4', tag: 'a1', lines: ['你好啊'], clipIn: 0, clipDur: 3, speed: 1, status: 'missing' },
    { id: 'b2', order: 12, video: '/fw/media/generated/b2.mp4', tag: 'b2', lines: ['在吗'], clipIn: 1, clipDur: 2, speed: 2, status: 'missing' },
  ]
  const requests: string[] = [], jobs: Segment[][] = [], payloads: Record<string, unknown>[] = []
  const control = { outdated: false, running: false, changed: undefined as string | undefined, lost: 0, failed: 0,
    refuseLegacy: undefined as string | undefined }
  const results = new Map<string, unknown>()
  const session: JingliuSession = {
    identity: 'alice',
    request: async (path, options = {}) => {
      requests.push(`${options.method ?? 'GET'} ${path}`)
      if (path === '/projects/p1/edit-plan') {
        if (control.outdated) throw new JingliuHttpError(404, 'JINGLIU_HTTP_ERROR', 'Not Found')
        return { project_id: 'p1', names: ['林晨'], episodes: [{ episode: 1, shots: shots.map(shot => ({ shot_id: shot.id, order: shot.order,
          episode: 1, video_path: shot.video, version: 1, video_size: null, video_etag: `"${shot.tag}"`, clip_in_sec: shot.clipIn,
          clip_dur_sec: shot.clipDur, speed: shot.speed, output_sec: shot.clipDur / shot.speed, lines: shot.lines,
          subtitles: { status: shot.status, cues: 0, time_base: null, manual: 0, legacy: shot.legacy ?? 0 } })),
        subtitles: { status: 'missing', stale: [], missing: [], unverified: [] } }] }
      }
      if (path === '/jobs') {
        const body = options.body as { payload: { segments: Segment[] } & Record<string, unknown> }
        const segments = body.payload.segments
        jobs.push(segments)
        payloads.push(body.payload)
        if (control.lost > 0) { control.lost--; throw new Error('socket hang up') }
        const id = `job-${String(jobs.length)}`
        if (control.failed > 0) { control.failed--; results.set(id, null); return { id, kind: 'auto_subtitles', status: 'pending', progress: 0 } }
        const refused = segments.filter(segment => segment.shot_id === control.changed)
          .map(segment => ({ shot_id: segment.shot_id, reason: 'video_changed', video_url: '/fw/media/generated/new.mp4' }))
          .concat(segments.filter(segment => segment.shot_id === control.refuseLegacy)
            .map(segment => ({ shot_id: segment.shot_id, reason: 'legacy_subtitles', video_url: '', legacy: 1 })))
        const written = segments.filter(segment => segment.shot_id !== control.changed && segment.shot_id !== control.refuseLegacy)
        for (const segment of written) { const shot = shots.find(row => row.id === segment.shot_id)!; shot.status = 'fresh' }
        results.set(id, { mode: 'segments', created: written.length, total: segments.length, episode: 1, refused,
          shots: written.map(segment => ({ shot_id: segment.shot_id, episode: 1,
            order: shots.find(row => row.id === segment.shot_id)!.order,
            cues: 1, status: 'fresh', pending: 0, items: doubts(segment) })) })
        return { id, kind: 'auto_subtitles', status: 'pending', progress: 0 }
      }
      const id = path.replace('/jobs/', '')
      if (results.get(id) === null) return { id, kind: 'auto_subtitles', status: 'failed', progress: 100, result: null, error: 'boom' }
      return { id, kind: 'auto_subtitles', status: control.running ? 'running' : 'done', progress: 100,
        result: control.running ? null : JSON.stringify(results.get(id)) }
    },
    download: async (paths, folder) => {
      const out = new Map<string, LocalMedia>()
      for (const path of paths) {
        const shot = shots.find(row => row.video === path)!
        const file = join(folder, ...path.replace('/fw/media/', '').split('/'))
        await mkdir(join(folder, 'generated'), { recursive: true })
        const bytes = pcm(3, shot.tag)
        await writeFile(file, bytes)
        out.set(path, { path, file, size: bytes.length, contentType: 'video/mp4' })
      }
      return out
    },
  }
  const audioSha = (tag: string) => sha(pcm(3, tag))
  const script: Script = new Map([[audioSha('a1'), [{ start: 0.5, end: 0.7, text: '你' }, { start: 0.8, end: 1, text: '好' }]],
    [audioSha('b2'), [{ start: 1.2, end: 1.4, text: '在' }, { start: 1.6, end: 1.8, text: '吗' }]]])
  const g = gateway(root, script)
  const rules = fakeRules()
  const call = async (args: Partial<EpisodeSubtitlesArgs> = {}) => await runEpisodeSubtitles({ method: 'build', source: 'jingliu', project: 'p1',
    episodes: [1], ...args }, settings, { account: g.account, rules, cwd: workspace,
    jingliu: async () => session, media: { runner: runnerMedia, extractPcm, toolkit } })
  return { root, shots, requests, jobs, payloads, control, g, rules, call, audioSha, srt: join(root, 'subtitles', 'ep01.srt') }
}

it('stores corrected words on Jingliu once and lists Jingliu review items on the preview clock', async () => {
  const { shots, jobs, g, call, audioSha, srt, requests } = await setup()
  expect(await call()).toMatchObject({ status: 'waiting', asr: { pending_packs: 1 } })
  expect(g.submits).toEqual([[audioSha('a1'), audioSha('b2')]])
  g.complete()
  const built = await call()
  expect(built).toMatchObject({ status: 'needs_review', needs_review: { 1: 1 }, files: 'jingliu/p1/subtitles/epNN.srt',
    next: { tool: 'episode_subtitles', args: { method: 'review', source: 'jingliu', project: 'p1', episodes: [1] } } })
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject([
    { shot_id: 'a1', video_url: shots[0]!.video, source_sha256: audioSha('a1'), words: [{ text: '你' }, { text: '好' }], decisions: [] },
    { shot_id: 'b2', video_url: shots[1]!.video, source_sha256: audioSha('b2') }])
  // Shot 12 plays source 1–3 s at double speed after shot 11's 3 s: source 1.2 s lands at 3 + 0.1 s.
  expect((await readFile(srt, 'utf8')).split('\n').filter(line => line.includes('-->')))
    .toEqual(['00:00:00,500 --> 00:00:01,000', '00:00:03,100 --> 00:00:03,400'])
  const receipt = (await readSubtitleClockReceipt(srt))?.receipt as SubtitleClockReceiptV2
  expect(receipt.shots.map(row => row.jingliu)).toEqual([
    { shot_id: 'a1', video_path: shots[0]!.video, etag: '"a1"', clip_in_us: 0, speed: 1 },
    { shot_id: 'b2', video_path: shots[1]!.video, etag: '"b2"', clip_in_us: 1_000_000, speed: 2 }])
  expect(await call()).toMatchObject({ status: 'needs_review' })
  expect(jobs).toHaveLength(1)
  expect(requests.filter(line => line.startsWith('POST /jobs'))).toHaveLength(1)

  shots[0]!.status = 'stale'
  await call()
  expect(jobs.at(-1)?.map(segment => segment.shot_id)).toEqual(['a1'])
})

it('sends review decisions to Jingliu by item ID and stores them with the words', async () => {
  const { jobs, g, call } = await setup()
  await call(); g.complete(); await call()
  const page = await call({ method: 'review' })
  expect(page).toMatchObject({ pending: 1, items: [{ episode: 1, shot: 12, kind: 'doubt', heard: '吗' }] })
  const id = (page.items as { id: string }[])[0]!.id
  expect(await call({ method: 'review', decisions: [{ id, action: 'drop' }] })).toMatchObject({ applied: 1, pending: 0, status: 'ready',
    next: { tool: 'jianying_draft', args: { source: 'jingliu', project: 'p1', episodes: [1] } } })
  expect(jobs.at(-1)).toMatchObject([{ shot_id: 'b2', decisions: [{ id, action: 'drop' }] }])
  expect(g.submits).toHaveLength(1)
})

it('waits on a running job and on a shot whose video changed, without resubmitting', async () => {
  const { jobs, g, call, control } = await setup()
  await call(); g.complete()
  control.running = true
  expect(await call()).toMatchObject({ status: 'waiting', waiting: [1] })
  expect(await call()).toMatchObject({ status: 'waiting' })
  expect(jobs).toHaveLength(1)
  control.running = false
  expect(await call()).toMatchObject({ status: 'needs_review' })
  expect(jobs).toHaveLength(1)
})

it('reports a shot whose video changed on Jingliu as changed and builds again', async () => {
  const { g, call, control } = await setup()
  await call(); g.complete()
  control.changed = 'b2'
  expect(await call()).toMatchObject({ status: 'waiting', changed: { 1: [12] }, next: { tool: 'episode_subtitles', args: { method: 'build' } } })
})

it('combines a corrected script with a separate shot refused for a video change', async () => {
  const { shots, g, call, control } = await setup()
  await call()
  g.complete()
  expect(await call()).toMatchObject({ status: 'needs_review' })
  shots[0]!.lines = ['另一个版本']
  shots[1]!.status = 'missing'
  control.changed = 'b2'
  expect(await call()).toMatchObject({ status: 'waiting', changed: { 1: [11, 12] } })
  expect(g.submits).toHaveLength(1)
})

it('anchors a review finding before a Jingliu trim at the start of the played shot', async () => {
  const { g, call } = await setup()
  g.account.audioStatus = async id => ({
    id, status: 'complete', segments: [{ start: 4.25, end: 4.55, text: '吗' }],
  })
  await call()
  await call()
  const review = await call({ method: 'review' })
  expect(review.items).toMatchObject([{ shot: 12, start: 3, end: 3 }])
})

it('reports an old Jingliu as outdated and never sends it a subtitle job', async () => {
  const { requests, call, control } = await setup()
  control.outdated = true
  expect(await call()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'jingliu_outdated' }] })
  expect(requests).toEqual(['POST /projects/p1/edit-plan'])
})

it('reports jingliu_outdated without a Jingliu connection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'muse-episode-subtitles-jingliu-'))
  cleanups.push(() => rm(workspace, { recursive: true, force: true }))
  const g = gateway(workspace, new Map())
  expect(await runEpisodeSubtitles({ method: 'build', source: 'jingliu', project: 'p1', episodes: [1, 2] }, settings,
    { account: g.account, rules: fakeRules(), cwd: workspace, media: { runner: runnerMedia, extractPcm, toolkit } }))
    .toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'jingliu_outdated' }, { episode: 2, reason: 'jingliu_outdated' }] })
})

it('asks the user about legacy rows instead of rebuilding over them, and replaces them only when told to', async () => {
  const { shots, jobs, payloads, g, call } = await setup()
  shots[0]!.status = 'unverified'
  shots[0]!.legacy = 2
  await call(); g.complete()
  const built = await call()
  expect(built).toMatchObject({ status: 'needs_choice', unverified: [{ episode: 1, shots: [11] }],
    ask: { keep: { tool: 'jianying_draft', args: { source: 'jingliu', project: 'p1', episodes: [1], keep_legacy_subtitles: true } },
      remake: { tool: 'episode_subtitles', args: { method: 'build', source: 'jingliu', project: 'p1', episodes: [1], replace_legacy: true } } } })
  expect(built).not.toHaveProperty('next')
  expect((built.ask as { question: string }).question).toContain('EP1')
  expect(jobs.map(segments => segments.map(segment => segment.shot_id))).toEqual([['b2']])
  expect(payloads[0]).not.toHaveProperty('replace_legacy')

  expect(await call({ replace_legacy: true })).toMatchObject({ status: 'needs_review' })
  expect(jobs.at(-1)?.map(segment => segment.shot_id)).toEqual(['a1'])
  expect(payloads.at(-1)).toMatchObject({ replace_legacy: true })
  await expect(call({ source: 'local', project: '.', replace_legacy: true })).rejects.toThrow('replace_legacy')
})

it('lists a shot Jingliu refused for its legacy rows under the same choice', async () => {
  const { g, call, control } = await setup()
  await call(); g.complete()
  control.refuseLegacy = 'a1'
  expect(await call()).toMatchObject({ status: 'needs_choice', unverified: [{ episode: 1, shots: [11] }] })
})

it('sends a segments job again after a lost answer or a failed job, but only once per call', async () => {
  const { jobs, g, call, control } = await setup()
  await call(); g.complete()
  control.lost = 1
  expect(await call()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'subtitle_job_unknown', shots: [11, 12] }] })
  expect(jobs).toHaveLength(1)
  control.failed = 1
  expect(await call()).toMatchObject({ status: 'blocked', blocked: [{ episode: 1, reason: 'subtitle_job_failed' }] })
  expect(jobs).toHaveLength(2)
  expect(await call()).toMatchObject({ status: 'needs_review' })
  expect(jobs).toHaveLength(3)
  expect(g.submits).toHaveLength(1)
})
