/** A local short-drama project with fake media, a scripted transcription gateway and deterministic rules. */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MuseAsrJob, MuseAsrSegment } from '@deepseek-ai/dsh-muse-account'
import type { AudioAccount } from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import type { MediaToolkit } from '@deepseek-ai/dsh-tool-episode-render/subtitles'
import type { EpisodeSubtitlesServices, EpisodeSubtitlesSettings } from '../src/tool.ts'
import type { RulesShot, RulesShotResult, SubtitleRules } from '../src/types.ts'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

/** Settings with test-sized limits. */
export const settings: EpisodeSubtitlesSettings = { ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', packSeconds: 600, gapSeconds: 0.8,
  maxEpisodes: 100, reviewPageSize: 20, commandTimeoutMs: 10_000, maxDurationSeconds: 18_000, maxAudioBytes: 100_000_000,
  pollIntervalMs: 1000, uploadRetryBudgetMs: 0, maxBatchInputs: 10, lockWaitMs: 10_000, jingliuJobWaitMs: 0 }

/** Fake video: a text file whose duration the fake ffprobe reports. */
function videoBytes(seconds: number, tag: string): string { return `VIDEO:${String(seconds)}:${tag}` }

/** Fake speech: raw 16 kHz PCM bytes, distinct per tag. */
function audioBytes(seconds: number, tag: string): Buffer {
  const bytes = Buffer.alloc(Math.round(seconds * 16_000) * 2)
  bytes.write(tag, 0, 'utf8')
  return bytes
}

/** ffprobe replacement that reads the fake video header. */
export const toolkit: MediaToolkit = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: { run: async (_command, args) => {
  const text = await readFile(args.at(-1)!, 'utf8')
  const seconds = Number(text.split(':')[1])
  return { code: 0, stderr: '', stdout: JSON.stringify({ format: { duration: String(seconds) },
    streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }] }) }
} } }

/** Recognized words per shot, in shot-local seconds. */
export type Script = Map<string, readonly { start: number; end: number; text: string }[]>

/** A scripted gateway: every submitted pack completes when `complete()` is called. */
export function gateway(project: string, script: Script) {
  const jobs = new Map<string, { status: MuseAsrJob['status']; members: string[]; segments: MuseAsrSegment[] }>()
  const submits: string[][] = []
  const account: AudioAccount = {
    status: async () => ({ state: 'signed-in', username: 'alice', verified: false }),
    submitAudio: async (_file, id, digest) => {
      const packs = join(project, 'transcript', 'packs')
      for (const name of (await readdir(packs)).filter(entry => entry.endsWith('.json'))) {
        const manifest = JSON.parse(await readFile(join(packs, name), 'utf8')) as {
          wav: string
          rate: number
          members: { audio_sha256: string; offset_samples: number }[]
        }
        const wav = await readFile(manifest.wav).catch(() => undefined)
        if (wav === undefined || sha(wav) !== digest) continue
        const segments = manifest.members.flatMap((member) => {
          const offset = member.offset_samples / manifest.rate
          const words = (script.get(member.audio_sha256) ?? [])
            .map(word => ({ ...word, start: word.start + offset, end: word.end + offset }))
          return words.length === 0 ? [] : [{ start: words[0]!.start, end: words.at(-1)!.end, text: words.map(word => word.text).join(''), words }]
        })
        jobs.set(id, { status: 'processing', members: manifest.members.map(member => member.audio_sha256), segments })
        submits.push(manifest.members.map(member => member.audio_sha256))
        return { id, status: 'processing' }
      }
      throw new Error('submitted audio is not a pack')
    },
    audioStatus: async (id) => {
      const job = jobs.get(id)
      if (job === undefined) return { id, status: 'processing' }
      return job.status === 'complete' ? { id, status: job.segments.length === 0 ? 'silent' : 'complete', ...(job.segments.length === 0 ? {} : { segments: job.segments }) }
        : { id, status: job.status }
    },
  }
  return { account, submits, complete: () => { for (const job of jobs.values()) job.status = 'complete' } }
}

/** Deterministic rules: one cue per segment, a `doubt` item for every word ending in 吗, decisions drop cues. */
export function fakeRules(): SubtitleRules & { calls: RulesShot[][] } {
  const calls: RulesShot[][] = []
  return { calls, digest: async () => 'f'.repeat(64), run: async (shots) => {
    calls.push([...shots])
    return shots.map((shot): RulesShotResult => {
      const items = shot.words.filter(word => word.text.endsWith('吗')).map((word) => {
        const id = sha(JSON.stringify([shot.audio_sha256, word.text, word.start])).slice(0, 12)
        const decision = shot.decisions.find(row => row.id === id)?.action ?? null
        return { id, kind: 'doubt', heard: word.text, script: shot.lines.join(''), start: word.start, end: word.end, decision }
      })
      const dropped = new Set(items.filter(item => item.decision === 'drop').map(item => item.start))
      const segs = new Map<number, { start: number; end: number; text: string }>()
      for (const word of shot.words) {
        if (dropped.has(word.start)) continue
        const cue = segs.get(word.seg)
        segs.set(word.seg, cue === undefined ? { start: word.start, end: word.end, text: word.text }
          : { ...cue, end: word.end, text: cue.text + word.text })
      }
      return { key: shot.key, cues: [...segs.values()], items, pending: items.filter(item => item.decision === null).length }
    })
  } }
}

