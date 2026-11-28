/** Dispatch isolated listening reviews and keep their exact input and billing-attempt identity. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HarnessError, type AudioReviewProviderResponse, type AudioReviewTransport } from '@deepseek-ai/dsh-llm'
import type { ShotScriptVoiceParser } from '@deepseek-ai/dsh-tool-shot-script'
import { z } from 'zod'
import { requireProjectAudioFile } from './audio.ts'
import { parseContentListeningAssessment } from './content-listening-assessment.ts'
import { reconcileBlindDialogue } from './content-listening-blind.ts'
import { buildContentListeningRequest } from './content-listening-request.ts'
import { matchesListeningSourcePath, type ContentListeningProject } from './content-listening-source.ts'
import { voiceContextEvidence, type ContentListeningVoiceContext } from './content-listening-voices.ts'
import { fileSha256 } from './cache.ts'
import { SOURCE_RECORD_VERSION, sourceRecordPathFor } from './source-record.ts'
import type { MediaToolkit } from './types.ts'

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const maxReceiptBytes = 128 * 1024
const providerRequestId = z.string().regex(/^[\x21-\x7e]{1,256}$/u)
const tokenUsage = z.record(z.string(), z.number().int().nonnegative())
const attemptSchema = z.object({
  identity: sha256,
  episode: z.string().optional(),
  source_sha256: sha256,
  source_record_sha256: sha256,
  audio_sha256: sha256,
  provider: z.string().min(1),
  model: z.string().min(1),
  voice_context: voiceContextEvidence.optional(),
})
const providerReceiptSchema = z.strictObject({
  identity: sha256,
  provider: z.string().min(1),
  model: z.string().min(1),
  audio_hashes: z.array(sha256).min(1).max(4),
  received_at: z.iso.datetime(),
  provider_request_id: providerRequestId.optional(),
  token_usage: tokenUsage.optional(),
})
const attemptSourceSchema = z.object({
  version: z.literal(SOURCE_RECORD_VERSION), episode: z.string(),
  output: z.object({ path: z.string().min(1), sha256 }),
})
const preparationSchema = z.strictObject({
  status: z.literal('prepared_for_review'),
  listening_verified: z.literal(false),
  grants_approval: z.literal(false),
  source_path: z.string().min(1),
  source_sha256: sha256,
  source_record_sha256: sha256,
  wav_path: z.string().min(1),
  wav_sha256: sha256,
  pcm_sha256: sha256,
  duration_us: positive,
  sample_count: positive,
  sample_rate: z.literal(48000),
  channels: z.literal(2),
  receipt_path: z.string().min(1),
})

const storedReview = z.strictObject({
  identity: sha256,
  mode: z.literal('blind_dialogue').optional(),
  listening_verified: z.literal(false),
  grants_approval: z.literal(false),
  assessment: z.unknown(),
  dialogue_findings: z.unknown().optional(),
  voice_context: voiceContextEvidence.optional(),
  token_usage: tokenUsage.optional(),
  provider_request_id: providerRequestId.optional(),
})

/** Advisory review output. Unknown evidence always remains pending. */
export interface ContentListeningReview {
  readonly status: 'needs_review' | 'issues_found'
  readonly mode?: 'blind_dialogue'
  readonly listening_verified: false
  readonly grants_approval: false
  readonly source_sha256: string
  readonly audio_sha256: string
  readonly duration_us: number
  readonly provider: string
  readonly model: string
  readonly findings_count: number
  readonly voice_reference_count?: number
  readonly receipt_path: string
  readonly attempt_path: string
  readonly cost_status: 'pending_reconciliation'
}

function reviewError(code: string, message: string): HarnessError {
  return new HarnessError(message, code)
}

/**
 * Encode a candidate only if a later read can validate the entire receipt.
 * @param value - Candidate metadata and the advisory assessment to retain.
 * @returns The bounded JSON payload written to the candidate file.
 */
export function encodeListeningReceipt(value: unknown): string {
  const receipt = JSON.stringify(storedReview.parse(value)) + '\n'
  if (Buffer.byteLength(receipt, 'utf8') > maxReceiptBytes) {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校回执超过可读取的大小。')
  }
  return receipt
}

