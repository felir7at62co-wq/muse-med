/** Source-bound Mandarin word timing from a verified on-device speech engine. */
import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import {
  command, digest, maxSourceBytes, offlineLibraryDigest, owned, sampleRate, verifiedSpeechRuntime,
  verifyPinnedSpeechModel, type OfflineSpeechConfig,
} from './pronunciation-runtime.ts'
import type { AudioRunnerConfig } from './runner.ts'

const model = {
  name: 'Systran/faster-whisper-small',
  revision: '536b0662742c02347bc0e980a01041f333bce120',
  sha256: '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
} as const

const modelFiles = {
  'model.bin': model.sha256,
  'config.json': 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',
  'tokenizer.json': 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',
  'vocabulary.txt': '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',
} as const

const audioFormats = new Map([
  ['.aac', 'aac'], ['.flac', 'flac'], ['.m4a', 'mov'], ['.mkv', 'matroska'], ['.mov', 'mov'],
  ['.mp3', 'mp3'], ['.mp4', 'mov'], ['.ogg', 'ogg'], ['.wav', 'wav'],
])

const pythonProgram = `
import importlib.metadata, json, os, sys
library, model_dir, pcm = sys.argv[1:]
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
def deny_network(event, args):
    if event.startswith("socket.") and event not in {"socket.__new__", "socket.gethostname"}:
        raise RuntimeError("Network is disabled for offline recognition")
sys.addaudithook(deny_network)
sys.path.insert(0, library)
versions = {d.metadata["Name"].lower().replace("_", "-"): d.version
            for d in importlib.metadata.distributions(path=[library])}
for name, version in {"faster-whisper": "1.2.1", "ctranslate2": "4.9.0", "onnxruntime": "1.32.0"}.items():
    if versions.get(name) != version:
        raise RuntimeError("Offline recognition dependency version differs")
import numpy as np
from faster_whisper import WhisperModel
os.chdir(model_dir)
model = WhisperModel(".", device="cpu", compute_type="int8", cpu_threads=1, num_workers=1,
                     local_files_only=True)
audio = np.fromfile(pcm, dtype="<i2").astype(np.float32) / 32768.0
segments, _ = model.transcribe(audio, language="zh", word_timestamps=True, beam_size=5,
                               vad_filter=True, no_speech_threshold=0.6, temperature=0,
                               condition_on_previous_text=False)
print(json.dumps([
    {"start": s.start, "end": s.end, "text": s.text,
     "words": [{"start": w.start, "end": w.end, "text": w.word} for w in (s.words or [])]}
    for s in segments
], allow_nan=False))
`

interface FileIdentity {
  readonly path: string
  readonly sha256: string
}

/** The successful tool body and the exact contents of its local receipt. */
export interface OfflineTranscript {
  readonly version: 1
  readonly kind: 'muse_offline_word_timing'
  readonly project: string
  readonly source: FileIdentity
  readonly transcript: FileIdentity
  readonly receipt: string
  readonly pcm: { readonly sha256: string; readonly sampleRate: 16000; readonly samples: number }
  readonly model: typeof model
  readonly recognition?: 'no_reliable_words'
  readonly listening_verified: false
}

const stringField = { type: 'string', required: true } as const
const fileIdentity = { type: 'object', required: true, additionalProperties: false, properties: {
  path: stringField, sha256: stringField,
} } as const

/** Registered tool result schema for an advisory timing receipt. */
export const offlineResult = { type: 'object', additionalProperties: false, properties: {
  offline_transcript: { type: 'object', required: true, additionalProperties: false, properties: {
    version: { type: 'number', enum: [1], required: true },
    kind: { type: 'string', enum: ['muse_offline_word_timing'], required: true },
    project: stringField,
    source: fileIdentity,
    transcript: fileIdentity,
    receipt: stringField,
    pcm: { type: 'object', required: true, additionalProperties: false, properties: {
      sha256: stringField, sampleRate: { type: 'number', enum: [16000], required: true },
      samples: { type: 'integer', required: true },
    } },
    model: { type: 'object', required: true, additionalProperties: false, properties: {
      name: stringField, revision: stringField, sha256: stringField,
    } },
    recognition: { type: 'string', enum: ['no_reliable_words'], description: '未识别到可用词时，不确认静音。' },
    listening_verified: { type: 'boolean', enum: [false], required: true },
  } },
} } as const

interface Word {
  readonly start: number
  readonly end: number
  readonly text: string
}

interface Segment extends Word {
  readonly words: readonly Word[]
}

const invalidTimes = 'OFFLINE_ASR_INFERENCE: Invalid engine word or segment bounds.'
const lexicalWord = /[\p{L}\p{N}]/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function span(value: unknown, duration: number): Word {
  if (!record(value) || typeof value.start !== 'number' || !Number.isFinite(value.start)
    || typeof value.end !== 'number' || !Number.isFinite(value.end) || value.start < 0 || value.end < value.start
    || value.end > duration || typeof value.text !== 'string' || !value.text.trim()) throw new Error(invalidTimes)
  return { start: value.start, end: value.end, text: value.text }
}

/** Retain the engine's timed words on the measured, zero-based PCM clock.
 * @param raw - One complete local engine response.
 * @param duration - Sample-derived duration of the decoded audio.
 * @returns The original timed segments, or an empty array when no reliable word was found.
 */
