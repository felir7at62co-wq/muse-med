/** Real media, the real Muse account client with a scripted gateway fetcher, and the bundled-rules Python. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MuseAccountService, MuseAsrClient, type MuseAccountStatus } from '@deepseek-ai/dsh-muse-account'
import { writeMuseSession } from '@deepseek-ai/dsh-muse-account/src/session.ts'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const ffmpeg = process.env.DSH_FFMPEG_PATH ?? 'ffmpeg'

function works(command: string, args: readonly string[]): boolean {
  try { return spawnSync(command, args, { stdio: 'ignore', timeout: 30_000 }).status === 0 }
  catch (error) { return error === undefined }
}

/** Interpreter with `pypinyin==0.55.0`, from `MUSE_SUBTITLE_RULES_PYTHON` or `python3`. */
export const rulesPython = [process.env.MUSE_SUBTITLE_RULES_PYTHON, 'python3'].find((python): python is string =>
  python !== undefined && works(python, ['-c', 'import importlib.metadata as m; assert m.version("pypinyin") == "0.55.0"']))
/** Whether real FFmpeg with libx264 can make fixture media. */
export const hasMedia = works(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:d=0.1',
  '-c:v', 'libx264', '-f', 'null', '-'])

/**
 * Write one short shot with embedded tone audio.
 * @param file - Destination MP4.
 * @param seconds - Duration.
 * @param frequency - Tone, which makes each shot's bytes distinct.
 * @returns When written.
 */
export function makeShot(file: string, seconds: number, frequency: number): void {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=160x284:r=30:d=${String(seconds)}`,
    '-f', 'lavfi', '-i', `sine=frequency=${String(frequency)}:sample_rate=48000:duration=${String(seconds)}`, '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file])
}

/**
 * Write one tone as a WAV file.
 * @param file - Destination WAV.
 * @param seconds - Duration.
 * @param frequency - Tone, which makes each file's bytes distinct.
 * @returns When written.
 */
export function makeTone(file: string, seconds: number, frequency: number): void {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${String(frequency)}:sample_rate=48000:duration=${String(seconds)}`, '-c:a', 'pcm_s16le', file])
}

/**
 * A local project whose packages are approved selections of real MP4 shots.
 * @param initial - Spoken script line of each package.
 * @param options - `separateAudio` gives each shot its own WAV sound beside the picture.
 * @returns The project root and edit helpers.
 */
export async function realProject(initial: readonly string[], options: { readonly separateAudio?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'muse-episode-subtitles-real-'))
  const lines = [...initial], videos: string[] = [], audios: (string | undefined)[] = []
  await mkdir(join(root, 'episode_packages', '01'), { recursive: true })
  await mkdir(join(root, 'media', '01'), { recursive: true })
  await mkdir(join(root, 'reviews'), { recursive: true })
  const approve = async () => {
    const plan = JSON.stringify({ version: 1, episode: '01', video_tasks: lines.map((_line, index) => ({ shots: [index + 1] })),
      shots: lines.map((text, index) => ({ shot: index + 1, voice_type: 'dialogue', speaker: '林晨', text, characters: ['林晨'] })) })
    await writeFile(join(root, 'episode_packages', '01', 'package.json'), plan)
    for (const [index, video] of videos.entries()) {
      const audio = audios[index]
      await writeFile(join(root, 'reviews', `ep01-p${String(index + 1).padStart(2, '0')}.json`), JSON.stringify({ status: 'approved', episode: '01',
        package: index + 1, package_sha256: sha(plan), video_path: video, video_sha256: sha(await readFile(join(root, video))),
        ...(audio === undefined ? {} : { audio_path: audio, audio_sha256: sha(await readFile(join(root, audio))) }),
        subtitle_cleanup: 'not_required' }))
    }
  }
  let generation = 0
  const shoot = (index: number, seconds: number, frequency: number, sound: boolean) => {
    generation++
    const video = `media/01/p${String(index + 1)}-g${String(generation)}.mp4`
    makeShot(join(root, video), seconds, frequency)
    videos[index] = video
    if (sound && options.separateAudio === true) {
      const audio = `media/01/p${String(index + 1)}-g${String(generation)}.wav`
      makeTone(join(root, audio), 2, frequency + 7)
      audios[index] = audio
    }
  }
  for (const [index] of lines.entries()) shoot(index, 2, 300 + index * 100, true)
  await approve()
  return { root, audioSha: async (index: number) => sha(await readFile(join(root, audios[index] ?? videos[index] ?? ''))),
    editLine: async (index: number, text: string) => { lines[index] = text; await approve() },
    /** Re-export the picture shorter; a separate sound stays the same file. */
    trim: async (index: number, seconds: number) => { shoot(index, seconds, 300 + index * 100, false); await approve() },
    /** Replace picture and sound with a new take. */
    regenerate: async (index: number, frequency: number) => { shoot(index, 2, frequency, true); await approve() } }
}

