/** A renderer validates declared music plans before consuming their selected bed. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { checkMusicDecision, readBgmPlan } from '../src/bgm.ts'
import { cleanup, tempProject } from './harness.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => cleanup(root))) })

const segment = { track: 'track one', source: 'music.mp3', start_seconds: 0, end_seconds: 2 }
const episode = { episode: '01', body_duration_seconds: 4, segments: [segment] }

it.each([
  { document: '{invalid', message: '不可读' },
  { document: JSON.stringify({ episodes: [] }), message: '缺少第 01 集' },
  { document: JSON.stringify({ episodes: [episode, { ...episode, episode: '1' }] }), message: '集号重复或无效' },
  { document: JSON.stringify({ episodes: [{ ...episode, episode: 'invalid' }] }), message: '集号重复或无效' },
  { document: JSON.stringify({ episodes: [{ ...episode, body_duration_seconds: 6 }] }), message: '正文时长' },
  { document: JSON.stringify({ episodes: [{ ...episode, segments: [] }] }), message: '没有段落' },
  ...[
    { ...segment, track: ' ' }, { ...segment, source: '' },
    { ...segment, start_seconds: -1 }, { ...segment, end_seconds: 0 }, { ...segment, end_seconds: 5 },
  ].map(value => ({ document: JSON.stringify({ episodes: [{ ...episode, segments: [value] }] }), message: '段落须有曲目来源' })),
  { document: JSON.stringify({ episodes: [{ ...episode, segments: [
    { ...segment, start_seconds: 2, end_seconds: 3 }, segment,
  ] }] }), message: '按起点排序' },
])('retains and rejects an unusable declared plan: $message', async ({ document, message }) => {
  const project = await tempProject()
  roots.push(project)
  const plan = join(project, 'bgm.json')
  await writeFile(plan, document)
  await expect(readBgmPlan(plan, '01', 4, join(project, 'bed.mp3'), project)).rejects.toThrow(message)
  expect(await readFile(plan, 'utf8')).toBe(document)
})

const declaredLicense = { status: 'declared' as const, license: 'Project music grant', commercial_use: true,
  source: 'https://music.example/license', attribution: 'Music provider', scope: 'Short-drama distribution' }

it.each([
  { label: 'declared commercial rights', license_info: declaredLicense, status: 'declared', warnings: [] },
  { label: 'omitted rights', license_info: undefined, status: 'unknown',
    warnings: ['音乐授权信息未知或不完整；不能据此认定已获使用授权。'] },
  { label: 'commercial mismatch', license_info: { ...declaredLicense, commercial_use: false }, status: 'declared',
    warnings: ['曲目声明不允许商业使用，与本次商业用途不匹配。'] },
])('preserves $label as declared evidence without refusing the plan', async ({ license_info, status, warnings }) => {
  const project = await tempProject()
  roots.push(project)
  const plan = join(project, 'bgm.json')
  const bed = join(project, 'bed.mp3')
  await writeFile(bed, 'mixed bed')
  await writeFile(plan, JSON.stringify({ episodes: [{ ...episode, intended_use: 'commercial',
    segments: [{ ...segment, track_id: 'catalog-song', source_sha256: 'declared-source-digest', license_info }],
  }] }))
  const report = await readBgmPlan(plan, '01', 4, bed, project)
  expect(report.intended_use).toBe('commercial')
  expect(report.segments[0]).toMatchObject({ track_id: 'catalog-song', license_info: { status } })
  expect(report.license_records[0]).toMatchObject({ source: join(project, 'music.mp3'),
    source_sha256: 'declared-source-digest', track_id: 'catalog-song', license_info: { status }, warnings })
  expect(report.bed_sha256).toMatch(/^[a-f0-9]{64}$/)
})

it('reports unknown use and rights when no plan was read', async () => {
  const report = await readBgmPlan(undefined, '01', 4, 'missing-bed', 'missing-project')
  expect(report).toMatchObject({ intended_use: 'unknown', license_records: [], segments: [] })
})

it('keeps old plans usable while making omitted license facts explicit', async () => {
  const project = await tempProject()
  roots.push(project)
  const plan = join(project, 'bgm.json')
  const bed = join(project, 'bed.mp3')
  await writeFile(bed, 'mixed bed')
  await writeFile(plan, JSON.stringify({ episodes: [episode] }))
  const report = await readBgmPlan(plan, '01', 4, bed, project)
  expect(report.intended_use).toBe('unknown')
  expect(report.segments[0]?.license_info).toEqual({ status: 'unknown', license: 'unknown',
    commercial_use: 'unknown', source: 'unknown', attribution: 'unknown', scope: 'unknown' })
})

function composedMusic() {
  const project = resolve('composed-music-fixture'), sourceSha = 'a'.repeat(64), bedSha = 'b'.repeat(64)
  const selected = { ...segment, track_id: `sha256:${sourceSha}`, source_sha256: sourceSha }
  const plan = { ...episode, music_decision: 'music', decision_reason: 'Fits the present dialogue scene', segments: [selected] }
  return { project, episode: '01', bodyEnd: 4, planPath: join(project, 'bgm.json'),
    timelinePath: join(project, 'editing', '01-timeline.json'), planText: JSON.stringify({ episodes: [plan] }),
    mode: 'music' as const, gain: 0.1, bedSha,
    generationText: JSON.stringify({ method: 'compose', episode: '01', plan: 'bgm.json', timeline: 'editing/01-timeline.json',
      body_duration_seconds: 4, media: { sha256: bedSha }, segments: [{ ...selected, source_start_seconds: 0 }] }) }
}

it('accepts a bound composer receipt and rejects muted or unproved music inputs', () => {
  const input = composedMusic()
  expect(checkMusicDecision(input)).toEqual({ decision: 'music', reason: 'Fits the present dialogue scene' })
  for (const changed of [{ ...input, gain: 0 }, { ...input, bedSha: undefined }, { ...input, generationText: undefined }]) {
    expect(() => checkMusicDecision(changed)).toThrow('非零实际混音增益')
  }
})

it('rejects a composer receipt for different rendered bed bytes', () => {
  expect(() => checkMusicDecision({ ...composedMusic(), bedSha: 'c'.repeat(64) }))
    .toThrow('实际采用的 BGM 字节')
})

it('rejects a declared no-music plan that still contributes sound', () => {
  const input = composedMusic()
  const planText = JSON.stringify({ episodes: [{ ...episode, music_decision: 'none', decision_reason: 'Dialogue only', segments: [] }] })
  const none = { ...input, mode: 'none' as const, planText, gain: 0, bedSha: undefined }
  expect(checkMusicDecision(none)).toEqual({ decision: 'none', reason: 'Dialogue only' })
  expect(() => checkMusicDecision({ ...none, gain: 0.1 })).toThrow('必须使用 no_bgm')
  expect(() => checkMusicDecision({ ...none, bedSha: input.bedSha })).toThrow('必须使用 no_bgm')
  expect(() => checkMusicDecision({ ...none, planText: JSON.stringify({ episodes: [
    { ...episode, music_decision: 'none', decision_reason: 'Dialogue only' },
  ] }) })).toThrow('必须使用 no_bgm')
})

it('rejects an unreadable or incomplete composer receipt instead of accepting a declared music bed', () => {
  for (const generationText of ['{broken', '{}']) {
    expect(() => checkMusicDecision({ ...composedMusic(), generationText })).toThrow('合成收据不可读')
  }
})

it('reports a missing declared plan rather than silently switching to no music', async () => {
  const project = await tempProject()
  roots.push(project)
  await expect(readBgmPlan(join(project, 'missing.json'), '01', 4, join(project, 'bed.mp3'), project))
    .rejects.toThrow('BGM 计划不可读')
})
