/** Loader-mounted, keyless speech review uses real local files and the tool's closed output validation. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { validateJsonSchemaValue, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Renderer from '../src/index.ts'
import * as Speech from '../src/speech-coverage.ts'
import { buildReport, NO_MEDIA, NO_TAIL_FRAME } from '../src/report.ts'
import type { DramaRenderReport } from '../src/types.ts'

const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function assertReport(ctx: Context, value: unknown): asserts value is DramaRenderReport {
  const definition = ctx.tools.get('drama_render')
  if (definition === undefined) throw new Error('Loader did not register drama_render')
  const errors = validateJsonSchemaValue(definition.output.schema, value, '')
  if (errors.length !== 0) throw new Error(JSON.stringify(errors))
}

function readReport(ctx: Context, response: ToolExecutionResult): DramaRenderReport {
  if (response.isError) throw new Error(JSON.stringify(response.content))
  assertReport(ctx, response.value)
  return response.value
}

async function fixture(independentAudio = false) {
  const project = await mkdtemp(join(tmpdir(), 'muse-speech-loader-')), ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(project, { recursive: true, force: true }) })
  const video = join(project, 'selected.mp4'), audio = independentAudio ? join(project, 'dialogue.wav') : video
  await writeFile(video, 'synthetic-video-identity')
  if (independentAudio) await writeFile(audio, 'synthetic-independent-sound-identity')
  await mkdir(join(project, 'transcript', 'jobs'), { recursive: true })
  await mkdir(join(project, 'transcript', 'raw'))
  const receipt = join(project, 'transcript', 'jobs', 'selected-v1.json')
  await writeFile(receipt, JSON.stringify({ status: 'complete', source: audio, sourceSha256: digest(await readFile(audio)), stem: 'selected', version: 1 }))
  const raw = join(project, 'transcript', 'raw', 'selected-v1.json')
  await writeFile(raw, JSON.stringify([{ start: 6, end: 8, text: '做饭啦', words: [
    { text: '做', start: 6.670, end: 6.910 }, { text: '饭', start: 6.910, end: 7.150 }, { text: '啦', start: 7.4, end: 7.5 },
  ] }]))
  const subtitle = join(project, 'final.srt'), shots = join(project, 'shots.json')
  const timeline = join(project, 'timeline.json'), mapping = join(project, 'receipts.json')
  await writeFile(subtitle, '')
  await writeFile(shots, JSON.stringify({ shots: [{ shot: 1, video: 'selected.mp4', ...(independentAudio ? { audio: 'dialogue.wav' } : {}) }] }))
  await writeFile(timeline, JSON.stringify({ clips: [{ shot: 1, start_us: 33184000, duration_us: 10000000 }], body_end: 43.184 }))
  await writeFile(mapping, JSON.stringify({ shots: [{ shot: 1, receipt: 'transcript/jobs/selected-v1.json' }] }))
  const config = join(project, 'cordis.yml')
  await writeFile(config, '- id: prompt\n  name: fixture-prompt\n- id: tools\n  name: fixture-tools\n- id: renderer\n  name: fixture-renderer\n  config:\n    ffmpegPath: never-start-ffmpeg\n    ffprobePath: never-start-ffprobe\n')
  ctx.baseUrl = pathToFileURL(project).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['fixture-prompt', SystemPrompt], ['fixture-tools', Tools], ['fixture-renderer', Renderer]])
  ctx.loader.internal = { version: 'v2', loadCache: new Map(),
    register() { throw new Error('Unexpected loader hook') },
    getOrCreateModuleJob() { throw new Error('Unexpected loader job') },
    resolveSync() { throw new Error('Unexpected loader resolution') },
    load() { throw new Error('Unexpected loader load') },
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const args = { method: 'speech_coverage' as const, project, episode: 26, shots: 'shots.json', timeline: 'timeline.json',
    subtitle_srt: 'final.srt', speech_transcripts: 'receipts.json' }
  const invoke = (extra: Record<string, string> = {}) => ctx.tools.execute({ name: 'drama_render', arguments: { ...args, ...extra },
    callId: ToolCallId('local-speech-coverage'), signal: new AbortController().signal })
  return { project, ctx, args, invoke, subtitle, receipt, audio, video,
    files: [video, ...independentAudio ? [audio] : [], receipt, raw, subtitle, shots, timeline, mapping, config] }
}

it('returns short-word candidates through Loader and the registered closed-schema tool without writing or starting media', async () => {
  const f = await fixture(), before = await Promise.all(f.files.map(file => readFile(file)))
  expect('default' in Renderer).toBe(false)
  const response = await f.invoke()
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  const value = readReport(f.ctx, response)
  expect(value).toMatchObject({ method: 'speech_coverage', ok: true, written: [], output: '',
    speech_coverage: { assessment: 'asr_candidate_comparison', evidence_complete: true, listening_verified: false } })
  expect(value.speech_coverage?.findings.map(item => item.text)).toEqual(['做', '饭', '啦'])
  expect(value.speech_coverage?.words[0]).toMatchObject({ start_seconds: 39.854, end_seconds: 40.094 })
  expect(value.checks).toContainEqual(expect.objectContaining({ id: 'subtitle_speech_candidates', severity: 'warning', ok: false }))
  expect(value.not_checked).toContain('speech_alignment')
  expect(value.not_checked).toContain('embedded_subtitles')
  expect(await Promise.all(f.files.map(file => readFile(file)))).toEqual(before)
  const definition = f.ctx.tools.get('drama_render')
  if (definition === undefined) throw new Error('Loader did not register drama_render')
  expect(validateJsonSchemaValue(definition.output.schema, value, '')).toEqual([])
  expect(validateJsonSchemaValue(definition.output.schema, { ...value,
    speech_coverage: { ...value.speech_coverage, undeclared: true } }, '')).not.toEqual([])
  const entry = [...f.ctx.loader.entries()].find(row => row.options.id === 'renderer')
  if (entry?.fiber === undefined) throw new Error('Loader renderer entry missing')
  await entry.fiber.dispose()
  expect(f.ctx.tools.get('drama_render')).toBeUndefined()
})

it('uses explicitly selected independent audio rather than attributing the video bytes to the spoken words', async () => {
  const f = await fixture(true), response = await f.invoke()
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  const value = readReport(f.ctx, response)
  expect(value.clips[0]?.source).toBe(f.video)
  const sourcePath = value.speech_coverage?.sources[0]?.path
  if (sourcePath === undefined) throw new Error('Independent speech source is missing')
  expect(await realpath(sourcePath)).toBe(await realpath(f.audio))
  expect(await realpath(sourcePath)).not.toBe(await realpath(f.video))
  expect(value.speech_coverage?.evidence_complete).toBe(true)
})

it('retains valid current listening statements in the registered output without certifying the sound', async () => {
  const f = await fixture(), first = await f.invoke()
  expect(first.isError, JSON.stringify(first.content)).not.toBe(true)
  const initial = readReport(f.ctx, first).speech_coverage
  if (initial === undefined) throw new Error('Missing speech evidence')
  const item = initial.findings[0]
  if (item === undefined) throw new Error('Synthetic missing word did not produce a finding')
  await writeFile(join(f.project, 'listening.json'), JSON.stringify({ schema_version: 1, evidence_sha256: initial.evidence_sha256,
    decisions: [{ item_id: item.id, decision: 'unresolved', reason: '尚未核听；不把ASR当真声', observed_text: '',
      reviewed_start_seconds: item.start_seconds, reviewed_end_seconds: item.end_seconds }] }))
  const response = await f.invoke({ speech_decisions: 'listening.json' })
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  const reviewed = readReport(f.ctx, response).speech_coverage
  expect(reviewed?.findings[0]?.review).toMatchObject({ decision: 'unresolved', reason: '尚未核听；不把ASR当真声' })
  expect(reviewed?.listening_verified).toBe(false)
})

it('copies immutable review collections only at the tool output without mutating the internal report', async () => {
  const f = await fixture()
  await writeFile(f.subtitle, '1\n00:00:39,854 --> 00:00:40,094\n做\n')
  const response = await f.invoke()
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  const value = readReport(f.ctx, response).speech_coverage
  if (value === undefined) throw new Error('Missing review for output-copy regression')
  const frozen: Speech.SpeechCoverageReport = Object.freeze({ ...value,
    sources: Object.freeze(value.sources.map(source => Object.freeze({ ...source }))),
    words: Object.freeze(value.words.map(word => Object.freeze({ ...word }))),
    matches: Object.freeze(value.matches.map(match => Object.freeze({ ...match }))),
    findings: Object.freeze(value.findings.map(finding => Object.freeze({ ...finding,
      word_ids: Object.freeze([...finding.word_ids]), cue_indexes: Object.freeze([...finding.cue_indexes]),
      review: Object.freeze({ decision: 'unresolved' as const, reason: 'synthetic caller statement; no acoustic approval', observed_text: '',
        reviewed_start_seconds: finding.start_seconds, reviewed_end_seconds: finding.end_seconds }) }))),
    warnings: Object.freeze([...value.warnings]) })
  // This unit isolates the output-copy step; the other Loader cases keep the real local review implementation.
  const spy = vi.spyOn(Speech, 'reviewSpeechCoverage').mockResolvedValueOnce(frozen)
  try {
    const copied = await f.invoke()
    expect(copied.isError, JSON.stringify(copied.content)).not.toBe(true)
    const returned = readReport(f.ctx, copied).speech_coverage
    if (returned === undefined) throw new Error('Tool omitted the copied speech review')
    expect(returned).toEqual(frozen)
    for (const field of ['sources', 'words', 'matches', 'findings', 'warnings'] as const) expect(returned[field]).not.toBe(frozen[field])
    expect(returned.sources[0]).not.toBe(frozen.sources[0])
    expect(returned.words[0]).not.toBe(frozen.words[0])
    expect(returned.matches[0]).not.toBe(frozen.matches[0])
    expect(returned.findings[0]?.word_ids).not.toBe(frozen.findings[0]?.word_ids)
    expect(returned.findings[0]?.cue_indexes).not.toBe(frozen.findings[0]?.cue_indexes)
    expect(returned.findings[0]?.review).not.toBe(frozen.findings[0]?.review)
    expect(Object.isFrozen(frozen.findings[0]?.word_ids)).toBe(true)
  } finally { spy.mockRestore() }
})

it('keeps old report fields unchanged and does not add an empty speech section to earlier operations', async () => {
  const f = await fixture(), definition = f.ctx.tools.get('drama_render')
  if (definition === undefined) throw new Error('Missing renderer registration')
  const legacy = buildReport({ method: 'prepare', project: f.project, episode: '26', timeline: { clips: [], bodyEndSeconds: 0 },
    sources: new Map(), expectedDurationSeconds: 0, written: [], output: '', encoder: '', gpuRequested: false, gpuUsed: false,
    encoderFallbackReason: '', encodedShots: [], reusedShots: [], tailFrame: NO_TAIL_FRAME, media: NO_MEDIA, checks: [], warnings: [], logPath: '' })
  expect(legacy).not.toHaveProperty('speech_coverage')
  expect(validateJsonSchemaValue(definition.output.schema, legacy, '')).toEqual([])
})

it('reports missing source evidence as advisory rather than false acoustic success', async () => {
  const f = await fixture()
  await writeFile(f.audio, 'changed-source')
  const response = await f.invoke()
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  expect(response.value).toMatchObject({ ok: true, speech_coverage: { evidence_complete: false, listening_verified: false } })
})

it('requires the explicit local comparison inputs and rejects unrelated overlay decisions', () => {
  const base = { method: 'speech_coverage' as const, project: '.', episode: 1, shots: 'shots.json', timeline: 'timeline.json',
    subtitleSrt: 'final.srt', speechTranscripts: 'receipts.json' }
  for (const [field, label] of [['shots', 'shots'], ['timeline', 'timeline'], ['subtitleSrt', 'subtitle_srt'], ['speechTranscripts', 'speech_transcripts']] as const) {
    const { [field]: omitted, ...args } = base
    expect(omitted).toBeDefined()
    expect(() => Renderer.resolveCall(args)).toThrow(`需要 ${label}`)
  }
  expect(() => Renderer.resolveCall({ ...base, subtitlePlan: 'overlay.json' })).toThrow('最终完整显示')
  expect(() => Renderer.resolveCall({ method: 'prepare', project: '.', episode: 1, speechTranscripts: 'map.json' })).toThrow('仅用于 speech_coverage')
  expect(() => Renderer.resolveCall({ method: 'prepare', project: '.', episode: 1, speechDecisions: 'decisions.json' })).toThrow('仅用于 speech_coverage')
})