export function offlineWordSpans(raw: string, duration: number): Segment[] {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('OFFLINE_ASR_INFERENCE: Invalid engine result.') }
  if (!Array.isArray(value)) throw new Error('OFFLINE_ASR_INFERENCE: Invalid engine result.')
  let previousEnd = 0
  const segments = value.map((segment: unknown) => {
    const current = span(segment, duration)
    if (current.end === current.start || !record(segment) || !Array.isArray(segment.words) || segment.words.length === 0) {
      throw new Error(invalidTimes)
    }
    const words = segment.words.map((value: unknown) => {
      const word = span(value, duration)
      if (word.end === word.start) {
        throw new Error('OFFLINE_ASR_WORD_TIME: A word has no measured time span. Use the original audio with more context and recheck.')
      }
      if (word.start < previousEnd || word.start < current.start || word.end > current.end) throw new Error(invalidTimes)
      previousEnd = word.end
      return word
    })
    return { ...current, words }
  })
  return segments.some(segment => segment.words.some(word => lexicalWord.test(word.text))) ? segments : []
}

async function subdir(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if (!record(error) || error.code !== 'EEXIST') throw error }
  return owned(path, true, parent)
}

/**
 * Decode one project-owned file and publish its words and receipt in a fresh directory.
 * @param workspace - Actual calling Session workspace.
 * @param projectPath - Absolute project root.
 * @param input - One project-contained audio or video.
 * @param config - Deployment-owned media executable and bounds.
 * @param runtime - Pinned on-device model assets.
 * @param signal - Cancellation for this analysis.
 * @returns Exact timing evidence for the decoded source, without a content verdict.
 */
export async function transcribeOffline(workspace: string, projectPath: string, input: string, config: AudioRunnerConfig,
  runtime: OfflineSpeechConfig, signal: AbortSignal): Promise<OfflineTranscript> {
  signal.throwIfAborted()
  const project = await owned(projectPath, true, await realpath(workspace))
  const source = await owned(resolve(project, input), false, project)
  const format = audioFormats.get(extname(source).toLowerCase())
  if (format === undefined) throw new Error('OFFLINE_ASR_MEDIA: Select a local MP4, MOV, MKV, WAV, M4A, MP3, AAC, FLAC or OGG file.')
  const { size: sourceSize } = await lstat(source)
  if (sourceSize === 0 || sourceSize > maxSourceBytes) throw new Error('OFFLINE_ASR_MEDIA: Local input is empty or exceeds 512 MiB.')
  let assets: Awaited<ReturnType<typeof verifiedSpeechRuntime>>
  try { assets = await verifiedSpeechRuntime(runtime, modelFiles, signal) }
  catch {
    signal.throwIfAborted()
    throw new Error('OFFLINE_ASR_UNAVAILABLE: The configured local engine, dependencies or pinned model could not be verified.')
  }
  const sourceSha = await digest(source, signal)
  const parent = await subdir(await subdir(project, 'transcript'), 'offline')
  const directory = await mkdtemp(join(parent, 'local-'))
  const pcm = join(directory, 'audio.pcm')
  const words = join(directory, 'words.json')
  const receipt = join(directory, 'receipt.json')
  const pendingReceipt = join(directory, '.pending-receipt')
  let published = false
  try {
    const maxSeconds = Math.min(config.maxDurationSeconds, 120)
    await command(config.ffmpegPath, ['-nostdin', '-v', 'error', '-xerror', '-n', '-protocol_whitelist', 'file,pipe',
      '-f', format, ...(format === 'mov' ? ['-enable_drefs', '0'] : []), '-i', source, '-map', '0:a:0', '-vn',
      '-t', String(maxSeconds + 0.25), '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 's16le', pcm],
    'OFFLINE_ASR_MEDIA', config.commandTimeoutMs, signal)
    const { size } = await lstat(pcm)
    if (size === 0 || size % 2 !== 0 || size > Math.min(config.maxAudioBytes, maxSeconds * sampleRate * 2)) {
      throw new Error('OFFLINE_ASR_MEDIA: Missing audio or audio exceeds the local duration or size limit.')
    }
    const samples = size / 2
    const pcmSha = await digest(pcm, signal)
    const raw = await command(assets.python, ['-I', '-B', '-c', pythonProgram, assets.library, assets.models, pcm],
      'OFFLINE_ASR_INFERENCE', config.commandTimeoutMs, signal)
    const segments = offlineWordSpans(raw, samples / sampleRate)
    if ((await lstat(await owned(source, false, project))).size !== sourceSize
      || await digest(source, signal) !== sourceSha || await digest(pcm, signal) !== pcmSha) {
      throw new Error('OFFLINE_ASR_CHANGED: Source or decoded audio changed during recognition.')
    }
    try {
      await verifyPinnedSpeechModel(assets.models, modelFiles, signal)
      if (await offlineLibraryDigest(assets.library, signal) !== runtime.librarySha256) throw new Error('Dependency digest differs')
    } catch {
      signal.throwIfAborted()
      throw new Error('OFFLINE_ASR_CHANGED: The local model or dependencies changed during recognition.')
    }
    const bytes = JSON.stringify(segments, null, 2) + '\n'
    const result: OfflineTranscript = { version: 1, kind: 'muse_offline_word_timing', project,
      source: { path: source, sha256: sourceSha },
      transcript: { path: words, sha256: createHash('sha256').update(bytes).digest('hex') },
      receipt, pcm: { sha256: pcmSha, sampleRate, samples }, model,
      ...(segments.length === 0 ? { recognition: 'no_reliable_words' } : {}), listening_verified: false }
    const writeOptions = { flag: 'wx', mode: 0o600, signal } as const
    await writeFile(words, bytes, writeOptions)
    await writeFile(pendingReceipt, JSON.stringify(result, null, 2) + '\n', writeOptions)
    signal.throwIfAborted()
    await link(pendingReceipt, receipt)
    published = true
    return result
  } finally {
    await rm(pcm, { force: true })
    await rm(pendingReceipt, { force: true })
    if (!published) {
      await rm(words, { force: true })
      await rmdir(directory)
    }
  }
}