async function readBoundedBytes(path: string, limit: number): Promise<Buffer> {
  const details = await lstat(path)
  if (!details.isFile() || details.size <= 0 || details.size > limit) {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校需要有效且有大小上限的本次回执文件。')
  }
  const bytes = await readFile(path)
  if (bytes.byteLength > limit) throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校回执超过可读取的大小。')
  return bytes
}

async function readBounded(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse((await readBoundedBytes(path, maxReceiptBytes)).toString('utf8'))
  return parsed
}

async function readOptionalReceipt(path: string): Promise<unknown> {
  try {
    return await readBounded(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

type ContentListeningAttempt = {
  readonly status: 'candidate_available' | 'pending_provider' | 'response_received'
  readonly attempt_path: string
  readonly source_sha256: string
  readonly provider: string
  readonly model: string
  readonly candidate_path?: string
  readonly invalid_candidate?: true
  readonly provider_response_path?: string
  readonly provider_request_id?: string
  readonly token_usage?: z.infer<typeof tokenUsage>
  readonly cost_status: 'pending_reconciliation'
  readonly listening_verified: false
  readonly grants_approval: false
}

/**
 * Recover the original attempt for the same episode and exact render without calling a provider.
 * @param input - Project, rendered episode and a previously saved attempt receipt.
 * @returns The observed attempt status and verified receipt paths, if present.
 */
export async function readContentListeningAttempt(input: ContentListeningProject & {
  readonly episode: string
  readonly output: string
  readonly attemptPath: string
  readonly signal?: AbortSignal
}): Promise<ContentListeningAttempt> {
  input.signal?.throwIfAborted()
  const project = await realpath(input.project)
  const [attemptPath, output] = await Promise.all([
    requireProjectAudioFile(input.project, input.attemptPath), requireProjectAudioFile(input.project, input.output),
  ])
  const attempt = attemptSchema.parse(await readBounded(attemptPath))
  const directory = join(project, 'audio', 'content-listening-reviews', attempt.identity)
  if (basename(attemptPath) !== 'attempt.json' || relative(directory, dirname(attemptPath)) !== '') {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '请使用本项目实际保存的原听校尝试记录。')
  }
  const recordPath = await requireProjectAudioFile(project, sourceRecordPathFor(output))
  const [recordBytes, outputSha256] = await Promise.all([
    readBoundedBytes(recordPath, 8 * 1024 * 1024), fileSha256(output, input.signal),
  ])
  const record = attemptSourceSchema.parse(JSON.parse(recordBytes.toString('utf8')))
  const recordSha256 = createHash('sha256').update(recordBytes).digest('hex')
  if (record.episode !== input.episode || (attempt.episode !== undefined && input.episode !== attempt.episode)
    || !await matchesListeningSourcePath(input, output, record.output.path) || record.output.sha256 !== outputSha256
    || attempt.source_sha256 !== outputSha256 || attempt.source_record_sha256 !== recordSha256) {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校尝试对应其他集或其他成片版本。')
  }
  const candidatePath = join(directory, 'candidate.json')
  const providerPath = join(directory, 'provider-response.json')
  const [candidateValue, providerValue] = await Promise.all([
    readOptionalReceipt(candidatePath).catch(() => null), readOptionalReceipt(providerPath),
  ])
  const candidate = storedReview.safeParse(candidateValue)
  const available = candidate.success && candidate.data.identity === attempt.identity
  const receipt = providerValue === undefined ? undefined : providerReceiptSchema.parse(providerValue)
  const expectedHashes = [attempt.audio_sha256, ...(attempt.voice_context?.references.map(ref => ref.wav_sha256) ?? [])]
  if (receipt !== undefined && (receipt.identity !== attempt.identity || receipt.provider !== attempt.provider
    || receipt.model !== attempt.model
    || receipt.audio_hashes.length !== expectedHashes.length || receipt.audio_hashes.some((hash, i) => hash !== expectedHashes[i]))) {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校线路记录与本次尝试不匹配。')
  }
  input.signal?.throwIfAborted()
  const requestId = receipt?.provider_request_id ?? (available ? candidate.data.provider_request_id : undefined)
  const usage = receipt?.token_usage ?? (available ? candidate.data.token_usage : undefined)
  return {
    status: available ? 'candidate_available' : receipt === undefined ? 'pending_provider' : 'response_received',
    attempt_path: attemptPath, source_sha256: attempt.source_sha256,
    provider: attempt.provider, model: attempt.model,
    ...(available ? { candidate_path: candidatePath } : {}),
    ...(candidateValue !== undefined && !available ? { invalid_candidate: true } : {}),
    ...(receipt === undefined ? {} : { provider_response_path: providerPath }),
    ...(requestId === undefined ? {} : { provider_request_id: requestId }),
    ...(usage === undefined ? {} : { token_usage: usage }),
    cost_status: 'pending_reconciliation', listening_verified: false, grants_approval: false,
  } as const
}

function reviewGuidedAudio(durationUs: number, value: unknown, hasVoiceReferences: boolean) {
  const parsed = parseContentListeningAssessment(durationUs, value)
  const { ranges, assessments, findings } = parsed
  if (hasVoiceReferences || assessments.speaker.status !== 'ok') return parsed
  const reason = '缺少已核验的角色声音样本，无法由音频确认具体角色身份。'
  return parseContentListeningAssessment(durationUs, { ranges,
    assessments: { ...assessments, speaker: { status: 'uncertain', reason } },
    findings: [...findings, { axis: 'speaker', start_us: 0, end_us: durationUs, status: 'uncertain', reason }],
  })
}

/**
 * Review one prepared current MP4 through the explicit audio route.
 * @param input - Existing local preparation, actual displayed subtitles, original authored lines and a Host transport.
 * @returns A saved advisory assessment and its durable attempt identity.
 * @throws An unfinished request is kept for reconciliation. It does not trigger an automatic second provider request.
 */
export async function reviewContentListening(input: ContentListeningProject & {
  readonly toolkit: MediaToolkit
  readonly episode: string
  readonly output: string
  readonly subtitleSrt: string
  readonly authoredDialoguePath: string
  readonly preparationPath: string
  readonly mode?: 'blind_dialogue'
  readonly voiceContext?: ContentListeningVoiceContext
  readonly parseVoiceScript?: ShotScriptVoiceParser
  readonly transport?: AudioReviewTransport
  readonly signal?: AbortSignal
}): Promise<ContentListeningReview> {
  const { transport, signal } = input
  signal?.throwIfAborted()
  const routes = transport?.configuredRoutes() ?? []
  const route = routes[0]
  if (transport === undefined || route === undefined || routes.length !== 1) {
    throw reviewError('CONTENT_LISTENING_ROUTE_UNAVAILABLE', '整集自动听校需要一条明确配置的音频模型线路。请保留待听校状态。')
  }
  const project = await realpath(input.project)
  const [output, preparationPath] = await Promise.all([
    requireProjectAudioFile(input.project, input.output), requireProjectAudioFile(input.project, input.preparationPath),
  ])
  const preparation = preparationSchema.parse(await readBounded(preparationPath))
  if (relative(output, preparation.source_path) !== '' || relative(preparationPath, preparation.receipt_path) !== '') {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '请使用本次成片对应的试听准备回执。')
  }
  const request = await buildContentListeningRequest({ ...input, preparation })
  const blind = request.blindDialogue
  const voice = request.voice?.evidence
  const offeredWavs = [request.wav, ...(request.voice?.wav ?? [])]
  const offeredHashes = [request.wavSha256, ...(voice?.references.map(ref => ref.wav_sha256) ?? [])]
  const identity = createHash('sha256').update(JSON.stringify([
    blind !== undefined ? 'rendered-audio-blind-dialogue-v1'
      : voice === undefined ? 'rendered-audio-review-v1' : 'rendered-audio-review-v2',
    input.episode, preparation.source_sha256, preparation.source_record_sha256,
    request.wavSha256, request.subtitleSha256, request.authoredDialogueSha256,
    route.provider, route.model, request.prompt, ...(voice === undefined ? [] : [voice]),
  ])).digest('hex')
  const parent = join(project, 'audio', 'content-listening-reviews')
  await mkdir(parent, { recursive: true })
  if (relative(parent, await realpath(parent)) !== '') {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校结果目录发生重定向。')
  }
  const directory = join(parent, identity)
  const receiptPath = join(directory, 'candidate.json')
  const attemptPath = join(directory, 'attempt.json')
  try {
    await mkdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (relative(directory, await realpath(directory)) !== '') {
      throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '本次听校目录发生重定向。')
    }
    throw reviewError('CONTENT_LISTENING_REVIEW_PENDING',
      `同版听校已有本地记录。请用 review_status 核对原结果和费用，保留原尝试 ${attemptPath}`)
  }
  const assess = (response: unknown) => {
    if (blind !== undefined) {
      const review = reconcileBlindDialogue(preparation.duration_us, response, blind.lines)
      return { status: review.status, count: review.findings.length,
        assessment: review.observation, dialogueFindings: review.findings }
    }
    const { status, ranges, assessments, findings } = reviewGuidedAudio(preparation.duration_us, response, voice !== undefined)
    return { status, count: findings.length, assessment: { ranges, assessments, findings }, dialogueFindings: undefined }
  }
  try {
    signal?.throwIfAborted()
    await writeFile(attemptPath, JSON.stringify({
      identity, episode: input.episode, source_sha256: preparation.source_sha256, source_record_sha256: preparation.source_record_sha256,
      audio_sha256: request.wavSha256, duration_us: preparation.duration_us,
      audio_sample_rate: request.sampleRate, audio_sample_count: request.sampleCount,
      subtitle_sha256: request.subtitleSha256, authored_dialogue_sha256: request.authoredDialogueSha256,
      provider: route.provider, model: route.model, reserved_at: new Date().toISOString(),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(voice === undefined ? {} : { voice_context: voice }),
    }), { flag: 'wx', mode: 0o600 })
    signal?.throwIfAborted()
  } catch (error) {
    await rm(attemptPath, { force: true })
    await rmdir(directory)
    throw error
  }
  let savedResponse: Promise<void> | undefined
  const saveProviderResponse = (response: AudioReviewProviderResponse): Promise<void> => {
    if (response.provider !== route.provider || response.model !== route.model
      || response.audioSha256.length !== offeredHashes.length
      || offeredHashes.some((hash, index) => response.audioSha256[index] !== hash)) {
      throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校线路回执与本次实际音频不匹配。')
    }
    if (response.requestId === undefined && response.usage === undefined) return Promise.resolve()
    savedResponse ??= writeFileAtomic(join(directory, 'provider-response.json'), JSON.stringify(providerReceiptSchema.parse({
      identity, provider: route.provider, model: route.model, audio_hashes: offeredHashes, received_at: new Date().toISOString(),
      ...(response.requestId === undefined ? {} : { provider_request_id: response.requestId }),
      ...(response.usage === undefined ? {} : { token_usage: response.usage }),
    })) + '\n', { mode: 0o600 })
    return savedResponse
  }
  const actual = await transport.request({ ...route, wav: offeredWavs, prompt: request.prompt,
    onProviderResponse: saveProviderResponse,
    ...(signal === undefined ? {} : { signal }) }).catch(async (cause: unknown) => {
    await savedResponse?.catch(() => undefined)
    signal?.throwIfAborted()
    throw new HarnessError(`本次听校未得到可用结果。请用 review_status 核对原结果和费用，保留原尝试 ${attemptPath}`,
      'CONTENT_LISTENING_REVIEW_PENDING', { cause })
  })
  await saveProviderResponse(actual)
  const unchanged = await Promise.all(request.references.map(async ([path, hash]) => await fileSha256(path, signal) === hash))
  if (unchanged.includes(false)) {
    throw reviewError('CONTENT_LISTENING_REVIEW_INPUT', '听校期间成片或对照材料已改变。请先核对本次请求和费用。')
  }
  const report = assess(actual.response)
  const receipt = encodeListeningReceipt({ identity, listening_verified: false, grants_approval: false,
    assessment: report.assessment,
    ...(input.mode === undefined ? {} : { mode: input.mode, dialogue_findings: report.dialogueFindings }),
    ...(voice === undefined ? {} : { voice_context: voice }),
    ...(actual.usage === undefined ? {} : { token_usage: actual.usage }),
    ...(actual.requestId === undefined ? {} : { provider_request_id: actual.requestId }),
  })
  await writeFileAtomic(receiptPath, receipt, { mode: 0o600 })
  return { status: report.status, listening_verified: false, grants_approval: false,
    ...(input.mode === undefined ? {} : { mode: input.mode }),
    source_sha256: preparation.source_sha256, audio_sha256: request.wavSha256,
    duration_us: preparation.duration_us,
    provider: route.provider, model: route.model, findings_count: report.count,
    ...(voice === undefined ? {} : { voice_reference_count: voice.references.length }),
    receipt_path: receiptPath, attempt_path: attemptPath, cost_status: 'pending_reconciliation' }
}
