/**
 * Per-shot transcripts keyed by audio digest, produced through packed cloud transcription.
 *
 * Every transcription goes through the `audio_transcribe` runner with purpose `subtitles`, so receipts, idempotency,
 * upload pacing and the never-resubmit rule are the runner's. Packs are content-named WAV files, so the runner's
 * path-keyed receipt reuse is exact for them. A pack with a receipt is only queried or resumed under its receipt;
 * a shot whose pack ended in failure or an uncertain state stays blocked and is never packed again.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { AudioAccount, AudioMediaOperations, AudioRunnerConfig, AudioRunResult, AudioUploadPacing }
  from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import { extractSpeechPcm, finishAudioTranscription, probeMediaDuration, readPublishedSegments, SPEECH_SAMPLE_RATE,
  speechWavHeader, startAudioTranscriptionBatch } from '@deepseek-ai/dsh-tool-audio-transcribe/runner'
import { planPacks, splitPack, type PackMember } from './asr-pack.ts'
import type { BlockReason, ShotTranscript } from './types.ts'

/** Lifecycle of one pack manifest. */
type PackStatus = 'staged' | 'pending' | 'complete' | 'silent' | 'failed' | 'uncertain'

/** `transcript/packs/<sha>.json`. */
interface PackManifest {
  readonly version: 1
  readonly sha256: string
  readonly rate: number
  readonly gap_samples: number
  readonly members: readonly PackMember[]
  readonly wav: string
  readonly receipt?: string
  readonly status: PackStatus
}

/** Settings and services of one transcription pass. */
export interface AsrDeps {
  readonly root: string
  readonly account: AudioAccount
  readonly runner: AudioRunnerConfig
  readonly pacing: AudioUploadPacing
  readonly pollIntervalMs: number
  readonly packSeconds: number
  readonly gapSeconds: number
  readonly maxBatchInputs: number
  /** Deterministic media replacements in tests; production uses FFmpeg. */
  readonly media?: {
    readonly runner?: AudioMediaOperations
    readonly extractPcm?: (source: string, target: string, signal?: AbortSignal) => Promise<void>
  }
}

/** Transcription state of one shot after this pass. */
export type ShotAsrState =
  | { readonly kind: 'ready'; readonly transcript: ShotTranscript; readonly sha256: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'blocked'; readonly reason: BlockReason }

/** Summary of one pass for the compact result. */
export interface AsrOutcome {
  readonly states: Map<string, ShotAsrState>
  /** Seconds of speech uploaded in new packs this call. */
  readonly newSeconds: number
  readonly pendingPacks: number
  readonly retryAfter?: number
}

/** One shot that needs a transcript. */
export interface AsrRequest {
  readonly audio_sha256: string
  readonly audio: string
}

const RESUMABLE = new Set(['upload_busy', 'request_rate', 'queue_full', 'provider_rate', 'server_draining',
  'server-unavailable', 'response-invalid'])

function dirs(root: string) {
  const transcript = join(root, 'transcript')
  return { shots: join(transcript, 'shots'), packs: join(transcript, 'packs'), pcm: join(transcript, 'packs', 'pcm') }
}

/**
 * Read a cached shot transcript.
 * @param root - Project root.
 * @param audioSha - Shot audio digest.
 * @returns The transcript and the digest of its file, or undefined on a cache miss.
 */
export async function readShotTranscript(root: string, audioSha: string):
Promise<{ transcript: ShotTranscript; sha256: string } | undefined> {
  let text: string
  try { text = await readFile(join(dirs(root).shots, `${audioSha}.json`), 'utf8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const transcript = JSON.parse(text) as Partial<Record<keyof ShotTranscript, unknown>>
  if (transcript.version !== 1 || transcript.audio_sha256 !== audioSha || !Array.isArray(transcript.words)) {
    throw new Error(`${join(dirs(root).shots, `${audioSha}.json`)}: 镜头转写缓存无效，请删除该文件后重跑。`)
  }
  return { transcript: transcript as ShotTranscript, sha256: createHash('sha256').update(text).digest('hex') }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600, dirMode: 0o700 })
}

