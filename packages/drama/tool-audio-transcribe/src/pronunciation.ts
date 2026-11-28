/** Pinned Mandarin pinyin recognition for short, explicitly selected phrase windows. */
import { lstat, mkdtemp, readFile, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { command, digest, maxSourceBytes, offlineLibraryDigest, owned, sampleRate,
  verifiedSpeechRuntime, verifyPinnedSpeechModel, type OfflineSpeechConfig } from './pronunciation-runtime.ts'
import { pronunciationProgram } from './pronunciation-program.ts'
import type { AudioRunnerConfig } from './runner.ts'

/** Trusted host assets and minimum separation for the pilot comparison. */
export interface PronunciationConfig extends OfflineSpeechConfig {
  readonly minimumMargin?: number
}

type Window = { readonly start: number; readonly end: number }
/** Model-provided reference phrase and overlapping windows on one source clock. */
export interface PronunciationRequest {
  readonly tokens: readonly string[]
  readonly target_index: number
  readonly alternative: string
  readonly windows: readonly Window[]
}

const model = { name: 'robinsonphan/sensevoice-small-zh-pinyin-dual-ctc', revision: '884e70660b97f9c242f1d77c8516aea62a8fdf29',
  sha256: 'ed3c7db2468b99fd3811578fff6000c990875c22b1e93abcd08f9c05bc61a93a' } as const
const modelFiles = {
  'sensevoice_dual_int8.onnx': model.sha256,
  'vocab_pinyin.json': '8f9060fab8b31dec4920132d9d2aebde3fa77b4d6ff815ef2d1e59cf4b3d2ddf',
  'am.mvn': '29b3c740a2c0cfc6b308126d31d7f265fa2be74f3bb095cd2f143ea970896ae5',
} as const
const maxWindowSeconds = 8
const frameSeconds = .06
const pilotMinimumMargin = 8
const tokenPattern = /^[a-z]{1,8}[1-5]$/u
const statuses = ['uncertain', 'matching_in_windows', 'suspected_mismatch'] as const
type Status = typeof statuses[number]
type WindowResult = Window & {
  readonly pcm: { readonly sha256: string; readonly sampleRate: 16000; readonly samples: number }
  readonly observed?: string
  readonly target_seconds?: number
  readonly alternative_minus_expected?: number
}

const authorizationNote = '仅供定位可疑读音，人工听校与交付验收需要单独记录。'

/** A local pronunciation comparison, scoped to a source fingerprint and exact windows. */
export interface OfflinePronunciationResult {
  readonly offline_pronunciation: {
    readonly version: 1
    readonly status: Status
    readonly project: string
    readonly source: { readonly path: string; readonly sha256: string }
    readonly model: typeof model
    readonly expected: string
    readonly alternative: string
    readonly target_index: number
    readonly minimum_margin: number
    readonly listening_verified: false
    readonly windows: WindowResult[]
    readonly note: string
  }
}

const number = { type: 'number', required: true } as const
const string = { type: 'string', required: true } as const
const windowProperties = { start: number, end: number } as const

export const pronunciationParameter = { type: 'object', additionalProperties: false,
  description: '仅供 pronunciation。给出完整普通话短句拼音、目标字位置和同一句的 2–3 个重叠时间窗。',
  properties: {
    tokens: { type: 'array', required: true, items: { type: 'string' }, description: '完整短句的带调拼音，例如 gu1 nai3 dai4 ding4。用数字 5 表示轻声。' },
    target_index: { ...number, description: '目标音节的下标，从 0 开始，两侧各有至少一个相邻音节。' },
    alternative: { ...string, description: '需排查的另一种带调读音，例如 zai4。' },
    windows: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: windowProperties },
      description: '同一句的 2–3 个不同范围，使用原文件秒数，每个 0.7–8 秒。' },
  } } as const

export const pronunciationResult = { type: 'object', additionalProperties: false, properties: {
  offline_pronunciation: { type: 'object', required: true, additionalProperties: false, properties: {
    version: { ...number, enum: [1] }, status: { ...string, enum: statuses }, project: string,
    evidence_id: { ...string, description: '本次成功检查的 UUID v4，供同一会话后续复验引用。' },
    source: { type: 'object', required: true, additionalProperties: false, properties: { path: string, sha256: string } },
    model: { type: 'object', required: true, additionalProperties: false, properties: { name: string, revision: string, sha256: string } },
    expected: string, alternative: string, target_index: number, minimum_margin: number, note: string,
    listening_verified: { type: 'boolean', enum: [false], required: true },
    windows: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      ...windowProperties, observed: { type: 'string' }, target_seconds: { type: 'number' }, alternative_minus_expected: { type: 'number' },
      pcm: { type: 'object', required: true, additionalProperties: false, properties: { sha256: string, sampleRate: number, samples: number } },
    } } },
  } },
} } as const