/** Runner media replacements: the staged copy is the pack itself and its duration comes from its size. */
export const runnerMedia = {
  probe: async (file: string) => ((await stat(file)).size - 44) / 32_000,
  encode: async (source: string, target: string) => { await copyFile(source, target) },
}

/** Fake PCM extraction: fixture audio already holds raw samples. */
export async function extractPcm(source: string, target: string): Promise<void> { await copyFile(source, target) }

/** One project fixture with N packages in episode 1. */
export async function project(shots: number, seconds = 3) {
  const root = await mkdtemp(join(tmpdir(), 'muse-episode-subtitles-'))
  const lines = Array.from({ length: shots }, (_value, index) => `第${String(index + 1)}句台词`)
  const writePlan = async () => {
    const plan = { version: 1, episode: '01', video_tasks: lines.map((_line, index) => ({ shots: [index + 1] })),
      shots: lines.map((text, index) => ({ shot: index + 1, voice_type: 'dialogue', speaker: '林晨', text, characters: ['林晨'] })) }
    const bytes = JSON.stringify(plan, null, 2)
    await mkdir(join(root, 'episode_packages', '01'), { recursive: true })
    await writeFile(join(root, 'episode_packages', '01', 'package.json'), bytes)
    return sha(bytes)
  }
  const media = new Map<number, { video: string; audio: string; seconds: number }>()
  const approve = async (pack: number, planSha: string) => {
    const row = media.get(pack)!
    await mkdir(join(root, 'reviews'), { recursive: true })
    await writeFile(join(root, 'reviews', `ep01-p${String(pack).padStart(2, '0')}.json`), JSON.stringify({ status: 'approved', episode: '01',
      package: pack, package_sha256: planSha, video_path: row.video, video_sha256: sha(await readFile(join(root, row.video))),
      audio_path: row.audio, audio_sha256: sha(await readFile(join(root, row.audio))), subtitle_cleanup: 'not_required' }))
  }
  const setMedia = async (pack: number, video: { seconds: number; tag: string }, audio?: { seconds: number; tag: string }) => {
    const prior = media.get(pack)
    const row = { video: `media/01/p${String(pack)}-${video.tag}.mp4`, audio: prior?.audio ?? '', seconds: video.seconds }
    await mkdir(join(root, 'media', '01'), { recursive: true })
    await writeFile(join(root, row.video), videoBytes(video.seconds, video.tag))
    if (audio !== undefined) {
      row.audio = `media/01/p${String(pack)}-${audio.tag}.wav`
      await writeFile(join(root, row.audio), audioBytes(audio.seconds, audio.tag))
    }
    media.set(pack, row)
  }
  let planSha = await writePlan()
  for (let pack = 1; pack <= shots; pack++) {
    await setMedia(pack, { seconds, tag: `v${String(pack)}` }, { seconds, tag: `a${String(pack)}` })
    await approve(pack, planSha)
  }
  const audioSha = async (pack: number) => sha(await readFile(join(root, media.get(pack)!.audio)))
  const script: Script = new Map()
  const speak = async (pack: number, text: string) => {
    script.set(await audioSha(pack), Array.from(text, (char, index) => ({ start: 0.5 + index * 0.3, end: 0.75 + index * 0.3, text: char })))
  }
  for (let pack = 1; pack <= shots; pack++) await speak(pack, lines[pack - 1]!)
  return {
    root, lines, script, audioSha, speak,
    trim: async (pack: number, seconds: number) => { await setMedia(pack, { seconds, tag: `trim-${randomUUID().slice(0, 4)}` }); await approve(pack, planSha) },
    regenerate: async (pack: number, text: string, seconds = 3) => {
      const tag = randomUUID().slice(0, 4)
      await setMedia(pack, { seconds, tag: `v${tag}` }, { seconds, tag: `a${tag}` })
      await approve(pack, planSha)
      await speak(pack, text)
    },
    editLine: async (pack: number, text: string) => {
      lines[pack - 1] = text
      planSha = await writePlan()
      for (const key of media.keys()) await approve(key, planSha)
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/**
 * Services wired to the fixture.
 * @param account - Scripted gateway account.
 * @param rules - Rules under test.
 * @returns Services for `runEpisodeSubtitles`.
 */
export function services(account: AudioAccount, rules: SubtitleRules): EpisodeSubtitlesServices {
  return { account, rules, cwd: undefined, media: { runner: runnerMedia, extractPcm, toolkit } }
}
