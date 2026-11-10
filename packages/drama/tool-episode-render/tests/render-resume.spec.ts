/** Resumable outputs retain their files and require current independent verification. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, parse, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileSha256 } from '../src/cache.ts'
import { createMediaToolkit } from '../src/ffmpeg.ts'
import { resolveSettings } from '../src/index.ts'
import { assertRenderResumeInputs, findRenderResumeCandidate, readRenderResumeFile, renderMusicStem,
  renderResumeRequest } from '../src/render-resume.ts'
import { buildSourceRecord, sourceRecordPathFor, writeSourceRecord, type DeliverySourceRecord } from '../src/source-record.ts'
import { cleanup, decodeHandler, probeHandler, srtDocument, stubChannel, tempProject, timelineJson,
  writePlaceholder, type StubHandler } from './harness.ts'

const mutation = vi.hoisted(() => ({ beforeHash: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('../src/cache.ts', async (load) => {
  const actual = await load<typeof import('../src/cache.ts')>()
  return { ...actual, fileSha256: async (path: string) => {
    await mutation.beforeHash?.(path)
    return actual.fileSha256(path)
  } }
})
const temporary: string[] = []
afterEach(async () => {
  mutation.beforeHash = undefined
  await Promise.all(temporary.splice(0).map(cleanup))
})

async function candidate(options: { stem?: boolean; beforeProbe?: () => Promise<void>; badGeometry?: boolean } = {}) {
  const project = await tempProject()
  temporary.push(project)
  const output = join(project, 'exports', '02.mp4')
  const timelinePath = join(project, 'editing', '02-timeline.json')
  const subtitleSrt = join(project, 'editing', '02.srt')
  const master = join(project, 'audio', '02.wav')
  await Promise.all([
    writePlaceholder(output, 'current delivered media'),
    writePlaceholder(timelinePath, timelineJson([{ shot: 1, startUs: 0, durationUs: 1_000_000 }], 1)),
    writePlaceholder(subtitleSrt, srtDocument([{ start: '00:00:00,100', end: '00:00:00,400', text: '台词' }])),
    writePlaceholder(master, 'current source audio'),
  ])
  const request = renderResumeRequest(await Promise.all([timelinePath, subtitleSrt, master].map(path => readRenderResumeFile(path))), [])
  const stem = renderMusicStem(output)
  if (options.stem) await writePlaceholder(stem, 'independent music')
  const receipt = sourceRecordPathFor(output)
  const record = buildSourceRecord({ episode: '02', output, outputSha256: await fileSha256(output),
    sizeBytes: (await readFile(output)).length, durationSeconds: 3, inputs: request.files.map(file => file.sha256 ?? ''),
    requestSha256: request.sha256, inputFiles: request.files,
    deliveryInputs: { timeline_sha256: await fileSha256(timelinePath), subtitle_sha256: await fileSha256(subtitleSrt),
      master_audio_sha256: await fileSha256(master), videos: [] },
    ...(options.stem ? { musicStemSha256: await fileSha256(stem) } : {}),
    encoder: 'libx264', checks: [], now: new Date('2026-11-06T00:00:00Z') })
  await writeSourceRecord(receipt, record)
  const probe = probeHandler({ [output]: { durationSeconds: 3, video: options.badGeometry ? { width: 1080 } : {}, audio: {} } })
  const channel = stubChannel([
    ((call) => {
      const result = probe(call)
      return result === undefined ? undefined : { ...result,
        ...(options.beforeProbe === undefined ? {} : { after: options.beforeProbe }) }
    }) satisfies StubHandler,
    decodeHandler(),
    call => call.command === 'ffmpeg' ? {} : undefined,
  ])
  const input = { project, output, timelinePath, subtitleSrt, episode: '02',
    settings: resolveSettings(), toolkit: createMediaToolkit({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', channel: channel.channel }) }
  return { input, request, record, receipt, stem, channel }
}

describe('render resume input identities', () => {
  it('records optional absence, rejects a missing required input, and notices later creation', async () => {
    const project = await tempProject()
    temporary.push(project)
    const missing = join(project, 'project_config.json')
    const absent = await readRenderResumeFile(missing, true)
    expect(absent.sha256).toBeNull()
    await expect(readRenderResumeFile(missing)).rejects.toMatchObject({ code: 'ENOENT' })
    const request = renderResumeRequest([absent], [])
    await expect(assertRenderResumeInputs(request)).resolves.toBeUndefined()
    await writePlaceholder(missing, '{}')
    await expect(assertRenderResumeInputs(request)).rejects.toThrow('输入已变化')
  })

  it('does not treat an invalid optional input path as absence', async () => {
    await expect(readRenderResumeFile('invalid\0input', true)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('propagates a non-missing output entry error without allocating or touching the project', async () => {
    const c = await candidate()
    await expect(findRenderResumeCandidate({ ...c.input, output: join(c.input.project, 'exports', 'bad\0.mp4') }, c.request, false))
      .rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
    expect(await readFile(c.input.output, 'utf8')).toBe('current delivered media')
    expect(c.channel.calls).toEqual([])
  })
})

describe('render resume verification', () => {
  it('reuses matching picture and music only after the real verifier passes', async () => {
    const c = await candidate({ stem: true })
    const result = await findRenderResumeCandidate(c.input, c.request, true)
    expect(result.output).toBe(c.input.output)
    expect(result.verified?.ok).toBe(true)
    expect(result.verified?.checks).toContainEqual(expect.objectContaining({ id: 'output_source_record', ok: true }))
    expect(c.channel.calls.some(call => call.args.includes('-xerror'))).toBe(true)
  })

  it.each(['missing', 'directory', 'changed'] as const)('preserves a candidate with %s music evidence', async (defect) => {
    const c = await candidate()
    if (defect === 'directory') await mkdir(c.stem)
    if (defect === 'changed') await writePlaceholder(c.stem, 'not the recorded music')
    await writeSourceRecord(c.receipt, { ...c.record, music_stem_sha256: '0'.repeat(64) })
    const before = await readFile(c.receipt)
    const result = await findRenderResumeCandidate(c.input, c.request, true)
    expect(result.output).not.toBe(c.input.output)
    expect(result.verified).toBeUndefined()
    expect(await readFile(c.receipt)).toEqual(before)
    expect(c.channel.calls).toEqual([])
  })

  it.each(['delivery', 'visual'] as const)('does not reuse a visual receipt missing its %s descriptor', async (missing) => {
    const c = await candidate()
    const proof = { version: 1, subtitle_sha256: c.record.delivery_inputs?.subtitle_sha256,
      [missing === 'delivery' ? 'visual' : 'delivery']: {} }
    const raw = { ...c.record, delivery_inputs: { ...c.record.delivery_inputs, subtitle_visual_verification: proof } }
    await writeFile(c.receipt, JSON.stringify(raw))
    const result = await findRenderResumeCandidate({ ...c.input, requireSubtitleVisualVerification: true }, c.request, false)
    expect(result.output).not.toBe(c.input.output)
    expect(c.channel.calls).toEqual([])
  })

  it('accepts complete visual descriptors without substituting them for independent media verification', async () => {
    const c = await candidate()
    const reportPath = join(c.input.project, 'subtitle-layout.json')
    await writePlaceholder(reportPath, JSON.stringify({ subtitle_sha256: await fileSha256(c.input.subtitleSrt) }))
    const proof: NonNullable<DeliverySourceRecord['delivery_inputs']>['subtitle_visual_verification'] = {
      version: 1, subtitle_sha256: await fileSha256(c.input.subtitleSrt), report_path: reportPath,
      report_sha256: await fileSha256(reportPath), requested_font: 'SimHei',
      delivery: { width: 1440, height: 2560, fps: 60 }, visual: { schema_version: 1, reference_width: 1080,
        reference_height: 1920, font_size_px: 40, outline_px: 2, center_y_ratio: 0.75, max_width_ratio: 0.9 }, checks: [],
    }
    await writeFile(c.receipt, JSON.stringify({ ...c.record, delivery_inputs: { ...c.record.delivery_inputs,
      subtitle_visual_verification: proof } }))
    const result = await findRenderResumeCandidate({ ...c.input, requireSubtitleVisualVerification: true }, c.request, false)
    expect(result.verified?.ok).toBe(true)
    expect(c.channel.calls.length).toBeGreaterThan(0)
  })

  it.each(['technical failure', 'unbound source record'] as const)('keeps an output with %s for manual repair', async (defect) => {
    const c = await candidate({ badGeometry: defect === 'technical failure' })
    if (defect === 'unbound source record') await writeSourceRecord(c.receipt,
      { ...c.record, output: { ...c.record.output, path: 'relative.mp4' } })
    const before = await readFile(c.receipt)
    expect((await findRenderResumeCandidate(c.input, c.request, false)).verified).toBeUndefined()
    expect(await readFile(c.receipt)).toEqual(before)
    expect(c.channel.calls.length).toBeGreaterThan(0)
  })

  it('does not reuse a record rewritten while independent verification runs', async () => {
    let receipt = ''
    const c = await candidate({ beforeProbe: async () => { await writeFile(receipt, `${await readFile(receipt, 'utf8')} `) } })
    receipt = c.receipt
    const result = await findRenderResumeCandidate(c.input, c.request, false)
    expect(result.verified).toBeUndefined()
    expect(result.output).not.toBe(c.input.output)
    expect(await readFile(c.receipt, 'utf8')).toMatch(/ $/u)
  })

  it.each(['output', 'music', 'input'] as const)('rejects a late %s replacement using actual file hashes', async (kind) => {
    const c = await candidate({ stem: kind === 'music' })
    let matches = 0
    mutation.beforeHash = async (path) => {
      const watched = kind === 'music' ? c.stem : c.input.output
      if (path !== watched || ++matches !== 2) return
      await writeFile(kind === 'input' ? c.input.timelinePath : watched, 'replacement during verification')
    }
    const result = await findRenderResumeCandidate(c.input, c.request, kind === 'music')
    expect(matches).toBe(2)
    expect(result.verified).toBeUndefined()
    expect(result.output).not.toBe(c.input.output)
  })

  it('refuses exhausted candidate paths without overwriting an earlier publication', async () => {
    const c = await candidate()
    await writeFile(c.receipt, 'broken record')
    const { dir, name, ext } = parse(c.input.output)
    const paths = Array.from({ length: 16 }, (_, index) => resolve(dir,
      `${name}.resume-${c.request.sha256.slice(0, 12)}${index === 0 ? '' : `-${index + 1}`}${ext}`))
    await Promise.all(paths.map(path => writePlaceholder(path, basename(path))))
    await expect(findRenderResumeCandidate(c.input, c.request, false)).rejects.toThrow('没有可用')
    for (const path of paths) expect(await readFile(path, 'utf8')).toBe(basename(path))
    expect(await readFile(c.input.output, 'utf8')).toBe('current delivered media')
  })
})