/** Require multiple distinct views of the same phrase and a target with both neighbors. */
export function validatePronunciationRequest(request: PronunciationRequest, maxSeconds: number): string {
  const { tokens, target_index, alternative, windows } = request
  const expected = tokens[target_index]
  if (tokens.length < 3 || tokens.length > 24 || !tokens.every(token => tokenPattern.test(token))
    || !Number.isSafeInteger(target_index) || target_index < 1 || target_index >= tokens.length - 1
    || !tokenPattern.test(alternative) || expected === undefined || expected === alternative) {
    throw new Error('OFFLINE_PRONUNCIATION_ARGS: Expected 3–24 tone-labelled syllables, an interior target and a different alternative.')
  }
  if (windows.length < 2 || windows.length > 3 || windows.some(({ start, end }) => !Number.isFinite(start)
    || !Number.isFinite(end) || start < 0 || end > maxSeconds || end - start < .7 - 1e-9 || end - start > maxWindowSeconds)
    || Math.min(...windows.map(window => window.end)) - Math.max(...windows.map(window => window.start)) < .5
    || windows.some((window, i) => windows.slice(i + 1)
      .some(other => Math.abs(window.start - other.start) + Math.abs(window.end - other.end) < frameSeconds - 1e-9))) {
    throw new Error('OFFLINE_PRONUNCIATION_ARGS: Expected two or three distinct 0.7–8 second windows covering the same phrase.')
  }
  return expected
}

type EngineResult = { readonly anchor: string; readonly frame: number; readonly margin: number }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseEngine(data: unknown, duration: number, expected: string, alternative: string): EngineResult | undefined {
  if (data === null) return undefined
  if (!object(data) || typeof data.anchor !== 'string' || (data.anchor !== expected && data.anchor !== alternative)
    || typeof data.frame !== 'number' || !Number.isSafeInteger(data.frame) || data.frame < 0
    || data.frame * frameSeconds + .0125 > duration || typeof data.margin !== 'number' || !Number.isFinite(data.margin)) {
    throw new Error('OFFLINE_PRONUNCIATION_INFERENCE: Invalid engine result.')
  }
  return { anchor: data.anchor, frame: data.frame, margin: data.margin }
}

/** Use the pilot margin only when two greedy phrase matches agree on the target sound and time. */
export function pronunciationStatus(windows: readonly Pick<WindowResult, 'observed' | 'target_seconds' | 'alternative_minus_expected'>[],
  expected: string, alternative: string, minimumMargin: number): Status {
  const observed = new Set(windows.map(window => window.observed).filter(Boolean))
  if (observed.size !== 1) return 'uncertain'
  const candidate = [...observed][0]
  if (candidate !== expected && candidate !== alternative) return 'uncertain'
  const direction = candidate === alternative ? 1 : -1
  if (windows.some(window => window.observed === candidate && window.alternative_minus_expected !== undefined
    && window.alternative_minus_expected * direction <= -minimumMargin)) return 'uncertain'
  const times = windows.flatMap(window => window.observed === candidate && window.target_seconds !== undefined
    && window.alternative_minus_expected !== undefined && window.alternative_minus_expected * direction >= minimumMargin
    ? [window.target_seconds] : [])
  if (times.length < 2) return 'uncertain'
  if (Math.max(...times) - Math.min(...times) > frameSeconds * 3 + 1e-9) return 'uncertain'
  return candidate === alternative ? 'suspected_mismatch' : 'matching_in_windows'
}