async function loadPacks(root: string): Promise<PackManifest[]> {
  let names: string[]
  try { names = await readdir(dirs(root).packs) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const packs: PackManifest[] = []
  for (const name of names.filter(entry => /^[0-9a-f]{64}\.json$/u.test(entry)).sort()) {
    packs.push(JSON.parse(await readFile(join(dirs(root).packs, name), 'utf8')) as PackManifest)
  }
  return packs
}

function reasonOf(result: AudioRunResult | { readonly error: string }): BlockReason | 'pending' {
  if ('error' in result) return /Sign in/u.test(result.error) ? 'sign_in_required' : 'asr_error'
  if (result.error_code === 'sign-in-required') return 'sign_in_required'
  if (result.error_code === 'daily_quota') return 'daily_quota'
  if (result.status === 'failed') return 'asr_failed'
  if (result.status === 'uncertain' && result.recovery?.next_action === 'inspect_receipt') return 'asr_uncertain'
  if (result.error_code !== undefined && !RESUMABLE.has(result.error_code) && result.status !== 'complete'
    && result.status !== 'silent') return 'asr_error'
  return 'pending'
}

/**
 * Bring every requested shot to a cached transcript where the gateway allows it.
 * @param requests - Shots that miss the cache, in episode and shot order; duplicates are ignored.
 * @param deps - Runner settings, account and roots.
 * @param options - `allowNew` permits new packs; `waitMs` bounds polling of pending packs in this call.
 * @param signal - Owning call cancellation.
 * @returns Per-shot state and the pass summary.
 */
export async function transcribeShots(requests: readonly AsrRequest[], deps: AsrDeps,
  options: { readonly allowNew: boolean; readonly waitMs: number }, signal?: AbortSignal): Promise<AsrOutcome> {
  const states = new Map<string, ShotAsrState>()
  const wanted = new Map<string, string>()
  for (const request of requests) if (!wanted.has(request.audio_sha256)) wanted.set(request.audio_sha256, request.audio)
  const deadline = Date.now() + options.waitMs
  let newSeconds = 0, retryAfter: number | undefined
  const mediaRunner = deps.media?.runner
  const runnerProbe = mediaRunner?.probe.bind(mediaRunner)
    ?? ((file: string, probeSignal?: AbortSignal) => probeMediaDuration(file, deps.runner, probeSignal))

  const finishPack = async (pack: PackManifest, result: AudioRunResult | { readonly error: string }): Promise<PackManifest> => {
    if ('error' in result) {
      for (const member of pack.members) states.set(member.audio_sha256, { kind: 'blocked', reason: reasonOf(result) as BlockReason })
      return pack
    }
    let status: PackStatus = 'pending'
    if (result.status === 'complete' && result.output_json !== undefined) {
      const words = splitPack(await readPublishedSegments(result.output_json, signal), pack)
      for (const member of pack.members) {
        const own = words.get(member.audio_sha256) ?? { words: [], flags: [] }
        const transcript: ShotTranscript = { version: 1, audio_sha256: member.audio_sha256, samples: member.samples,
          pack: { sha256: pack.sha256, receipt: result.receipt, offset_samples: member.offset_samples },
          ...(result.service_version === undefined ? {} : { service_version: result.service_version }),
          silent: own.words.length === 0, words: own.words, flags: own.flags }
        await writeJson(join(dirs(deps.root).shots, `${member.audio_sha256}.json`), transcript)
      }
      status = 'complete'
    } else if (result.status === 'silent') {
      for (const member of pack.members) {
        await writeJson(join(dirs(deps.root).shots, `${member.audio_sha256}.json`), { version: 1, audio_sha256: member.audio_sha256,
          samples: member.samples, pack: { sha256: pack.sha256, receipt: result.receipt, offset_samples: member.offset_samples },
          silent: true, words: [], flags: [] } satisfies ShotTranscript)
      }
      status = 'silent'
    } else {
      const reason = reasonOf(result)
      if (reason === 'asr_failed') status = 'failed'
      else if (reason === 'asr_uncertain') status = 'uncertain'
      if (reason !== 'pending') {
        for (const member of pack.members) states.set(member.audio_sha256, { kind: 'blocked', reason })
      }
      const wait = result.retry_after_seconds ?? result.recovery?.retry_after
      if (wait !== undefined) retryAfter = Math.max(retryAfter ?? 0, wait)
    }
    const next = { ...pack, receipt: result.receipt, status }
    await writeJson(join(dirs(deps.root).packs, `${pack.sha256}.json`), next)
    if (status === 'complete' || status === 'silent') await rm(pack.wav, { force: true })
    return next
  }

  const start = async (packs: readonly PackManifest[]): Promise<PackManifest[]> => {
    const out: PackManifest[] = []
    for (let index = 0; index < packs.length; index += deps.maxBatchInputs) {
      const chunk = packs.slice(index, index + deps.maxBatchInputs)
      let batch
      try {
        batch = await startAudioTranscriptionBatch(deps.root, chunk.map(pack => pack.wav), 'zh', deps.account, deps.runner,
          deps.media?.runner, 'subtitles', signal, deps.pacing)
      } catch (error) {
        signal?.throwIfAborted()
        const failure = { error: error instanceof Error ? error.message : String(error) }
        for (const pack of packs.slice(index)) out.push(await finishPack(pack, failure))
        break
      }
      for (const pack of chunk) {
        const item = batch.items.find(row => row.input === pack.wav)
        out.push(item === undefined ? pack : await finishPack(pack, item))
      }
      if (batch.not_started !== undefined && batch.not_started.length > 0) {
        out.push(...packs.slice(index + deps.maxBatchInputs))
        break
      }
    }
    return out
  }

  const poll = async (pack: PackManifest): Promise<PackManifest> => {
    if (pack.receipt === undefined) return (await start([pack]))[0] ?? pack
    const waitMs = Math.max(0, Math.min(30_000, deadline - Date.now()))
    let result: AudioRunResult
    try {
      result = await finishAudioTranscription(deps.root, pack.receipt, deps.account, signal, true,
        { waitMs, pollIntervalMs: deps.pollIntervalMs, probe: runnerProbe }, deps.pacing)
    } catch (error) {
      signal?.throwIfAborted()
      return await finishPack(pack, { error: error instanceof Error ? error.message : String(error) })
    }
    return await finishPack(pack, result)
  }

  const known = new Map<string, PackManifest>()
  for (const pack of await loadPacks(deps.root)) for (const member of pack.members) known.set(member.audio_sha256, pack)
  const touched = new Set<string>()
  const settled = new Map<string, PackManifest>()
  for (const sha of wanted.keys()) {
    const pack = known.get(sha)
    if (pack === undefined || touched.has(pack.sha256)) continue
    touched.add(pack.sha256)
    // A finished pack is queried again only to republish a member transcript that is missing locally.
    settled.set(pack.sha256, pack.status === 'failed' || pack.status === 'uncertain' ? pack : await poll(pack))
  }

  const fresh = [...wanted.entries()].filter(([sha]) => !known.has(sha))
  if (fresh.length > 0 && options.allowNew) {
    const { pcm, packs } = dirs(deps.root)
    await mkdir(pcm, { recursive: true, mode: 0o700 })
    const measured: { audio_sha256: string; samples: number; file: string }[] = []
    for (const [sha, audio] of fresh) {
      const file = join(pcm, `${sha}.pcm`)
      const before = await stat(audio)
      if (deps.media?.extractPcm !== undefined) await deps.media.extractPcm(audio, file, signal)
      else await extractSpeechPcm(audio, file, deps.runner, signal)
      const after = await stat(audio)
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
        await rm(file, { force: true })
        states.set(sha, { kind: 'blocked', reason: 'media_changed' })
        continue
      }
      const samples = Math.floor((await stat(file)).size / 2)
      if (samples === 0) {
        await writeJson(join(dirs(deps.root).shots, `${sha}.json`), { version: 1, audio_sha256: sha, samples: 0,
          pack: { sha256: '', receipt: '', offset_samples: 0 }, silent: true, words: [], flags: [] } satisfies ShotTranscript)
        await rm(file, { force: true })
        continue
      }
      measured.push({ audio_sha256: sha, samples, file })
    }
    const rate = SPEECH_SAMPLE_RATE
    const plans = planPacks(measured, Math.round(deps.packSeconds * rate), Math.round(deps.gapSeconds * rate), rate)
    const created: PackManifest[] = []
    for (const plan of plans) {
      const wav = join(packs, `${plan.sha256}.wav`)
      await writePackWav(wav, plan.members, plan.gap_samples, measured)
      const manifest: PackManifest = { version: 1, sha256: plan.sha256, rate, gap_samples: plan.gap_samples,
        members: plan.members, wav, status: 'staged' }
      await writeJson(join(packs, `${plan.sha256}.json`), manifest)
      created.push(manifest)
      newSeconds += plan.members.reduce((total, member) => total + member.samples, 0) / rate
    }
    for (const file of measured) await rm(file.file, { force: true })
    for (const pack of await start(created)) {
      settled.set(pack.sha256, pack)
      for (const member of pack.members) known.set(member.audio_sha256, pack)
    }
  }

  let pendingPacks = 0
  for (const pack of settled.values()) if (pack.status === 'staged' || pack.status === 'pending') pendingPacks++
  for (const sha of wanted.keys()) {
    if (states.has(sha)) continue
    const cached = await readShotTranscript(deps.root, sha)
    if (cached !== undefined) { states.set(sha, { kind: 'ready', ...cached }); continue }
    const pack = known.get(sha)
    states.set(sha, pack?.status === 'failed' ? { kind: 'blocked', reason: 'asr_failed' }
      : pack?.status === 'uncertain' ? { kind: 'blocked', reason: 'asr_uncertain' } : { kind: 'pending' })
  }
  return { states, newSeconds: Math.round(newSeconds), pendingPacks,
    ...(retryAfter === undefined ? {} : { retryAfter }) }
}

async function writePackWav(target: string, members: readonly PackMember[], gapSamples: number,
  measured: readonly { audio_sha256: string; file: string }[]): Promise<void> {
  const dataBytes = members.reduce((total, member) => total + (member.samples + gapSamples) * 2, 0)
  const temporary = `${target}.${String(process.pid)}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.write(speechWavHeader(dataBytes))
    const silence = Buffer.alloc(gapSamples * 2)
    for (const member of members) {
      const source = measured.find(row => row.audio_sha256 === member.audio_sha256)
      if (source === undefined) throw new Error('Pack member PCM is missing')
      const pcm = await readFile(source.file)
      await handle.write(pcm.subarray(0, member.samples * 2))
      await handle.write(silence)
    }
  } finally { await handle.close() }
  await rename(temporary, target)
}