/**
 * A Muse account plugin whose cloud transcription is a scripted gateway behind the real client.
 * @param root - Project whose pack manifests identify submitted audio.
 * @param words - Recognized words per shot audio digest, in shot seconds.
 * @returns The plugin and gateway controls.
 */
export async function scriptedAccount(root: string, words: Map<string, readonly { start: number; end: number; text: string }[]>) {
  const sessionFile = join(root, '.account.json')
  await writeMuseSession(sessionFile, { baseUrl: 'https://muse.test', cookie: '__Host-muse=fixture', username: 'alice' })
  const jobs = new Map<string, { complete: boolean; segments: unknown[] }>()
  const submits: string[][] = []
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (init?.method === 'POST' && url.pathname === '/api/asr/jobs') {
      const headers = new Headers(init.headers), id = headers.get('idempotency-key')!
      const receipts = join(root, 'transcript', 'jobs'), packs = join(root, 'transcript', 'packs')
      let source: string | undefined
      for (const name of (await readdir(receipts)).filter(entry => entry.endsWith('.json'))) {
        const receipt = JSON.parse(await readFile(join(receipts, name), 'utf8')) as { id: string; source: string }
        if (receipt.id === id) source = receipt.source
      }
      for (const name of (await readdir(packs)).filter(entry => entry.endsWith('.json'))) {
        const pack = JSON.parse(await readFile(join(packs, name), 'utf8')) as { wav: string; rate: number; members: { audio_sha256: string; offset_samples: number }[] }
        if (pack.wav !== source) continue
        submits.push(pack.members.map(member => member.audio_sha256))
        jobs.set(id, { complete: false, segments: pack.members.flatMap((member) => {
          const offset = member.offset_samples / pack.rate
          const own = (words.get(member.audio_sha256) ?? []).map(word => ({ ...word, start: word.start + offset, end: word.end + offset }))
          return own.length === 0 ? [] : [{ start: own[0]!.start, end: own.at(-1)!.end, text: own.map(word => word.text).join(''), words: own }]
        }) })
        return Response.json({ id, status: 'processing', purpose: 'subtitles', service_version: 'flash' })
      }
      return Response.json({ error: 'unknown audio' }, { status: 400 })
    }
    const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
    const job = jobs.get(id)
    if (job === undefined) return new Response('{}', { status: 404 })
    return Response.json(job.complete ? { id, status: 'complete', purpose: 'subtitles', service_version: 'flash', segments: job.segments }
      : { id, status: 'processing', purpose: 'subtitles', service_version: 'flash' })
  }
  const client = new MuseAsrClient({ baseUrl: 'https://muse.test', sessionFile, requestTimeoutMs: 30_000, fetcher })
  const status = async (): Promise<MuseAccountStatus> => ({ state: 'signed-in', username: 'alice', verified: false })
  const plugin = { name: `fixture-account-${randomUUID()}`, async apply(context: Context) {
    await context.plugin(MuseAccountService, { controller: { status, logout: status,
      details: async () => { throw new Error('unused fixture details') }, login: async () => { throw new Error('unused fixture login') } },
    asr: client })
  } }
  return { plugin, submits, complete: () => { for (const job of jobs.values()) job.complete = true } }
}