/** Inspect one registered local source. The output carries advisory evidence without changing media. */
export async function inspectPronunciation(workspace: string, projectPath: string, input: string, request: PronunciationRequest,
  config: AudioRunnerConfig, runtime: PronunciationConfig, signal: AbortSignal): Promise<OfflinePronunciationResult> {
  signal.throwIfAborted()
  const expected = validatePronunciationRequest(request, config.maxDurationSeconds)
  const minimumMargin = runtime.minimumMargin ?? pilotMinimumMargin
  const project = await owned(projectPath, true, await realpath(workspace))
  const source = await owned(resolve(project, input), false, project)
  const { size: sourceSize } = await lstat(source)
  if (sourceSize === 0 || sourceSize > maxSourceBytes) throw new Error('OFFLINE_PRONUNCIATION_MEDIA: Local input is empty or exceeds 512 MiB.')
  let assets: Awaited<ReturnType<typeof verifiedSpeechRuntime>>
  try {
    if (!Number.isFinite(minimumMargin) || minimumMargin < pilotMinimumMargin || minimumMargin > 50) throw new Error('Invalid pilot margin')
    assets = await verifiedSpeechRuntime(runtime, modelFiles, signal)
  } catch {
    signal.throwIfAborted()
    throw new Error('OFFLINE_PRONUNCIATION_UNAVAILABLE: Could not verify the provisioned local engine, dependencies or model.')
  }
  const symbols: unknown = JSON.parse(await readFile(join(assets.models, 'vocab_pinyin.json'), { encoding: 'utf8', signal }))
  if (!object(symbols)) throw new Error('OFFLINE_PRONUNCIATION_UNAVAILABLE: Invalid pinned syllable vocabulary.')
  const missingSyllables = [...new Set([...request.tokens, request.alternative])]
    .filter(token => !Object.hasOwn(symbols, token))
  if (missingSyllables.length) {
    throw new Error(`OFFLINE_PRONUNCIATION_ARGS: Pinned model lacks ${missingSyllables.join(', ')}. `
      + 'Keep the requested pronunciation pending. Changing its syllables would test a different reading.')
  }
  const sourceSha = await digest(source, signal)
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'muse-pronunciation-'))
  const requested = request.windows.map((window, i) => ({ window, path: join(directory, 'window-' + String(i) + '.pcm') }))
  try {
    const captures: { window: Window; path: string; pcm: WindowResult['pcm'] }[] = []
    const limit = Math.min(config.maxAudioBytes, maxWindowSeconds * sampleRate * 2)
    for (const { window, path: pcm } of requested) {
      const duration = window.end - window.start
      await command(config.ffmpegPath, ['-nostdin', '-v', 'error', '-n', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', 'mov,matroska,mp3,wav,flac,ogg,aac', '-ss', String(window.start), '-i', source, '-map', '0:a:0', '-vn',
        '-t', String(duration), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 's16le', pcm],
      'OFFLINE_PRONUNCIATION_MEDIA', config.commandTimeoutMs, signal)
      const { size } = await lstat(pcm)
      if (size % 2 || size > limit || Math.abs(size / 2 - Math.round(duration * sampleRate)) > 1) {
        throw new Error('OFFLINE_PRONUNCIATION_MEDIA: The selected source window is incomplete or exceeds the local size limit.')
      }
      captures.push({ window, path: pcm, pcm: { sha256: await digest(pcm, signal), sampleRate, samples: size / 2 } })
    }
    const raw = await command(assets.python, ['-I', '-B', '-c', pronunciationProgram, assets.library, assets.models,
      JSON.stringify([request.tokens, request.target_index, request.alternative]), ...captures.map(capture => capture.path)],
    'OFFLINE_PRONUNCIATION_INFERENCE', config.commandTimeoutMs, signal)
    let outputs: unknown
    try { outputs = JSON.parse(raw) } catch { throw new Error('OFFLINE_PRONUNCIATION_INFERENCE: Invalid engine result.') }
    if (!Array.isArray(outputs) || outputs.length !== captures.length) throw new Error('OFFLINE_PRONUNCIATION_INFERENCE: Invalid engine result.')
    const windows = captures.map(({ window, pcm }, i): WindowResult => {
      const result = parseEngine(outputs[i], pcm.samples / sampleRate, expected, request.alternative)
      return { ...window, pcm, ...(result === undefined ? {} : { observed: result.anchor,
        target_seconds: Math.round((window.start + result.frame * frameSeconds + .0125) * 1000) / 1000,
        alternative_minus_expected: result.margin }) }
    })
    if ((await lstat(await owned(source, false, project))).size !== sourceSize || await digest(source, signal) !== sourceSha) {
      throw new Error('OFFLINE_PRONUNCIATION_CHANGED: Source changed during inference.')
    }
    for (const { path, pcm } of captures) {
      if (await digest(path, signal) !== pcm.sha256) throw new Error('OFFLINE_PRONUNCIATION_CHANGED: Decoded audio changed during inference.')
    }
    try {
      await verifyPinnedSpeechModel(assets.models, modelFiles, signal)
      if (await offlineLibraryDigest(assets.library, signal) !== runtime.librarySha256) throw new Error('Dependency digest differs')
    } catch {
      signal.throwIfAborted()
      throw new Error('OFFLINE_PRONUNCIATION_CHANGED: Model or dependencies changed during inference.')
    }
    signal.throwIfAborted()
    return { offline_pronunciation: { version: 1, status: pronunciationStatus(windows, expected, request.alternative, minimumMargin),
      project, source: { path: source, sha256: sourceSha }, expected, alternative: request.alternative, target_index: request.target_index,
      model, windows, minimum_margin: minimumMargin, listening_verified: false, note: authorizationNote } }
  } finally {
    for (const { path } of requested) await rm(path, { force: true })
    await rmdir(directory)
  }
}
