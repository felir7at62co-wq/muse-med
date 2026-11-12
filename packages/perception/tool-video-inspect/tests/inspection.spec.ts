/** Video inspection uses the real filesystem, attachment store and managed FFmpeg subprocesses. */
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mkdtemp, rm, readFile, appendFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import * as Os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import sharp from 'sharp'
import { afterEach, expect, it, onTestFailed, vi } from 'vitest'
import * as VideoInspect from '../src/index.ts'
import { runMedia, parseVideoMetadata } from '../src/media.ts'
import * as Media from '../src/media.ts'
import { contactTimecode, type VideoContactSheet } from '../src/contact.ts'
import { showinfoTimestamps, splitMjpeg } from '../src/ocr.ts'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, platform: vi.fn(actual.platform) }
})

const contexts: Context[] = [], roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(Os.platform).mockReturnValue(process.platform)
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('decodes every FFmpeg batch and continues from a nonzero source range', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2, ocrMaxRangeSeconds: 2 })
  const run = mockWindowsOcr()
  expect((await h.ocr({ end_seconds: 4 })).value).toMatchObject({ scan_status: 'partial', next_start_seconds: 2,
    coverage: { planned_frame_count: 4, processed_frame_count: 4, failed_frame_count: 0 } })
  const second = await h.ocr({ start_seconds: 2, end_seconds: 4,
    raw_json_path: 'qa/second.json', merged_text_path: 'qa/second.txt' })
  expect(second.isError, JSON.stringify(second.content)).toBe(false)
  expect(second.value).toMatchObject({ scan_status: 'complete', coverage: { planned_frame_count: 4,
    processed_frame_count: 4, failed_frame_count: 0, scanned_ranges: [{ start_seconds: 2, end_seconds: 4 }] } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/second.json'), 'utf8')) as {
    frames: { requested_seconds: number; timestamp_seconds: number }[] }
  expect(raw.frames.map(frame => [frame.requested_seconds, frame.timestamp_seconds]))
    .toEqual([[2, 2], [2.5, 2.5], [3, 3], [3.5, 3.5]])
  expect(run.mock.calls.filter(call => call[1].includes('mjpeg'))).toHaveLength(4)
})

async function elevenSecondVideo(h: Awaited<ReturnType<typeof setup>>) {
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=24', '-frames:v', '266', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined,
  { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
}

it.each([
  { interval: 0.5, count: 23, last: 11, format: 'native' },
  { interval: 0.4, count: 28, last: 10.791667, format: 'native' },
  { interval: 0.4, count: 28, last: 10.791667, format: 'significant' },
  { interval: 0.4, count: 28, last: 10.791667, format: 'decimal' },
] as const)(
  'decodes the complete $interval-second plan through the final real frame and fractional batch boundary ($format)', async ({ interval, count, last, format }) => {
    const h = await setup({ ocrFrameIntervalSeconds: interval, ocrBatchFrames: 24 })
    await elevenSecondVideo(h)
    const run = mockWindowsOcr()
    const recognize = run.getMockImplementation()!
    const batchDiagnostics: {
      start_seconds: string | undefined
      frame_count: string | undefined
      elapsed_ms?: number
      output_bytes?: number
      jpeg_count?: number
      timestamps_seconds?: number[]
      stderr_tail?: string
      error?: string
      jpeg_error?: string
    }[] = []
    const probeDiagnostics: unknown[] = []
    const sourceBefore = { stat: await stat(h.input), sha256: createHash('sha256').update(await readFile(h.input)).digest('hex') }
    run.mockImplementation(async (...args) => {
      const argv = args[1]
      if (!argv.includes('mjpeg')) {
        const output = await recognize(...args)
        if (argv.includes('-read_intervals')) {
          const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as { frames?: unknown[] }
          probeDiagnostics.push({ argv, diagnostic: output.diagnostic, ...value })
        }
        return output
      }
      const batch: (typeof batchDiagnostics)[number] = {
        start_seconds: argv[argv.indexOf('-ss') + 1], frame_count: argv[argv.indexOf('-frames:v') + 1],
      }
      batchDiagnostics.push(batch)
      const started = Date.now()
      try {
        const decoded = await recognize(...args)
        const output = format === 'native' ? decoded : { ...decoded, diagnostic: showinfoFormat(decoded.diagnostic, format) }
        batch.output_bytes = output.bytes.byteLength
        batch.timestamps_seconds = showinfoTimestamps(output.diagnostic)
        batch.stderr_tail = output.diagnostic.slice(-4000)
        try { batch.jpeg_count = splitMjpeg(output.bytes).length }
        catch (error) { batch.jpeg_error = String(error).slice(-4000) }
        return output
      } catch (error) {
        batch.error = String(error).slice(-4000)
        throw error
      } finally { batch.elapsed_ms = Date.now() - started }
    })
    const result = await h.ocr({ raw_json_path: 'qa/long.json', merged_text_path: 'qa/long.txt' })
    const sourceAfter = { stat: await stat(h.input), sha256: createHash('sha256').update(await readFile(h.input)).digest('hex') }
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value, JSON.stringify({ sourceBefore, sourceAfter, batches: batchDiagnostics, probes: probeDiagnostics }))
      .toMatchObject({ scan_status: 'complete', coverage: {
        planned_frame_count: count, processed_frame_count: count, failed_frame_count: 0, failed_timestamps_seconds: [],
      } })
    const raw = JSON.parse(await readFile(join(h.root, 'qa/long.json'), 'utf8')) as {
      frames: { requested_seconds: number; timestamp_seconds: number }[] }
    expect(raw.frames.map(frame => Math.round(frame.requested_seconds * 1_000_000)))
      .toEqual(Array.from({ length: count }, (_, index) => Math.round(index * interval * 1_000_000)))
    expect(raw.frames.at(-1)?.timestamp_seconds).toBe(last)
    const batches = run.mock.calls.filter(call => call[1].includes('mjpeg')).map(call => call[1])
    expect(batches.every(argv => argv[argv.indexOf('-vf') + 1]?.includes('select=eq'))).toBe(true)
    if (interval === 0.4) expect(batches[1]?.[batches[1].indexOf('-ss') + 1]).toBe('9.6')
  }, 30_000,
)

it('keeps a missing planned final sample partial rather than treating EOF as completed evidence', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 24 })
  await elevenSecondVideo(h)
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (!args[1].includes('mjpeg')) return output
    return { bytes: Buffer.concat(splitMjpeg(output.bytes).slice(0, -1)),
      diagnostic: output.diagnostic.replace(/^.*\bpts_time:11\s.*(?:\r?\n|$)/mu, '') }
  })
  expect((await h.ocr({})).value).toMatchObject({ scan_status: 'partial', coverage: {
    planned_frame_count: 23, processed_frame_count: 22, failed_frame_count: 1, failed_timestamps_seconds: [11],
  } })
}, 30_000)

it('rejects an actually earlier timestamp at a fractional batch boundary', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.4, ocrBatchFrames: 24 })
  await elevenSecondVideo(h)
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    return args[1].includes('mjpeg') && args[1][args[1].indexOf('-ss') + 1] === '9.6'
      ? { ...output, diagnostic: output.diagnostic.replace(/pts_time:[\d.]+/u, 'pts_time:9.0') } : output
  })
  expect((await h.ocr({})).value).toMatchObject({ scan_status: 'partial', coverage: {
    planned_frame_count: 28, processed_frame_count: 24, failed_frame_count: 4,
    failed_timestamps_seconds: [24 * 0.4, 25 * 0.4, 26 * 0.4, 27 * 0.4],
  } })
}, 30_000)

it.each(['decimal', 'exponent'] as const)(
  'verifies real fractional frames when showinfo prints six significant digits as %s', async (format) => {
    const h = await setup({ ocrFrameIntervalSeconds: 0.4, ocrBatchFrames: 24 })
    await elevenSecondVideo(h)
    const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
    run.mockImplementation(async (...args) => {
      const output = await recognize(...args)
      if (!args[1].includes('mjpeg')) return output
      return { ...output, diagnostic: output.diagnostic.replace(/\bpts_time:([\d.e+-]+)/gu, (_match, text: string) =>
        `pts_time:${format === 'decimal' ? Number(text).toPrecision(6) : Number(text).toExponential(5)}`) }
    })
    const result = await h.ocr({ raw_json_path: 'qa/precision.json', merged_text_path: 'qa/precision.txt' })
    expect(result.value).toMatchObject({ scan_status: 'complete', coverage: {
      planned_frame_count: 28, processed_frame_count: 28, failed_frame_count: 0,
    } })
    const raw = JSON.parse(await readFile(join(h.root, 'qa/precision.json'), 'utf8')) as {
      frames: { timestamp_seconds: number }[] }
    expect(raw.frames.at(-1)?.timestamp_seconds).toBe(10.791667)
  }, 30_000,
)

it('rejects the wrong integer PTS even when the printed seconds still match the selected frame', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.4, ocrBatchFrames: 24 })
  await elevenSecondVideo(h)
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  const canonicalTimes = new Map<number, string>()
  let altered = false
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (args[1].some(value => value.includes('frame=best_effort_timestamp'))) {
      const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
        frames: { best_effort_timestamp: number; best_effort_timestamp_time: string }[] }
      for (const frame of value.frames) canonicalTimes.set(frame.best_effort_timestamp, frame.best_effort_timestamp_time)
    }
    const diagnostic = args[1].includes('mjpeg') ? output.diagnostic.replace(/\bpts:([ \t]*-?\d+)[ \t]+pts_time:[^\s]+/gu,
      (_match, pts: string) => {
        const time = canonicalTimes.get(Number(pts))
        if (time === undefined) throw Error('Missing real probe time for the negative-control frame')
        return `pts:${pts} pts_time:${time}`
      }) : output.diagnostic
    if (args[1].includes('mjpeg') && args[1][args[1].indexOf('-ss') + 1] === '9.6') altered = true
    return args[1].includes('mjpeg') && args[1][args[1].indexOf('-ss') + 1] === '9.6'
      ? { ...output, diagnostic: diagnostic.replace(/\bpts:\s*(-?\d+)([ \t]+pts_time:)/u,
        (_match, pts: string, tail: string) => `pts:${Number(pts) + 1}${tail}`) } : { ...output, diagnostic }
  })
  expect((await h.ocr({})).value).toMatchObject({ scan_status: 'partial', coverage: {
    planned_frame_count: 28, processed_frame_count: 24, failed_frame_count: 4,
    failed_timestamps_seconds: [24 * 0.4, 25 * 0.4, 26 * 0.4, 27 * 0.4],
  } })
  expect(altered).toBe(true)
}, 30_000)

it('rejects coarsened probe seconds even when the decoded integer PTS matches', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.4, ocrBatchFrames: 24 })
  await elevenSecondVideo(h)
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  let changed = false
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (!args[1].some(value => value.includes('frame=best_effort_timestamp'))) return output
    const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
      frames: { best_effort_timestamp_time: string }[] }
    for (const frame of value.frames) {
      const text = Number(frame.best_effort_timestamp_time).toPrecision(4)
      if (Number(text) !== Number(frame.best_effort_timestamp_time)) changed = true
      frame.best_effort_timestamp_time = text
    }
    return { ...output, bytes: Buffer.from(JSON.stringify(value)) }
  })
  const result = await h.ocr({ raw_json_path: 'qa/probe-precision.json', merged_text_path: 'qa/probe-precision.txt' })
  expect(result.value).toMatchObject({ scan_status: 'failed', coverage: {
    planned_frame_count: 28, processed_frame_count: 0, failed_frame_count: 28,
  } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/probe-precision.json'), 'utf8')) as {
    frames: { timestamp_seconds: number }[] }
  expect(changed).toBe(true)
  expect(raw.frames).toEqual([])
  expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
}, 30_000)

it('accepts decimal seconds without a leading zero when the integer PTS matches', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    return args[1].includes('mjpeg') ? { ...output, diagnostic: output.diagnostic.replace(/pts_time:0\.5\b/gu, 'pts_time:.5') } : output
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'complete', coverage: { processed_frame_count: 2 } })
})

it.each([0, 2])('uses the actual finite source end for every frame probe from %s seconds', async (start) => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 8 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  const queries: string[] = []
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args), argv = args[1]
    if (!argv.includes('-read_intervals')) return output
    const query = argv[argv.indexOf('-read_intervals') + 1]
    if (query === undefined) throw Error('Missing actual finite-end query')
    queries.push(query)
    if (!query.endsWith('%')) return output
    const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as { frames: unknown[] }
    return { ...output, bytes: Buffer.from(JSON.stringify({ ...value, frames: [] })) }
  })
  const result = await h.ocr({ start_seconds: start, end_seconds: 4, raw_json_path: 'qa/finite-end.json' })
  expect(result.value).toMatchObject({ scan_status: 'complete', coverage: {
    planned_frame_count: (4 - start) / 0.5, processed_frame_count: (4 - start) / 0.5, failed_frame_count: 0,
  } })
  expect(queries).toEqual([`${start}%4`])
  const raw = JSON.parse(await readFile(join(h.root, 'qa/finite-end.json'), 'utf8')) as { frames: { timestamp_seconds: number }[] }
  expect(raw.frames[0]?.timestamp_seconds).toBe(start)
  expect(raw.frames.at(-1)?.timestamp_seconds).toBe(3.5)
})

it.each(['not decimal', 'infinite seconds', 'infinite precision', 'zero precision', 'unsafe PTS',
  'missing PTS', 'nondecimal probe', 'zero probe precision'] as const)(
  'refuses unverifiable frame timing: %s', async (kind) => {
    const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 1 })
    const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
    run.mockImplementation(async (...args) => {
      const output = await recognize(...args)
      if ((kind === 'nondecimal probe' || kind === 'zero probe precision')
        && args[1].some(value => value.includes('frame=best_effort_timestamp'))) {
        const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as { frames: { best_effort_timestamp_time: string }[] }
        const first = value.frames[0]
        if (!first) throw Error('Missing actual probe frame for the timing negative control')
        first.best_effort_timestamp_time = kind === 'nondecimal probe' ? '0x0' : '0e-999'
        return { ...output, bytes: Buffer.from(JSON.stringify(value)) }
      }
      if (!args[1].includes('mjpeg')) return output
      const text = kind === 'not decimal' ? '0oops' : kind === 'infinite seconds' ? '1E999'
        : kind === 'infinite precision' ? '0E999' : kind === 'zero precision' ? '0e-999' : undefined
      const diagnostic = text === undefined ? output.diagnostic : output.diagnostic.replace(/\bpts_time:[^\s]+/u, `pts_time:${text}`)
      return { ...output, diagnostic: kind === 'unsafe PTS' ? diagnostic.replace(/\bpts:[ \t]*-?\d+/u, 'pts:9007199254740993')
        : kind === 'missing PTS' ? diagnostic.replace(/\bpts:[ \t]*-?\d+/u, 'pts:missing') : diagnostic }
    })
    expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed', coverage: {
      planned_frame_count: 1, processed_frame_count: 0, failed_frame_count: 1,
    } })
    expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(0)
  },
)



/** Reprint real decoded integer PTS at representative significant and fixed precisions. */
function showinfoFormat(diagnostic: string, format: 'significant' | 'decimal'): string {
  const timeBase = /config in time_base:\s*(\d+)\/(\d+)/u.exec(diagnostic)
  if (timeBase === null) throw Error('Real decoder omitted its time base')
  return diagnostic.replace(/\bpts:\s*([+-]?\d+)\s+pts_time:\s*\S+/gu, (_match, pts: string) => {
    const seconds = Number(pts) * Number(timeBase[1]) / Number(timeBase[2])
    return `pts:${pts} pts_time:${format === 'significant' ? seconds.toPrecision(6) : seconds.toFixed(6)}`
  })
}


it('checks legacy subsecond text against rational source PTS rather than rounded ffprobe text', async () => {
  const h = await setup()
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=60:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const run = mockWindowsOcr(), original = run.getMockImplementation()!
  let diagnostic = ''
  const probes: unknown[] = []
  run.mockImplementation(async (...args) => {
    const output = await original(...args)
    if (args[1].includes('-read_intervals')) probes.push(JSON.parse(Buffer.from(output.bytes).toString('utf8')))
    if (!args[1].includes('mjpeg')) return output
    diagnostic = showinfoFormat(output.diagnostic, 'significant')
    return { ...output, diagnostic }
  })
  const result = await h.ocr({ start_seconds: 1 / 60, end_seconds: 0.1 })
  expect(result.value, JSON.stringify({ diagnostic, probes })).toMatchObject({ scan_status: 'complete', coverage: { planned_frame_count: 1, processed_frame_count: 1 } })
  expect(diagnostic).toContain('pts_time:0.0166667')
})


it.each([
  { pts: 120, text: '0.007812' },
  { pts: 15480, text: '1.007812' },
  { pts: 15720, text: '1.023438' },
  { pts: 24696, text: '1.607812' },
  { pts: 15600, text: '1.015625', legacyText: '1.01562' },
  { pts: 15600, text: '1.015625', legacyText: '1.01563', invalid: true },
])('checks actual FFmpeg rounding for PTS $pts with legacy text $legacyText', async (example) => {
  const { pts, text } = example
  const h = await setup()
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=10:duration=0.2', '-vf', `settb=1/15360,setpts=if(eq(N\\,0)\\,0\\,${pts})`,
    '-enc_time_base', '1/15360', '-fps_mode', 'vfr', '-c:v', 'libx264', '-bf', '0', '-video_track_timescale', '15360', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const run = mockWindowsOcr(), original = run.getMockImplementation()!
  let probe: { frames: { best_effort_timestamp: number; best_effort_timestamp_time: string }[]
    streams: { time_base: string }[] } | undefined
  const sourceBefore = { stat: await stat(h.input), sha256: createHash('sha256').update(await readFile(h.input)).digest('hex') }
  const probes: unknown[] = []
  let diagnostic = ''
  run.mockImplementation(async (...args) => {
    const output = await original(...args)
    if (args[1].includes('-read_intervals')) {
      probe = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as typeof probe
      probes.push({ argv: args[1], diagnostic: output.diagnostic, value: probe })
    }
    if (args[1].includes('mjpeg')) {
      diagnostic = 'legacyText' in example ? output.diagnostic.replace(
        new RegExp(`(\\bpts:\\s*${pts}\\s+pts_time:)\\S+`, 'u'), `$1${example.legacyText}`,
      ) : output.diagnostic
      return { ...output, diagnostic }
    }
    return output
  })
  const start = pts / 15360
  const result = await h.ocr({ start_seconds: start, end_seconds: start + 0.01,
    raw_json_path: 'qa/rounding.json', merged_text_path: 'qa/rounding.txt' })
  const sourceAfter = { stat: await stat(h.input), sha256: createHash('sha256').update(await readFile(h.input)).digest('hex') }
  expect(probe?.streams).toMatchObject([{ time_base: '1/15360' }])
  expect(probe?.frames, JSON.stringify({ sourceBefore, sourceAfter, probes })).toContainEqual(
    expect.objectContaining({ best_effort_timestamp: pts, best_effort_timestamp_time: text }),
  )
  const complete = !('invalid' in example)
  expect(result.value, JSON.stringify({ probe, diagnostic })).toMatchObject({ scan_status: complete ? 'complete' : 'failed', coverage: {
    planned_frame_count: 1, processed_frame_count: complete ? 1 : 0, failed_frame_count: complete ? 0 : 1,
  } })
  expect(diagnostic).toMatch(new RegExp(`\\bpts:\\s*${pts}\\s+pts_time:`))
  const raw = JSON.parse(await readFile(join(h.root, 'qa/rounding.json'), 'utf8')) as {
    frames: { requested_seconds: number; timestamp_seconds: number }[] }
  expect(raw.frames).toMatchObject(complete ? [{ requested_seconds: start, timestamp_seconds: Number(text) }] : [])
})


it.each(['extra JPEG', 'extra timestamp', 'wrong pts', 'missing pts', 'unsafe pts', 'wrong pts_time', 'invalid pts_time', 'missing time base',
  'coarsened pts_time', 'different time base', 'invalid time base', 'unsafe time base', 'unsafe denominator'] as const)(
  'rejects decoded evidence with %s even when JPEGs and other timestamps are valid', async (variant) => {
    const h = await setup({ ocrBatchFrames: 2 })
    const run = mockWindowsOcr(), original = run.getMockImplementation()!
    run.mockImplementation(async (...args) => {
      const output = await original(...args)
      if (!args[1].includes('mjpeg')) return output
      if (variant === 'extra JPEG') return { ...output, bytes: Buffer.concat([output.bytes, output.bytes]) }
      let diagnostic = output.diagnostic
      if (variant === 'extra timestamp') diagnostic += '\nn:2 pts:0 pts_time:0'
      if (variant === 'wrong pts') diagnostic = diagnostic.replace(/\bpts:\s*([+-]?\d+)/u, (_match, pts: string) => `pts:${Number(pts) + 1}`)
      if (variant === 'missing pts') diagnostic = diagnostic.replace(/\bpts:\s*[+-]?\d+/u, 'pts:N/A')
      if (variant === 'unsafe pts') diagnostic = diagnostic.replace(/\bpts:\s*[+-]?\d+/u, 'pts:9007199254740992')
      if (variant === 'wrong pts_time') diagnostic = diagnostic.replace(/\bpts_time:\s*\S+/u, 'pts_time:0.000001')
      if (variant === 'coarsened pts_time') diagnostic = diagnostic.replace(/\bpts_time:0\.5\b/u, 'pts_time:0')
      if (variant === 'invalid pts_time') diagnostic = diagnostic.replace(/\bpts_time:\s*\S+/u, 'pts_time:nan')
      if (variant === 'missing time base') diagnostic = diagnostic.replace(/^.*config in time_base:.*(?:\r?\n|$)/mu, '')
      if (variant === 'different time base') diagnostic = diagnostic.replace(/config in time_base:\s*\S+/u, 'config in time_base: 1/1,')
      if (variant === 'invalid time base') diagnostic = diagnostic.replace(/config in time_base:\s*\S+/u, 'config in time_base: 0/0,')
      if (variant === 'unsafe time base') diagnostic = diagnostic.replace(/config in time_base:\s*\S+/u, 'config in time_base: 9007199254740992/1,')
      if (variant === 'unsafe denominator') diagnostic = diagnostic.replace(/config in time_base:\s*\S+/u, 'config in time_base: 1/9007199254740992,')
      return { ...output, diagnostic }
    })
    expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed', coverage: {
      planned_frame_count: 2, processed_frame_count: 0, failed_frame_count: 2,
    } })
    expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
  },
)


it.each(['wrong timestamp', 'coarsened timestamp', 'nontext timestamp', 'missing time base', 'invalid time base', 'unsafe pts', 'negative pts', 'overflow ticks',
  'invalid frame list', 'empty frames'] as const)(
  'rejects ffprobe %s before decoding or recognizing a batch', async (variant) => {
    const h = await setup({ ocrBatchFrames: 2 })
    const run = mockWindowsOcr(), original = run.getMockImplementation()!
    run.mockImplementation(async (...args) => {
      const output = await original(...args)
      if (!args[1].includes('-read_intervals')) return output
      const probe = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
        streams: { time_base?: string }[]
        frames: { best_effort_timestamp: number; best_effort_timestamp_time: string | number }[]
      }
      if (variant === 'invalid frame list') return { ...output, bytes: Buffer.from(JSON.stringify({ ...probe, frames: null })) }
      if (variant === 'empty frames') probe.frames = []
      if (variant === 'wrong timestamp') probe.frames[0]!.best_effort_timestamp_time = '0.000001'
      if (variant === 'coarsened timestamp') probe.frames[1]!.best_effort_timestamp_time = '0'
      if (variant === 'nontext timestamp') probe.frames[0]!.best_effort_timestamp_time = 0
      if (variant === 'missing time base') delete probe.streams[0]!.time_base
      if (variant === 'invalid time base') probe.streams[0]!.time_base = '-1/0'
      if (variant === 'unsafe pts') probe.frames[0]!.best_effort_timestamp = Number.MAX_SAFE_INTEGER + 1
      if (variant === 'negative pts') probe.frames[0]!.best_effort_timestamp = -1
      if (variant === 'overflow ticks') {
        probe.streams[0]!.time_base = '2/1'
        probe.frames[0]!.best_effort_timestamp = Number.MAX_SAFE_INTEGER
      }
      return { ...output, bytes: Buffer.from(JSON.stringify(probe)) }
    })
    expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed', coverage: {
      processed_frame_count: 0, failed_frame_count: 2,
    } })
    expect(run.mock.calls.some(call => call[1].includes('mjpeg') || call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
  },
)


it('rejects an unknown probe time origin before producing OCR evidence', async () => {
  const h = await setup()
  const run = mockWindowsOcr(), original = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await original(...args)
    if (!args[1].includes('-read_intervals')) return output
    const probe = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as Record<string, unknown>
    delete probe.format
    return { ...output, bytes: Buffer.from(JSON.stringify(probe)) }
  })
  const result = await h.ocr({ end_seconds: 1, raw_json_path: 'qa/unknown-origin.json' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('非零或未知起点')
  await expect(readFile(join(h.root, 'qa/unknown-origin.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(run.mock.calls.some(call => call[1].includes('mjpeg') || call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
})


it('uses packet duration evidence when ffprobe omits frame duration', async () => {
  const h = await setup()
  const run = mockWindowsOcr(), original = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await original(...args)
    if (!args[1].includes('-read_intervals')) return output
    const probe = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
      frames: { duration_time?: string; pkt_duration_time?: string }[]
    }
    for (const frame of probe.frames) {
      if (frame.duration_time !== undefined) {
        frame.pkt_duration_time = frame.duration_time
        delete frame.duration_time
      }
    }
    return { ...output, bytes: Buffer.from(JSON.stringify(probe)) }
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'complete', coverage: {
    planned_frame_count: 2, processed_frame_count: 2, failed_frame_count: 0,
  } })
})
it('logs only encoded batch samples when FFmpeg reads ahead of a low-rate source', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.25, ocrBatchFrames: 2 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  const batches: { argv: readonly string[]; output: Media.MediaOutput }[] = []
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (args[1].includes('mjpeg')) batches.push({ argv: args[1], output })
    return output
  })
  const result = await h.ocr({ start_seconds: 0.5, end_seconds: 1.5 })
  const diagnostics = JSON.stringify(batches.map(({ argv, output }) => ({ argv, diagnostic: output.diagnostic,
    image_count: splitMjpeg(output.bytes).length, timestamps: showinfoTimestamps(output.diagnostic) })))
  expect(result.value, diagnostics).toMatchObject({ scan_status: 'complete', coverage: {
    planned_frame_count: 4, processed_frame_count: 4, failed_frame_count: 0,
  } })
  expect(batches, diagnostics).toHaveLength(2)
  expect(batches.map(({ output }) => [splitMjpeg(output.bytes).length, showinfoTimestamps(output.diagnostic)]), diagnostics)
    .toEqual([[2, [0.5, 0.7]], [2, [1, 1.2]]])
})

it('rejects mismatched batch diagnostics instead of discarding extra timestamps', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  const batches: { argv: readonly string[]; output: Media.MediaOutput }[] = []
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (!args[1].includes('mjpeg')) return output
    batches.push({ argv: args[1], output })
    const image = splitMjpeg(output.bytes)[0]
    if (!image) throw Error('Real decoder did not return the negative-control image')
    return { bytes: image, diagnostic: output.diagnostic }
  })
  const result = await h.ocr({ end_seconds: 1 })
  expect(result.value).toMatchObject({ scan_status: 'failed', coverage: {
    planned_frame_count: 2, processed_frame_count: 0, failed_frame_count: 2,
  } })
  expect(batches).toHaveLength(1)
  const batch = batches[0]!
  expect(splitMjpeg(batch.output.bytes)).toHaveLength(2)
  expect(showinfoTimestamps(batch.output.diagnostic)).toEqual([0, 0.5])
  expect(batch.argv[batch.argv.indexOf('-vf') + 1]).toContain('trim=end_frame=2,')
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(0)
})

it('rejects an extra encoded JPEG even when it has a matching diagnostic record', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 1 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (!args[1].includes('mjpeg')) return output
    const image = splitMjpeg(output.bytes)[0]
    const timing = output.diagnostic.match(/^.*\bn:[^\r\n]*\bpts_time:[^\r\n]*/mu)?.[0]
    if (!image || !timing) throw Error('Missing actual decoder output for the extra-frame negative control')
    return { bytes: Buffer.concat([output.bytes, image]), diagnostic: `${output.diagnostic}\n${timing}\n` }
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed', coverage: {
    planned_frame_count: 1, processed_frame_count: 0, failed_frame_count: 1,
  } })
  expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
})

it.each([
  [{ ocrMinFrameIntervalSeconds: 2, ocrFrameIntervalSeconds: 1 }, 'OCR frame interval bounds'],
  [{ ocrFrameIntervalSeconds: 2, ocrMaxFrameIntervalSeconds: 1 }, 'OCR frame interval bounds'],
  [{ ocrBatchFrames: 4, ocrMaxFrames: 2 }, 'ocrBatchFrames'],
] as const)('rejects contradictory OCR deployment limits before registering tools: %j', async (options, message) => {
  const ctx = new Context()
  contexts.push(ctx)
  await expect(VideoInspect.apply(ctx, VideoInspect.Config(options))).rejects.toThrow(message)
})

it('plans OCR to the real video EOF without changing container metadata or contact-sheet bounds', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const container = await addAudioTail(h)
  const metadata = await h.call({ method: 'metadata' })
  expect(metadata.isError, JSON.stringify(metadata.content)).toBe(false)
  expect(metadata.value).toMatchObject({ duration_seconds: container.duration_seconds,
    interval: { start_seconds: 0, end_seconds: container.duration_seconds } })
  const sheet = await h.sheet({ frame_count: 2 })
  expect(sheet.isError, JSON.stringify(sheet.content)).toBe(false)
  expect(sheet.value).toMatchObject({ duration_seconds: container.duration_seconds,
    interval: { start_seconds: 0, end_seconds: container.duration_seconds } })
  const run = mockWindowsOcr()
  const result = await h.ocr({ raw_json_path: 'qa/video-eof.json', merged_text_path: 'qa/video-eof.txt' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ duration_seconds: 4, scan_status: 'complete',
    interval: { start_seconds: 0, end_seconds: 4 }, coverage: { planned_frame_count: 8,
      processed_frame_count: 8, failed_frame_count: 0, failed_timestamps_seconds: [], unscanned_ranges: [] } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/video-eof.json'), 'utf8')) as {
    frames: { requested_seconds: number; timestamp_seconds: number }[] }
  expect(raw.frames.map(frame => frame.requested_seconds)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])
  expect(raw.frames.every(frame => frame.timestamp_seconds < 4)).toBe(true)
  expect(run.mock.calls.filter(call => call[1].includes('mjpeg'))).toHaveLength(4)
})

it('retains an internal decode failure as partial OCR coverage after selecting video EOF', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  await addAudioTail(h)
  const run = mockWindowsOcr(), complete = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const seek = args[1].indexOf('-ss')
    if (args[1].includes('mjpeg') && args[1][seek + 1] === '1') throw Error('Synthetic internal decode failure')
    return await complete(...args)
  })
  const result = await h.ocr({ raw_json_path: 'qa/internal-gap.json', merged_text_path: 'qa/internal-gap.txt' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ duration_seconds: 4, scan_status: 'partial',
    coverage: { planned_frame_count: 8, processed_frame_count: 6, failed_frame_count: 2,
      failed_timestamps_seconds: [1, 1.5], scanned_ranges: [
        { start_seconds: 0, end_seconds: 1 }, { start_seconds: 2, end_seconds: 4 },
      ] } })
  expect(run.mock.calls.filter(call => call[1].includes('mjpeg'))).toHaveLength(4)
}, 30_000)

it('keeps an EOF gap partial when the probe cannot establish a video-stream duration', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const container = await addAudioTail(h)
  mockWindowsOcr()
  // The parser regressions cover unknown stream duration; this valid fallback drives the real decoder.
  vi.spyOn(Media, 'probeVideo').mockResolvedValue(container)
  const result = await h.ocr({ raw_json_path: 'qa/unknown-eof.json', merged_text_path: 'qa/unknown-eof.txt' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ duration_seconds: container.duration_seconds, scan_status: 'partial',
    coverage: { planned_frame_count: 9, processed_frame_count: 8, failed_frame_count: 1,
      failed_timestamps_seconds: [4] } })
}, 30_000)

it('keeps persistent narrative text usable and stops after a recognizer deadline', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.25, ocrBatchFrames: 2,
    ocrPersistentTextMinFrames: 2, ocrPersistentTextMinSeconds: 1 })
  const original = Media.runMedia
  const run = mockWindowsOcr()
  run.mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    const input = JSON.parse(args[4].stdin ?? '{}') as { frames: { id: string; timestamp_seconds: number }[] }
    return { bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'zh-Hans-CN',
      frames: input.frames.map(frame => ({ ...frame, image_width: 64, image_height: 48, lines: [{
        text: '我终于找到你了', bounding_box: { x: 8, y: 32, width: 48, height: 10 }, words: [],
      }] })) })), diagnostic: '' }
  })
  expect((await h.ocr({ end_seconds: 2 })).value).toMatchObject({ scan_status: 'complete',
    text_status: 'candidate_text_detected', segment_count: 1, persistent_text_count: 1,
    preview_segments: [{ text: '我终于找到你了', classification: 'persistent_text_candidate' }] })
  run.mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    throw Error('Local OCR recognizer deadline expired')
  })
  run.mockClear()
  expect((await h.ocr({ end_seconds: 2 })).value).toMatchObject({ scan_status: 'failed',
    text_status: 'indeterminate', failure_code: 'ocr_runtime_unavailable',
    coverage: { planned_frame_count: 8, processed_frame_count: 0, failed_frame_count: 8 } })
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(1)
})

it('validates OCR sources, ranges and output identity before extraction', async () => {
  const h = await setup()
  for (const file_path of ['missing.mp4', h.root]) expect((await h.ocr({ file_path })).isError).toBe(true)
  for (const args of [{ start_seconds: -1 }, { start_seconds: 4 }, { end_seconds: 0 }, { end_seconds: 5 },
    { frame_interval_seconds: 0.1 }, { frame_interval_seconds: 31 },
    { raw_json_path: 'same.json', merged_text_path: 'same.json' }]) {
    expect((await h.ocr(args)).isError, JSON.stringify(args)).toBe(true)
  }
  const tooLarge = await setup({ maxSourceBytes: 1 })
  expect((await tooLarge.ocr({})).isError).toBe(true)
  const tooLong = await setup({ maxDurationSeconds: 1 })
  expect((await tooLong.ocr({})).isError).toBe(true)
})

it('reports an unmapped bridge and missing executable without substituting ASR', async () => {
  const h = await setup({ powershellPath: 'missing-local-ocr-executable' })
  vi.mocked(Os.platform).mockReturnValue('win32')
  expect((await h.ocr({ end_seconds: 1 }, undefined, false)).value)
    .toMatchObject({ scan_status: 'failed', failure_code: 'ocr_runtime_unavailable' })
  vi.spyOn(h.ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
  expect((await h.ocr({ end_seconds: 1 })).value)
    .toMatchObject({ scan_status: 'failed', failure_code: 'ocr_runtime_unavailable' })
})

it('retains missing decoded samples and rejected bridge identities in failed coverage', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const original = Media.runMedia
  const run = mockWindowsOcr()
  run.mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    const input = JSON.parse(args[4].stdin ?? '{}') as { frames: { id: string; timestamp_seconds: number }[] }
    const first = input.frames[0]!
    return { bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'en-US', frames: [
      { ...first, id: 'foreign-frame', image_width: 64, image_height: 48, lines: [] },
      { ...first, timestamp_seconds: first.timestamp_seconds + 1, image_width: 64, image_height: 48, lines: [] },
    ] })), diagnostic: '' }
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed',
    text_status: 'indeterminate', coverage: { failed_timestamps_seconds: [0, 0.5] } })
  run.mockImplementation(async (...args) => {
    if (args[1].includes('mjpeg')) return { bytes: Buffer.alloc(0), diagnostic: '' }
    if (args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return {
      bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'en-US', frames: [] })), diagnostic: '' }
    return await original(...args)
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed',
    coverage: { failed_timestamps_seconds: [0, 0.5] } })
})

it('contains malformed extraction and recoverable decode failures but stops missing engines', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const original = Media.runMedia
  const run = mockWindowsOcr({ ok: false, code: 'frame_decode_failed' })
  expect((await h.ocr({ end_seconds: 2 })).value).toMatchObject({ scan_status: 'failed',
    failure_code: 'ocr_runtime_unavailable', coverage: { failed_frame_count: 4 } })
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(2)
  run.mockImplementation(async (...args) => {
    if (args[1].includes('mjpeg')) return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), diagnostic: '' }
    return await original(...args)
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed',
    coverage: { failed_timestamps_seconds: [0, 0.5] } })
  run.mockImplementation(async (...args) => {
    if (args[1].includes('mjpeg')) return { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), diagnostic: 'pts_time:9' }
    return await original(...args)
  })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed' })
  run.mockImplementation(async (...args) => {
    if (args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return {
      bytes: Buffer.from(JSON.stringify({ ok: false, code: 'ocr_engine_unavailable' })), diagnostic: '' }
    return await original(...args)
  })
  run.mockClear()
  expect((await h.ocr({ end_seconds: 2 })).value)
    .toMatchObject({ scan_status: 'failed', failure_code: 'ocr_engine_unavailable' })
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(1)
})

it('keeps whitespace OCR indeterminate and detects changed artifact readback', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1 })
  const original = Media.runMedia
  const run = mockWindowsOcr()
  run.mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    const input = JSON.parse(args[4].stdin ?? '{}') as { frames: { id: string; timestamp_seconds: number }[] }
    return { bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'en-US', frames: input.frames.map(frame => ({
      ...frame, image_width: 64, image_height: 48, lines: [{ text: '  ', words: [], bounding_box: { x: 0, y: 0, width: 1, height: 1 } }],
    })) })), diagnostic: '' }
  })
  const result = await h.ocr({ end_seconds: 1 })
  expect(result.value).toMatchObject({ scan_status: 'complete', text_status: 'indeterminate', segment_count: 0 })
  expect(h.ctx.tools.get('video_ocr')?.output.render({}, result.value!))
    .toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
  expect(h.ctx.tools.get('video_ocr')?.output.presentationMeta?.({}, result.value!))
    .toMatchObject({ scanStatus: 'complete', textStatus: 'indeterminate' })
  vi.spyOn(h.ctx.fs, 'readText').mockResolvedValueOnce('changed by another writer')
  const changed = await h.ocr({ end_seconds: 1 })
  expect(changed.isError).toBe(true)
  expect(JSON.stringify(changed.content)).toContain('readback did not match')
})

it('bounds complete bridge JSON before spawning a recognizer', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 8, maxOcrBridgeInputBytes: 1024 })
  const run = mockWindowsOcr()
  const recognize = run.getMockImplementation()!
  const diagnostics: { argv: readonly string[]; output: string }[] = []
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (args[1].includes('mjpeg') || args[1].some(value => value.includes('frame=best_effort_timestamp'))) {
      diagnostics.push({ argv: args[1], output: args[1].includes('mjpeg') ? output.diagnostic : Buffer.from(output.bytes).toString('utf8') })
    }
    return output
  })
  expect((await h.ocr({ end_seconds: 4 })).value, JSON.stringify(diagnostics)).toMatchObject({ scan_status: 'failed',
    failure_code: 'ocr_runtime_unavailable', coverage: { planned_frame_count: 8, processed_frame_count: 0, failed_frame_count: 8 } })
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(0)
})

async function setup(options: Partial<VideoInspect.Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-video-inspect-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
  await ctx.plugin(LocalSubprocessRuntime).await()
  await ctx.plugin(LocalAttachmentStore, { dshHome: join(root, '.state') }).await()
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) } as never)
  vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation(async (provider: string, model: string) => ({
    provider, id: model, name: model, inputModalities: model === 'vision' ? ['text', 'image'] : ['text'],
  }))
  const driver = await mountAgentLoopTestHarness(ctx)
  const config = VideoInspect.Config({ powershellPath: process.execPath, ...options })
  const video = ctx.plugin(VideoInspect, config)
  await video.await()
  const ffmpeg = await ctx.subprocess.resolveExecutable(config.ffmpegPath)
  const input = join(root, 'red-blue.mp4')
  await runMedia(ctx, [ffmpeg, '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10:d=2',
    '-f', 'lavfi', '-i', 'color=c=blue:size=64x48:rate=10:d=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', input],
  { mode: 'danger-full-access', workspaceRoot: root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  let count = 0
  let owners = 0
  const agent = async (model: string, options: boolean) => {
    const owner = await driver.create(SessionId(`inspection-${++owners}`), options ? { provider: 'test', model } : {}, { cwd: root })
    if (!options) owner.session.append('request/header', { reason: 'initial', header: { config: { provider: 'test', model } } })
    return owner
  }
  return { ctx, root, input, config, video,
    sheet: async (args: Record<string, unknown>, model = 'vision', withAgent = true) => executeModelToolFixture(ctx, { callId: ToolCallId(`sheet-${++count}`), name: 'video_contact_sheet',
      arguments: { file_path: input, ...args }, signal: new AbortController().signal,
      ...withAgent ? { agent: await agent(model, false) } : {} }),
    call: async (args: Record<string, unknown>, model = 'vision', route: 'header' | 'options' | 'none' = 'header') => executeModelToolFixture(ctx, { callId: ToolCallId(`video-${++count}`), name: 'video_inspect',
      arguments: { file_path: input, ...args }, signal: new AbortController().signal, ...route === 'none' ? {} : { agent: await agent(model, route === 'options') } }),
    ocr: async (args: Record<string, unknown>, signal = new AbortController().signal, withAgent = true) => executeModelToolFixture(ctx, { callId: ToolCallId(`ocr-${++count}`), name: 'video_ocr',
      arguments: { file_path: input, ...args }, signal, ...withAgent ? { agent: await agent('vision', false) } : {} }),
  }
}

async function addAudioTail(h: Awaited<ReturnType<typeof setup>>): Promise<Media.VideoMetadata> {
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  const policy = { mode: 'danger-full-access', workspaceRoot: h.root } as const
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=30:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4.1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', h.input], policy, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const limits = { timeoutMs: 20_000, graceMs: 1000 }, signal = new AbortController().signal
  const container = await Media.probeVideo(h.ctx, h.config.ffprobePath, h.input, policy, signal, limits)
  expect(container.duration_seconds).toBeGreaterThan(4)
  expect(container.duration_seconds).toBeLessThan(4.5)
  expect((await Media.probeVideo(h.ctx, h.config.ffprobePath, h.input, policy, signal, limits, 'video')).duration_seconds).toBe(4)
  return container
}

function mockWindowsOcr(result?: { ok: false; code: string }, engine: 'windows-native' | 'rapidocr' = 'windows-native') {
  vi.mocked(Os.platform).mockReturnValue(engine === 'rapidocr' ? 'darwin' : 'win32')
  const bridge = engine === 'rapidocr' ? 'ocr_bridge.py' : 'ocr_bridge.ps1'
  const original = Media.runMedia
  const diagnostics: {
    argv: readonly string[]
    bytes?: number
    probe?: unknown
    shown?: unknown
    stderr_tail?: string
    error?: string
  }[] = []
  onTestFailed(() => { console.error('OCR actual media facts', JSON.stringify(diagnostics)) })
  return vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith(bridge))) {
      const fact: (typeof diagnostics)[number] = { argv: args[1] }
      diagnostics.push(fact)
      if (diagnostics.length > 12) diagnostics.shift()
      try {
        const output = await original(...args)
        fact.bytes = output.bytes.byteLength
        fact.stderr_tail = output.diagnostic.slice(-4000)
        if (args[1].some(value => value.includes('frame=best_effort_timestamp'))) {
          const value: unknown = JSON.parse(Buffer.from(output.bytes).toString('utf8'))
          if (value && typeof value === 'object' && 'frames' in value && Array.isArray(value.frames)) {
            fact.probe = { count: value.frames.length, first: value.frames.slice(0, 2), last: value.frames.slice(-2) }
          }
        } else if (args[1].includes('mjpeg')) {
          const rows = [...output.diagnostic.matchAll(/\bn:[^\r\n]+/gu)].map(match => match[0])
          fact.shown = { count: rows.length, first: rows.slice(0, 2), last: rows.slice(-2) }
        }
        return output
      } catch (error) {
        fact.error = String(error).slice(-4000)
        throw error
      }
    }
    if (result) return { bytes: Buffer.from(JSON.stringify(result)), diagnostic: '' }
    const input = JSON.parse(args[4].stdin ?? '{}') as { language: string; frames: { id: string; timestamp_seconds: number }[] }
    return { bytes: Buffer.from(JSON.stringify({ ok: true,
      language_used: input.language === 'auto' ? 'zh-Hans-CN' : input.language,
      frames: input.frames.map((item, index) => ({ ...item, image_width: 64, image_height: 48, lines: [{
        text: index === 0 ? '你好 Hello' : '第二句', bounding_box: { x: 8, y: 32, width: 48, height: 10 },
        words: engine === 'rapidocr' ? [] : [{ text: index === 0 ? '你好 Hello' : '第二句', bounding_box: { x: 8, y: 32, width: 48, height: 10 } }],
      }] })),
    })), diagnostic: '' }
  })
}

it('uses the isolated Python engine on macOS and preserves timestamped line evidence without inventing word boxes', async () => {
  const h = await setup({ ocrEngine: 'rapidocr', ocrPythonPath: process.execPath,
    ocrCpuThreads: 3, ocrFrameIntervalSeconds: 1, ocrBatchFrames: 4 })
  const run = mockWindowsOcr(undefined, 'rapidocr')
  const result = await h.ocr({ start_seconds: 1, end_seconds: 3,
    raw_json_path: 'qa/rapid.json', merged_text_path: 'qa/rapid.txt' })
  expect(result.value).toMatchObject({ scan_status: 'complete', text_source: 'ocr',
    language_used: 'zh-Hans-CN', coverage: { processed_frame_count: 2, failed_frame_count: 0 } })
  const bridgeCalls = run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.py')))
  expect(bridgeCalls).toHaveLength(1)
  expect(bridgeCalls[0]![1].slice(0, 3)).toEqual([process.execPath, '-I', '-B'])
  expect(JSON.parse(bridgeCalls[0]![4].stdin!)).toMatchObject({ cpu_threads: 3 })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/rapid.json'), 'utf8')) as {
    frames: { timestamp_seconds: number; lines: { words: unknown[] }[] }[] }
  expect(raw.frames.map(item => item.timestamp_seconds)).toEqual([1, 2])
  expect(raw.frames.every(item => item.lines.every(line => line.words.length === 0))).toBe(true)
  expect(h.ctx.tools.get('audio_transcribe')).toBeUndefined()
}, 30_000)

it.each(['原样字幕 / 繁體字幕 / Hello', '简体字幕 / 繁體字幕 / Hello / 🎬'])(
  'preserves multilingual OCR bytes through the Python process and artifact readback with a legacy Windows locale: %s', async (text) => {
    const python = process.env.DSH_OCR_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    const h = await setup({ ocrEngine: 'rapidocr', ocrPythonPath: python,
      ocrFrameIntervalSeconds: 1, ocrBatchFrames: 1 })
    const original = Media.runMedia, outputs: Media.MediaOutput[] = []
    vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
      const script = args[1].at(-1)
      if (!script?.endsWith('ocr_bridge.py')) return await original(...args)
      const fixture = fileURLToPath(new URL('./fixtures/ocr-encoding.py', import.meta.url))
      const output = await original(args[0], [...args[1].slice(0, -1), fixture, script, text], args[2], args[3], args[4])
      outputs.push(output)
      return output
    })
    const result = await h.ocr({ end_seconds: 1,
      raw_json_path: 'qa/unicode.json', merged_text_path: 'qa/unicode.txt' })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(result.value).toMatchObject({ scan_status: 'complete', text_status: 'candidate_text_detected',
      coverage: { processed_frame_count: 1, failed_frame_count: 0 } })
    expect(outputs).toHaveLength(1)
    expect(Buffer.from(outputs[0]!.bytes).toString('utf8')).toContain(text)
    expect(result.value).toMatchObject({ preview_segments: [expect.objectContaining({ text })] })
    const raw = JSON.parse(await readFile(join(h.root, 'qa/unicode.json'), 'utf8')) as {
      frames: { lines: { text: string }[] }[]
      segments: { text: string }[] }
    expect(raw.frames[0]?.lines[0]?.text).toBe(text)
    expect(raw.segments[0]?.text).toBe(text)
    expect(await readFile(join(h.root, 'qa/unicode.txt'), 'utf8')).toContain(text)
    expect(JSON.parse(outputs[0]!.diagnostic)).toEqual({ utf8_mode: 1, stdout_encoding: 'utf-8' })
  })

it.each(['language_unavailable', 'ocr_engine_unavailable'] as const)('reports Python OCR %s without claiming an empty successful scan', async (code) => {
  const h = await setup({ ocrEngine: 'rapidocr', ocrPythonPath: process.execPath, ocrFrameIntervalSeconds: 1 })
  mockWindowsOcr({ ok: false, code }, 'rapidocr')
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed',
    text_status: 'indeterminate', failure_code: code, coverage: { processed_frame_count: 0, failed_frame_count: 1 } })
})

it('reports a missing Python interpreter before OCR dispatch and keeps the native deployment default', async () => {
  expect(VideoInspect.Config({}).ocrEngine).toBe('windows-native')
  const h = await setup({ ocrEngine: 'rapidocr', ocrPythonPath: 'missing-ocr-python-executable', ocrFrameIntervalSeconds: 1 })
  expect((await h.ocr({ end_seconds: 1 })).value).toMatchObject({ scan_status: 'failed', failure_code: 'ocr_runtime_unavailable' })
  for (const options of [{ ocrCpuThreads: 0 }, { ocrCpuThreads: 17 }, { ocrCpuThreads: 1.5 }]) {
    expect(() => VideoInspect.Config(options)).toThrow()
  }
})

it('runs real bounded frame extraction with one mocked local OCR batch and publishes source-labelled evidence', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 4 })
  const run = mockWindowsOcr()
  const result = await h.ocr({ end_seconds: 2, raw_json_path: 'qa/ocr.json', merged_text_path: 'qa/ocr.txt' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ text_source: 'ocr', scan_status: 'complete', text_status: 'candidate_text_detected',
    coverage: { planned_frame_count: 2, processed_frame_count: 2, failed_frame_count: 0 },
    raw_json_path: join(h.root, 'qa/ocr.json'), merged_text_path: join(h.root, 'qa/ocr.txt') })
  expect(run.mock.calls.filter(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toHaveLength(1)
  expect(run.mock.calls.find(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))?.[1])
    .toEqual(expect.arrayContaining(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive']))
  expect(run.mock.calls.filter(call => call[1].includes('mjpeg'))).toHaveLength(1)
  const raw = JSON.parse(await readFile(join(h.root, 'qa/ocr.json'), 'utf8')) as { text_source: string; frames: unknown[]; segments: unknown[] }
  expect(result.value).toHaveProperty('raw_json_sha256', createHash('sha256').update(await readFile(join(h.root, 'qa/ocr.json'))).digest('hex'))
  expect(raw).toMatchObject({ text_source: 'ocr' })
  expect(raw.frames).toHaveLength(2)
  expect(raw.frames[0]).toMatchObject({ requested_seconds: 0, lines: [{ text: '你好 Hello' }] })
  expect(raw.segments.length).toBeGreaterThan(0)
  expect(await readFile(join(h.root, 'qa/ocr.txt'), 'utf8')).toContain('Text source: ocr')
  expect(h.ctx.tools.get('audio_transcribe')).toBeUndefined()
}, 30_000)

it('reports bounded long-video coverage and language failure without claiming no subtitles', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1, ocrMaxRangeSeconds: 1, ocrMaxFrames: 1, ocrBatchFrames: 1 })
  mockWindowsOcr()
  const partial = await h.ocr({ end_seconds: 4, raw_json_path: 'qa/partial.json', merged_text_path: 'qa/partial.txt' })
  expect(partial.isError, JSON.stringify(partial.content)).toBe(false)
  expect(partial.value).toMatchObject({ scan_status: 'partial', text_status: 'candidate_text_detected', next_start_seconds: 1,
    coverage: { unscanned_ranges: [{ start_seconds: 1, end_seconds: 4, reason: 'deployment_limit' }] } })
  vi.restoreAllMocks()
  const missingHarness = await setup({ ocrFrameIntervalSeconds: 1, ocrMaxRangeSeconds: 1, ocrMaxFrames: 1, ocrBatchFrames: 1 })
  mockWindowsOcr({ ok: false, code: 'language_unavailable' })
  const missing = await missingHarness.ocr({ end_seconds: 1, language: 'en-US',
    raw_json_path: 'qa/missing.json', merged_text_path: 'qa/missing.txt' })
  expect(missing.value).toMatchObject({ scan_status: 'failed', text_status: 'indeterminate', failure_code: 'language_unavailable',
    coverage: { processed_frame_count: 0, failed_frame_count: 1 } })
}, 30_000)

it('reports an empty completed sample as OCR no-text evidence without invoking ASR', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 4 })
  vi.mocked(Os.platform).mockReturnValue('win32')
  const original = Media.runMedia
  vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    const input = JSON.parse(args[4].stdin ?? '{}') as { language: string; frames: { id: string; timestamp_seconds: number }[] }
    return { bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'zh-Hans-CN',
      frames: input.frames.map(frame => ({ ...frame, image_width: 64, image_height: 48, lines: [] })) })), diagnostic: '' }
  })
  const result = await h.ocr({ end_seconds: 2, raw_json_path: 'qa/empty.json', merged_text_path: 'qa/empty.txt' })
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  expect(result.value).toMatchObject({ text_source: 'ocr', scan_status: 'complete', text_status: 'no_text_detected',
    segment_count: 0, persistent_text_count: 0 })
  expect(h.ctx.tools.get('audio_transcribe')).toBeUndefined()
}, 30_000)

it('rejects source mutation before publishing OCR evidence', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 4 })
  vi.mocked(Os.platform).mockReturnValue('win32')
  const original = Media.runMedia
  vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    const input = JSON.parse(args[4].stdin ?? '{}') as { frames: { id: string; timestamp_seconds: number }[] }
    await appendFile(h.input, Buffer.from([0]))
    return { bytes: Buffer.from(JSON.stringify({ ok: true, language_used: 'zh-Hans-CN',
      frames: input.frames.map(frame => ({ ...frame, image_width: 64, image_height: 48, lines: [] })) })), diagnostic: '' }
  })
  const result = await h.ocr({ end_seconds: 1, raw_json_path: 'qa/mutated.json', merged_text_path: 'qa/mutated.txt' })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('changed during OCR'))).toBe(true)
  await expect(readFile(join(h.root, 'qa/mutated.json'))).rejects.toThrow()
  await expect(readFile(join(h.root, 'qa/mutated.txt'))).rejects.toThrow()
}, 30_000)

it('registers OCR as Windows-only, rejects unsafe output paths and never silently substitutes ASR', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 1 })
  expect(h.ctx.tools.get('video_ocr')?.presentCall?.({ file_path: h.input })).toMatchObject({ kind: 'read', locations: [{ path: h.input }] })
  expect(h.ctx.tools.get('video_ocr')?.isConcurrencySafe?.({ file_path: h.input })).toBe(true)
  const outside = await h.ocr({ end_seconds: 1, raw_json_path: '../outside.json', merged_text_path: 'qa/ocr.txt' })
  expect(outside.isError).toBe(true)
  await writeFile(join(h.root, 'qa-existing.json'), '{}')
  const existing = await h.ocr({ end_seconds: 1, raw_json_path: 'qa-existing.json', merged_text_path: 'qa/new.txt' })
  expect(existing.isError).toBe(true)
  await expect(readFile(join(h.root, 'qa/new.txt'))).rejects.toThrow()
  expect(h.ctx.tools.get('audio_transcribe')).toBeUndefined()
  vi.mocked(Os.platform).mockReturnValue('darwin')
  const unsupported = await h.ocr({ end_seconds: 1, raw_json_path: 'qa/raw.json', merged_text_path: 'qa/text.txt' })
  expect(unsupported.value).toMatchObject({ scan_status: 'failed', text_status: 'indeterminate', failure_code: 'windows_only' })
}, 30_000)

it('returns six-cell pages in source order with readable times and retained detail frames', async () => {
  const h = await setup()
  const result = await h.sheet({ columns: 3, rows: 2, frame_count: 8, tile_width: 160, end_seconds: 4, manifest_path: 'qa/sheets.json' })
  expect(result.isError).toBe(false)
  const images = result.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(2)
  const manifest = JSON.parse(await readFile(join(h.root, 'qa/sheets.json'), 'utf8')) as { pages: { frames: { cell: number; index: number; timestamp_seconds: number }[] }[] }
  expect(manifest.pages.map(page => page.frames.map(frame => frame.index))).toEqual([[1, 2, 3, 4, 5, 6], [7, 8]])
  expect(manifest.pages[1]?.frames.map(frame => frame.cell)).toEqual([1, 2])
  const times = manifest.pages.flatMap(page => page.frames.map(frame => frame.timestamp_seconds))
  expect(times).toEqual([...times].sort((a, b) => a - b))
  const stored = await h.ctx.attachments.readImage(images[0]!.attachment)
  const raw = await sharp(stored.data).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  expect(raw.info).toMatchObject({ width: 480, height: 280, channels: 3 })
  const pixel = (x: number, y: number) => [...raw.data.subarray((y * raw.info.width + x) * 3, (y * raw.info.width + x) * 3 + 3)]
  expect(pixel(80, 60)[0]).toBeGreaterThan(240)
  expect(pixel(400, 200)[2]).toBeGreaterThan(240)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('not continuous viewing'))).toBe(true)
  expect(contactTimecode(3661.234)).toBe('01:01:01.234')
  expect((await h.sheet({ manifest_path: 'qa/sheets.json' })).isError).toBe(true)
}, 30_000)

it('defaults to nine cells and selects explicit detail times without sending extra full frames', async () => {
  const h = await setup()
  const result = await h.sheet({ timestamps_seconds: [0.5, 2.5], manifest_path: 'qa/explicit-sheet.json' })
  expect(result.isError).toBe(false)
  expect(result.content.filter(block => block.type === 'image')).toHaveLength(1)
  const manifest: unknown = JSON.parse(await readFile(join(h.root, 'qa/explicit-sheet.json'), 'utf8'))
  expect(manifest).toMatchObject({ columns: 3, rows: 3, pages: [{ frames: [
    { cell: 1, index: 1, requested_seconds: 0.5, timestamp_seconds: 0.5, image: { width: 64, height: 48 } },
    { cell: 2, index: 2, requested_seconds: 2.5, timestamp_seconds: 2.5, image: { width: 64, height: 48 } },
  ] }] })
  expect(manifest).not.toHaveProperty('sampling_plan')
}, 30_000)

it('refuses text-only image work before filesystem reads and rejects oversize or conflicting grids', async () => {
  const h = await setup({ maxContactPixels: 1000 })
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  expect((await h.sheet({}, 'text')).isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  for (const args of [{ columns: 0 }, { tile_width: 1 }, { frame_count: 33 }, {},
    { frame_interval_seconds: 0 }, { frame_interval_seconds: 1, frame_count: 2 },
    { strategy: 'scene', timestamps_seconds: [1] }]) {
    expect((await h.sheet(args)).isError).toBe(true)
  }
})

it('supports interval and scene sampling and bounds the complete page output', async () => {
  const h = await setup()
  const result = await h.sheet({ frame_interval_seconds: 1, end_seconds: 4, manifest_path: 'qa/interval.json' })
  expect(result.isError).toBe(false)
  const manifest: unknown = JSON.parse(await readFile(join(h.root, 'qa/interval.json'), 'utf8'))
  expect(manifest).toMatchObject({ pages: [{ frames: [{ requested_seconds: 0 }, { requested_seconds: 1 },
    { requested_seconds: 2 }, { requested_seconds: 3 }] }] })
  const scene = await h.sheet({ strategy: 'scene', frame_count: 4 })
  expect(scene.isError).toBe(false)
  const limited = await setup({ maxContactBytes: 1024 })
  const overflow = await limited.sheet({})
  expect(overflow.isError).toBe(true)
  expect(JSON.stringify(overflow.content)).toContain('maxContactBytes')
}, 30_000)

it('retains unviewed cut sides in scene overviews and returns transition and continuation advice', async () => {
  const h = await setup({ sceneThreshold: 0.01 })
  const result = await h.sheet({ strategy: 'scene', frame_count: 1, end_seconds: 3, manifest_path: 'qa/scene-overview.json' })
  expect(result.isError).toBe(false)
  const manifest = JSON.parse(await readFile(join(h.root, 'qa/scene-overview.json'), 'utf8')) as VideoContactSheet
  expect(manifest.sampling_plan?.selected).toHaveLength(1)
  expect(manifest.sampling_plan?.deferred).toEqual(expect.arrayContaining([
    expect.objectContaining({ reasons: ['after_scene_cut'] }),
  ]))
  expect(manifest.next_start_seconds).toBe(3)
  expect(result.value).toMatchObject({ sampling_plan: manifest.sampling_plan })
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(text).toContain('not confirmed story scene transitions')
  expect(text).toContain('silent intervals and gradual fades')
  expect(text).toContain('video_inspect strategy=scene_dialogue or video_contact_sheet strategy=scene')
  expect(text).toContain('next_start_seconds')
  expect(text).toContain('"deferred"')
}, 30_000)

it('presents overview source locations and refuses an unresolved image route without filesystem work', async () => {
  const h = await setup({ maxContactRangeSeconds: 1 })
  const tool = h.ctx.tools.get('video_contact_sheet')
  expect(tool?.presentCall?.({ file_path: h.input })).toMatchObject({ kind: 'read', locations: [{ path: h.input }] })
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  expect((await h.sheet({}, 'vision', false)).isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  const result = await h.sheet({ frame_count: 1, start_seconds: 1 })
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ interval: { start_seconds: 1, end_seconds: 2 }, next_start_seconds: 2 })
}, 30_000)

it('refuses missing, non-file and oversized overview sources before probing', async () => {
  const h = await setup({ maxSourceBytes: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  for (const file_path of [h.root, 'missing.mp4', h.input]) expect((await h.sheet({ file_path })).isError).toBe(true)
  expect(spawn).not.toHaveBeenCalled()
}, 30_000)

it.each([{ maxDurationSeconds: 1 }, { maxSourcePixels: 1 }])(
  'refuses overview deployment limits %j before frame extraction', async (config) => {
    const h = await setup(config)
    const run = vi.spyOn(h.ctx.subprocess, 'spawn')
    const result = await h.sheet({})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('deployment limits')
    expect(run.mock.calls).toHaveLength(1)
    expect(run.mock.calls[0]?.[0].argv).toContain('-show_entries')
  }, 30_000)

it.each(['missing-timestamp', 'negative-timestamp', 'past-end', 'invalid-number', 'missing-image'] as const)(
  'refuses %s contact extraction without publishing an overview', async (mode) => {
    const h = await setup()
    const original = Media.runMedia
    vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
      if (!args[1].includes('-frames:v')) return await original(...args)
      const diagnostic = { 'missing-timestamp': '', 'negative-timestamp': 'pts_time:-1', 'past-end': 'pts_time:4',
        'invalid-number': 'pts_time:1e999', 'missing-image': 'pts_time:1' }[mode]
      return { bytes: mode === 'missing-image' ? Buffer.alloc(0) : Buffer.from('unverified image'), diagnostic }
    })
    const result = await h.sheet({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/refused-sheet.json' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('verifiable timestamp')
    await expect(readFile(join(h.root, 'qa/refused-sheet.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

it('refuses an overview when its source changes before publication', async () => {
  const h = await setup()
  const save = h.ctx.attachments.saveImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockImplementation(async (input) => {
    const ref = await save(input)
    await appendFile(h.input, 'changed')
    return ref
  })
  const result = await h.sheet({ timestamps_seconds: [1], manifest_path: 'qa/changed-sheet.json' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('Video changed')
  await expect(readFile(join(h.root, 'qa/changed-sheet.json'))).rejects.toMatchObject({ code: 'ENOENT' })
}, 30_000)

it('refuses outside-workspace overview manifests and mismatched readback', async () => {
  const h = await setup()
  const outside = await h.sheet({ timestamps_seconds: [1], manifest_path: '../outside-sheet.json' })
  expect(outside.isError).toBe(true)
  expect(JSON.stringify(outside.content)).toContain('inside the workspace')
  vi.spyOn(h.ctx.fs, 'readText').mockResolvedValueOnce('changed externally')
  const changed = await h.sheet({ timestamps_seconds: [1], manifest_path: 'qa/readback-sheet.json' })
  expect(changed.isError).toBe(true)
  expect(JSON.stringify(changed.content)).toContain('readback did not match')
}, 30_000)

it('returns decoded source frames with original timestamps, durable image references and a verified manifest', async () => {
  const h = await setup()
  const result = await h.call({ start_seconds: 0, end_seconds: 4, timestamps_seconds: [0.5, 2.5], manifest_path: 'qa/inspection.json' })
  expect(result.isError).toBe(false)
  const images = result.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(2)
  expect(images[0]!.attachment.attachmentId).not.toBe(images[1]!.attachment.attachmentId)
  for (const image of images) {
    expect(image.attachment).toMatchObject({ width: 64, height: 48 })
    const stored = await h.ctx.attachments.readImage(image.attachment)
    expect(stored.data.byteLength).toBe(image.attachment.bytes)
  }
  const manifest: unknown = JSON.parse(await readFile(join(h.root, 'qa/inspection.json'), 'utf8'))
  expect(manifest).toMatchObject({ duration_seconds: 4, has_audio: false, inspection: 'sampled_frames', verified_readback: true,
    frames: [{ requested_seconds: 0.5, timestamp_seconds: 0.5 }, { requested_seconds: 2.5, timestamp_seconds: 2.5 }] })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('not continuous viewing'))).toBe(true)
  const repeated = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/inspection.json' })
  expect(repeated.isError).toBe(true)
  const retained = JSON.parse(await readFile(join(h.root, 'qa/inspection.json'), 'utf8')) as { frames: unknown[] }
  expect(retained.frames).toHaveLength(2)
}, 30_000)

it('encodes JPEG observations with the configured quantizer and source timestamps', async () => {
  const h = await setup({ frameFormat: 'jpeg', frameJpegQuality: 3 })
  const run = vi.spyOn(Media, 'runMedia')
  const result = await h.call({ timestamps_seconds: [0.5, 2.5], end_seconds: 4, manifest_path: 'qa/jpeg.json' })
  expect(result.isError).toBe(false)
  const images = result.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(2)
  for (const image of images) {
    expect(image.attachment).toMatchObject({ mediaType: 'image/jpeg', width: 64, height: 48 })
    const stored = await h.ctx.attachments.readImage(image.attachment)
    expect(Array.from(stored.data.slice(0, 2))).toEqual([0xff, 0xd8])
  }
  expect(run.mock.calls.filter(call => call[1].includes('mjpeg'))).toHaveLength(2)
  expect(run.mock.calls.find(call => call[1].includes('mjpeg'))?.[1]).toEqual(expect.arrayContaining(['-q:v', '3']))
  const manifest: unknown = JSON.parse(await readFile(join(h.root, 'qa/jpeg.json'), 'utf8'))
  expect(manifest).toMatchObject({ frames: [{ timestamp_seconds: 0.5 }, { timestamp_seconds: 2.5 }] })
  expect(() => VideoInspect.Config({
    // @ts-expect-error Config parsing must reject an unsupported deployment encoding.
    frameFormat: 'webp',
  })).toThrow()
  for (const frameJpegQuality of [0, 32]) {
    expect(() => VideoInspect.Config({ frameJpegQuality })).toThrow()
  }
}, 30_000)

it('rejects a text-only model before filesystem or media work while permitting metadata-only reads', async () => {
  const h = await setup()
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  const call = await h.call({}, 'text')
  expect(call.isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  const metadata = await h.call({ method: 'metadata', manifest_path: 'qa/metadata.json' }, 'text')
  expect(metadata.isError).toBe(false)
  expect(metadata.content.every(block => block.type === 'text')).toBe(true)
}, 30_000)

it('refuses out-of-workspace manifest paths and detects source mutation before publication', async () => {
  const h = await setup()
  const outside = await h.call({ method: 'metadata', manifest_path: '../outside.json' })
  expect(outside.isError).toBe(true)
  const original = h.ctx.attachments.saveImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockImplementation(async (input) => {
    const ref = await original(input)
    await appendFile(h.input, 'changed')
    return ref
  })
  const changed = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/changed.json' })
  expect(changed.isError).toBe(true)
  expect(changed.content.some(block => block.type === 'text' && block.text.includes('changed'))).toBe(true)
}, 30_000)

it('refuses source limits before starting FFprobe', async () => {
  const h = await setup({ maxSourceBytes: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  expect((await h.call({ method: 'metadata' })).isError).toBe(true)
  expect(spawn).not.toHaveBeenCalled()
}, 30_000)

it('validates probe payloads instead of inferring dimensions or duration', () => {
  for (const raw of [{}, { format: { duration: 'bad' }, streams: [] }, { format: { duration: '4' }, streams: [{ codec_type: 'audio' }] }]) {
    expect(() => parseVideoMetadata(Buffer.from(JSON.stringify(raw)))).toThrow()
  }
})

it('refuses source image areas above the deployment limit before extracting frames', async () => {
  const h = await setup({ maxSourcePixels: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await h.call({ timestamps_seconds: [1], end_seconds: 4 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('dimensions exceed'))).toBe(true)
  expect(spawn).toHaveBeenCalledOnce()
}, 30_000)

it('bounds concurrent inspections and waits for owned cancellation when the plugin is removed', async () => {
  const h = await setup({ maxConcurrent: 1 })
  const entered = Promise.withResolvers<undefined>()
  vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockImplementationOnce(async (_provider, _model, signal) => {
    if (!signal) throw new Error('inspection cancellation signal missing')
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const reason: unknown = signal.reason
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      }, { once: true })
      entered.resolve(undefined)
    })
  })
  const first = h.call({})
  await entered.promise
  const second = await h.call({ method: 'metadata' })
  expect(second.isError).toBe(true)
  expect(second.content.some(block => block.type === 'text' && block.text.includes('busy'))).toBe(true)
  await h.video.dispose()
  expect((await first).isError).toBe(true)
}, 30_000)

it('rejects an unresolved image route, while metadata remains callable without an agent', async () => {
  const h = await setup()
  const resolve = vi.spyOn(h.ctx.fs, 'resolve')
  const unresolved = await h.call({}, 'vision', 'none')
  expect(unresolved.isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  vi.spyOn(h.ctx.llm, 'resolveModelInfo').mockResolvedValueOnce({ provider: 'test', id: 'vision', name: 'vision' })
  expect((await h.call({})).isError).toBe(true)
  expect(resolve).not.toHaveBeenCalled()
  expect((await h.call({ method: 'metadata' }, 'vision', 'none')).isError).toBe(false)
}, 30_000)

it('uses agent options when no request route is materialized and marks the next uninspected interval', async () => {
  const h = await setup({ maxRangeSeconds: 1, defaultFrames: 1, maxFrames: 1 })
  const result = await h.call({ start_seconds: 1 }, 'vision', 'options')
  expect(result.isError).toBe(false)
  expect(result.value).toMatchObject({ interval: { start_seconds: 1, end_seconds: 2 }, next_start_seconds: 2 })
  expect(result.meta).toMatchObject({ frameCount: 1, interval: { start_seconds: 1, end_seconds: 2 } })
  const tool = h.ctx.tools.get('video_inspect')
  expect(tool?.isConcurrencySafe?.({ file_path: h.input })).toBe(true)
}, 30_000)

it('reports an actual audio stream with separate speech-transcription advice', async () => {
  const h = await setup()
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-y', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10:d=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const result = await h.call({ method: 'metadata' })
  expect(result.value).toMatchObject({ has_audio: true })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('Use audio_transcribe for spoken dialogue'))).toBe(true)
}, 30_000)

it('rejects non-file and unknown-size sources before probing', async () => {
  const h = await setup()
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  for (const file_path of [h.root, 'missing.mp4']) expect((await h.call({ method: 'metadata', file_path })).isError).toBe(true)
  const original = h.ctx.fs.stat.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'stat').mockImplementationOnce(async (...args) => {
    const info = await original(...args)
    if (!info) throw new Error('fixture video stat unavailable')
    const { size: _size, ...unknownSize } = info
    return unknownSize
  })
  expect((await h.call({ method: 'metadata' })).isError).toBe(true)
  expect(spawn).not.toHaveBeenCalled()
}, 30_000)

it('refuses source duration beyond the configured maximum before decoding', async () => {
  const h = await setup({ maxDurationSeconds: 1 })
  const spawn = vi.spyOn(h.ctx.subprocess, 'spawn')
  const result = await h.call({})
  expect(result.content.some(block => block.type === 'text' && block.text.includes('duration exceeds'))).toBe(true)
  expect(spawn).toHaveBeenCalledOnce()
}, 30_000)

it.each(['missing-timestamp', 'negative-timestamp', 'past-end', 'invalid-number', 'missing-image'] as const)(
  'refuses %s extraction output without publishing a manifest', async (mode) => {
    const h = await setup()
    const original = Media.runMedia
    vi.spyOn(Media, 'runMedia').mockImplementation(async (...args) => {
      if (args[1][0] !== h.config.ffmpegPath && !args[1].includes('-frames:v')) return await original(...args)
      const diagnostic = { 'missing-timestamp': '', 'negative-timestamp': 'pts_time:-1', 'past-end': 'pts_time:4',
        'invalid-number': 'pts_time:1e999', 'missing-image': 'pts_time:1' }[mode]
      return { bytes: mode === 'missing-image' ? Buffer.alloc(0) : Buffer.from('unverified image'), diagnostic }
    })
    const result = await h.call({ timestamps_seconds: [1], end_seconds: 4, manifest_path: 'qa/refused.json' })
    expect(result.content.some(block => block.type === 'text' && block.text.includes('verifiable source timestamp'))).toBe(true)
    await expect(readFile(join(h.root, 'qa/refused.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

it('fails publication when manifest readback differs from the written inspection', async () => {
  const h = await setup()
  vi.spyOn(h.ctx.fs, 'readText').mockResolvedValueOnce('changed externally')
  const result = await h.call({ method: 'metadata', manifest_path: 'qa/readback.json' })
  expect(result.content.some(block => block.type === 'text' && block.text.includes('readback did not match'))).toBe(true)
  expect(JSON.parse(await readFile(join(h.root, 'qa/readback.json'), 'utf8'))).toMatchObject({ inspection: 'metadata' })
}, 30_000)

it('refuses a prepared inspection after its plugin has been unloaded', async () => {
  const h = await setup()
  const tool = h.ctx.tools.get('video_inspect')
  if (!tool) throw new Error('video tool unavailable')
  const args = { method: 'metadata', file_path: h.input }
  const prepared = await new ToolExecutionPipeline(h.ctx).prepare({ callId: ToolCallId('prepared-video'),
    name: 'video_inspect', arguments: args, signal: new AbortController().signal })
  if (prepared.kind !== 'dispatch') throw new Error('video call was not prepared')
  await h.video.dispose()
  await expect(tool.execute(args, prepared.exec)).rejects.toThrow('unavailable')
}, 30_000)

it('rejects an inconsistent default sample count at plugin load', async () => {
  await expect(setup({ maxFrames: 1, defaultFrames: 2 })).rejects.toThrow('defaultFrames')
})


it('uses actual cut detection and ASR timing to sample a clip while persisting all deferred observations', async () => {
  const h = await setup({ maxFrames: 2, defaultFrames: 2, sceneThreshold: 0.01 })
  const transcript = join(h.root, 'transcript.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '红画面说话', speaker_id: 'job-a:0' },
    { start: 2, end: 3, text: '蓝画面说话', speaker_id: 'job-a:1' }]))
  const result = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, start_seconds: 0, end_seconds: 4, manifest_path: 'qa/adaptive.json' })
  expect(result.isError).toBe(false)
  const saved = JSON.parse(await readFile(join(h.root, 'qa/adaptive.json'), 'utf8')) as VideoInspect.VideoInspection
  expect(saved.frames).toHaveLength(2)
  expect(saved.sampling_plan?.selected.map(point => point.reasons)).toEqual([['before_scene_cut'], ['after_scene_cut']])
  expect(saved.sampling_plan?.deferred.map(point => point.time)).toEqual([0.5, 1, 2.5, 3])
  expect(saved.sampling_plan?.deferred[0]).not.toHaveProperty('utterances')
  expect(saved.transcript_source?.path).toBe(transcript)
  expect(saved.frames[0]!.timestamp_seconds).toBeLessThan(2)
  expect(saved.frames[1]!.timestamp_seconds).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(result.content)).toContain('do not identify characters or verify timbre')
  const followup = await h.call({ start_seconds: 0, end_seconds: 2, timestamps_seconds: [0.5, 1] })
  expect(followup.isError).toBe(false)
  expect(followup.content.filter(block => block.type === 'image')).toHaveLength(2)
  const detailed = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, end_seconds: 1, frame_count: 2,
    manifest_path: 'qa/utterance.json' })
  expect(detailed.isError).toBe(false)
  const utterance = JSON.parse(await readFile(join(h.root, 'qa/utterance.json'), 'utf8')) as VideoInspect.VideoInspection
  expect(utterance.sampling_plan?.selected.find(point => point.time === 0.5)?.utterances).toEqual([
    { start: 0, end: 1, text: '红画面说话', text_truncated: false, speaker_id: 'job-a:0' },
  ])
}, 30_000)

it('rejects incompatible adaptive inputs, missing transcripts and source mutation during extraction', async () => {
  const h = await setup()
  for (const args of [{ method: 'metadata', strategy: 'scene_dialogue' }, { strategy: 'scene_dialogue', timestamps_seconds: [1] },
    { transcript_path: 'no-file.json' }, { strategy: 'scene_dialogue', transcript_path: 'no-file.json' }]) expect((await h.call(args)).isError).toBe(true)
  const transcript = join(h.root, 'transcript.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '台词' }]))
  const original = h.ctx.attachments.saveImage.bind(h.ctx.attachments)
  vi.spyOn(h.ctx.attachments, 'saveImage').mockImplementation(async (input) => {
    const image = await original(input)
    await appendFile(transcript, ' ')
    return image
  })
  const result = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, end_seconds: 4 })
  expect(result.isError).toBe(true)
  expect(result.content.some(block => block.type === 'text' && block.text.includes('Transcript changed'))).toBe(true)
}, 30_000)


it('samples actual later scene intervals without a transcript and rejects a transcript changed while it is read', async () => {
  const h = await setup()
  const later = await h.call({ strategy: 'scene_dialogue', start_seconds: 2, end_seconds: 4 })
  expect(later.isError).toBe(false)
  const images = later.content.filter(block => block.type === 'image')
  expect(images).toHaveLength(6)
  const transcript = join(h.root, 'read-race.json')
  await writeFile(transcript, JSON.stringify([{ start: 0, end: 1, text: '台词' }]))
  const original = h.ctx.fs.readBytes.bind(h.ctx.fs)
  vi.spyOn(h.ctx.fs, 'readBytes').mockImplementation(async (target, signal, maxBytes) => {
    const result = await original(target, signal, maxBytes)
    await appendFile(transcript, ' ')
    return result
  })
  const raced = await h.call({ strategy: 'scene_dialogue', transcript_path: transcript, end_seconds: 4 })
  expect(raced.isError).toBe(true)
  expect(raced.content.some(block => block.type === 'text' && block.text.includes('Transcript changed during adaptive planning'))).toBe(true)
}, 30_000)

it('excludes a real cut at the requested interval end before detector metadata is emitted', async () => {
  const h = await setup({ maxFrames: 2, defaultFrames: 2, sceneThreshold: 0.01 })
  const result = await h.call({ strategy: 'scene_dialogue', start_seconds: 0, end_seconds: 2, manifest_path: 'qa/boundary.json' })
  expect(result.isError).toBe(false)
  const saved = JSON.parse(await readFile(join(h.root, 'qa/boundary.json'), 'utf8')) as VideoInspect.VideoInspection
  expect(saved.sampling_plan?.selected.map(point => point.reasons)).toEqual([['uniform_checkpoint'], ['uniform_checkpoint']])
  expect(saved.sampling_plan?.deferred).toEqual([])
  expect(saved.frames.every(frame => frame.timestamp_seconds < 2)).toBe(true)
}, 30_000)
it('cancels an in-flight OCR bridge to quiescence and releases its shared inspection slot', async () => {
  const h = await setup({ maxConcurrent: 1, ocrFrameIntervalSeconds: 1 })
  const original = Media.runMedia
  const run = mockWindowsOcr()
  let ready!: () => void
  const entered = new Promise<void>((resolve) => { ready = resolve })
  let settled = false
  run.mockImplementation(async (...args) => {
    if (!args[1].some(value => value.endsWith('ocr_bridge.ps1'))) return await original(...args)
    ready()
    try {
      return await new Promise<never>((_resolve, reject) => {
        const signal = args[3]!
        if (signal.aborted) reject(new Error('OCR bridge stopped'))
        else signal.addEventListener('abort', () => { reject(new Error('OCR bridge stopped')) }, { once: true })
      })
    } finally { settled = true }
  })
  const controller = new AbortController()
  const pending = h.ocr({ end_seconds: 1, raw_json_path: 'qa/cancel.json', merged_text_path: 'qa/cancel.txt' }, controller.signal)
  await entered
  const busy = await h.ocr({ end_seconds: 1 })
  expect(busy.isError).toBe(true)
  expect(JSON.stringify(busy.content)).toContain('busy')
  controller.abort(new Error('Stop OCR'))
  expect((await pending).isError).toBe(true)
  expect(settled).toBe(true)
  await expect(readFile(join(h.root, 'qa/cancel.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(h.root, 'qa/cancel.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await h.video.dispose()
  expect(h.ctx.tools.get('video_ocr')).toBeUndefined()
})

it('reports real decoded PTS and preserves the visual frame selected at the requested time', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'color=c=black:size=64x48:rate=5:d=0.2', '-f', 'lavfi', '-i', 'color=c=white:size=64x48:rate=5:d=0.8',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  let firstImage: Buffer | undefined
  run.mockImplementation(async (...args) => {
    if (args[1].some(value => value.endsWith('ocr_bridge.ps1'))) {
      const input = JSON.parse(args[4].stdin ?? '{}') as { frames: { image_base64: string }[] }
      firstImage = Buffer.from(input.frames[0]!.image_base64, 'base64')
    }
    return await recognize(...args)
  })
  const result = await h.ocr({ raw_json_path: 'qa/actual-pts.json', merged_text_path: 'qa/actual-pts.txt' })
  expect(result.value).toMatchObject({ scan_status: 'complete' })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/actual-pts.json'), 'utf8')) as {
    evidence_algorithm: string
    frames: { requested_seconds: number; timestamp_seconds: number }[] }
  expect(raw.evidence_algorithm).toBe('decoded-pts-spatial-v2')
  expect(raw.frames.map(frame => [frame.requested_seconds, frame.timestamp_seconds])).toEqual([[0, 0], [0.5, 0.4]])
  expect(firstImage).toBeDefined()
  const { data } = await sharp(firstImage).raw().toBuffer({ resolveWithObject: true })
  expect(data[0]).toBeLessThan(10)
})

it.each([1, 2, 6])('reuses the source frame actually displayed across low-frame-rate windows with batch size %s', async (batchSize) => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: batchSize })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=1:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  mockWindowsOcr()
  const result = await h.ocr({ raw_json_path: 'qa/low-fps.json', merged_text_path: 'qa/low-fps.txt' })
  expect(result.value).toMatchObject({ scan_status: 'complete', coverage: { planned_frame_count: 6, processed_frame_count: 6 } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/low-fps.json'), 'utf8')) as { frames: { timestamp_seconds: number }[] }
  expect(raw.frames.map(frame => frame.timestamp_seconds)).toEqual([0, 0, 1, 1, 2, 2])
}, 30_000)

it.each(['recovered context', 'still missing', 'short zero context', 'nonzero origin', 'unordered PTS',
  'decoded PTS mismatch', 'decoded time base mismatch', 'probe clock mismatch'] as const)(
  'requires independently verified frame context after an incomplete seek probe: %s', async (variant) => {
    const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 1 })
    const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
    const queries: string[] = []
    let decodedImage: Uint8Array | undefined, recognizedImage: Buffer | undefined
    run.mockImplementation(async (...args) => {
      const output = await recognize(...args), argv = args[1]
      if (!argv.includes('-read_intervals')) {
        if (argv.some(value => value.endsWith('ocr_bridge.ps1'))) {
          const input = JSON.parse(args[4].stdin!) as { frames: { image_base64: string }[] }
          recognizedImage = Buffer.from(input.frames[0]!.image_base64, 'base64')
        }
        if (!argv.includes('mjpeg')) return output
        decodedImage = splitMjpeg(output.bytes)[0]
        const diagnostic = variant === 'decoded PTS mismatch'
          ? output.diagnostic.replace(/\bpts:\s*([+-]?\d+)(\s+pts_time:)/u, (_match, pts: string, tail: string) => 'pts:' + String(Number(pts) + 1) + tail)
          : variant === 'decoded time base mismatch' ? output.diagnostic.replace(/config in time_base:\s*\S+/u, 'config in time_base: 2/1,')
            : output.diagnostic
        return { ...output, diagnostic }
      }
      const query = argv[argv.indexOf('-read_intervals') + 1]
      if (query === undefined) throw Error('Missing actual probe query')
      queries.push(query)
      const actual = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
        streams: { time_base: string }[]
        frames: { best_effort_timestamp_time: string }[]
      }
      const stream = actual.streams[0]
      if (stream === undefined) throw Error('Missing real source time base for the context fixture')
      const [numerator, denominator] = stream.time_base.split('/').map(Number)
      const secondPts = Number(denominator) / Number(numerator)
      if (!Number.isSafeInteger(secondPts)) throw Error('Fixture does not expose integral second PTS')
      if (query.startsWith('0%') && ['recovered context', 'decoded PTS mismatch', 'decoded time base mismatch', 'probe clock mismatch'].includes(variant)) {
        if (variant !== 'probe clock mismatch') return output
        const first = actual.frames[0]
        if (first === undefined) throw Error('Missing real frame for the probe clock negative control')
        first.best_effort_timestamp_time = '0.000001'
        return { ...output, bytes: Buffer.from(JSON.stringify(actual)) }
      }
      const frame = { best_effort_timestamp: 0, best_effort_timestamp_time: '0.000000', duration_time: '1.000000' }
      let frames = queries.length === 1 ? [frame] : []
      if (variant === 'short zero context') frames = queries.length === 1
        ? [{ ...frame, best_effort_timestamp: secondPts * 2, best_effort_timestamp_time: '2.000000' }] : [frame]
      if (variant === 'unordered PTS') frames = [{ ...frame, best_effort_timestamp: secondPts, best_effort_timestamp_time: '1.000000' }, frame]
      return { ...output, bytes: Buffer.from(JSON.stringify({
        format: { start_time: variant === 'nonzero origin' ? '3' : '0' },
        streams: [{ ...stream, start_time: variant === 'nonzero origin' ? '3' : '0' }],
        frames,
      })) }
    })
    const result = await h.ocr({ start_seconds: 1, end_seconds: 2, raw_json_path: 'qa/context.json' })
    if (variant === 'nonzero origin') {
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('非零或未知起点')
    } else {
      expect(result.value).toMatchObject({ scan_status: variant === 'recovered context' ? 'complete' : 'failed', coverage: {
        planned_frame_count: 1, processed_frame_count: variant === 'recovered context' ? 1 : 0,
        failed_frame_count: variant === 'recovered context' ? 0 : 1,
      } })
    }
    expect(queries).toEqual(variant === 'nonzero origin' || variant === 'unordered PTS' ? ['1%3']
      : variant === 'short zero context' ? ['1%3', '0%3'] : ['1%3', '1%4', '0%4'])
    if (variant === 'recovered context') {
      const raw = JSON.parse(await readFile(join(h.root, 'qa/context.json'), 'utf8')) as { frames: { timestamp_seconds: number }[] }
      expect(raw.frames.map(frame => frame.timestamp_seconds)).toEqual([1])
      expect(recognizedImage).toEqual(Buffer.from(decodedImage!))
      const pixel = await sharp(recognizedImage).removeAlpha().raw().toBuffer()
      expect(pixel[0]).toBeGreaterThan(240)
      expect(pixel[2]).toBeLessThan(10)
    } else expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
  }, 30_000,
)

it('uses displayed source frame timestamps on variable-rate video and exact frame boundaries', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 5 })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=10:duration=3', '-vf', 'select=eq(n\\,0)+eq(n\\,3)+eq(n\\,12)+eq(n\\,20)',
    '-fps_mode', 'vfr', '-c:v', 'libx264', '-bf', '0', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  mockWindowsOcr()
  const result = await h.ocr({ raw_json_path: 'qa/vfr.json', merged_text_path: 'qa/vfr.txt' })
  expect(result.value).toMatchObject({ scan_status: 'complete', coverage: { planned_frame_count: 5, processed_frame_count: 5 } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/vfr.json'), 'utf8')) as { frames: { timestamp_seconds: number }[] }
  expect(raw.frames.map(frame => frame.timestamp_seconds)).toEqual([0, 0.3, 0.3, 1.2, 2])
}, 30_000)

it('reads beyond a batch boundary to resolve reordered B frames at a requested time', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.49, ocrBatchFrames: 1 })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=100:duration=3', '-c:v', 'libx264', '-g', '120', '-bf', '8', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  mockWindowsOcr()
  const result = await h.ocr({ start_seconds: 1.96, end_seconds: 2.45,
    raw_json_path: 'qa/bframes.json', merged_text_path: 'qa/bframes.txt' })
  expect(result.value).toMatchObject({ scan_status: 'complete', coverage: { planned_frame_count: 1, processed_frame_count: 1 } })
  const raw = JSON.parse(await readFile(join(h.root, 'qa/bframes.json'), 'utf8')) as { frames: { timestamp_seconds: number }[] }
  expect(raw.frames.map(frame => frame.timestamp_seconds)).toEqual([1.96])
}, 30_000)

it('fails closed with an actionable error for nonzero source timestamp origins', async () => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5 })
  const ffmpeg = await h.ctx.subprocess.resolveExecutable(h.config.ffmpegPath)
  await runMedia(h.ctx, [ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i',
    'testsrc2=size=64x48:rate=10:duration=2', '-c:v', 'libx264', '-output_ts_offset', '3', '-pix_fmt', 'yuv420p', h.input],
  { mode: 'danger-full-access', workspaceRoot: h.root }, undefined, { timeoutMs: 20_000, maxBytes: 1024, graceMs: 1000 })
  mockWindowsOcr()
  const result = await h.ocr({ raw_json_path: 'qa/nonzero.json', merged_text_path: 'qa/nonzero.txt' })
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('非零或未知起点')
  await expect(readFile(join(h.root, 'qa/nonzero.json'))).rejects.toThrow()
}, 30_000)

it.each(['duplicate timestamp', 'missing timestamp', 'unknown final duration'])
('does not issue complete OCR when frame probing returns %s', async (variant) => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 2 })
  const run = mockWindowsOcr(), original = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    if (!args[1].includes('-read_intervals')) return await original(...args)
    const frame = { best_effort_timestamp: 0, best_effort_timestamp_time: '0', duration_time: '1' }
    const frames = variant === 'duplicate timestamp' ? [frame, { ...frame, best_effort_timestamp_time: '0.5' }]
      : variant === 'missing timestamp' ? [{ duration_time: '1' }] : [{ best_effort_timestamp: 0, best_effort_timestamp_time: '0' }]
    return { bytes: Buffer.from(JSON.stringify({ format: { start_time: '0' }, streams: [{ start_time: '0', time_base: '1/10240' }], frames })), diagnostic: '' }
  })
  const result = await h.ocr({ end_seconds: 1, raw_json_path: `qa/${variant}.json`, merged_text_path: `qa/${variant}.txt` })
  expect(result.value).toMatchObject({ scan_status: 'failed', coverage: { processed_frame_count: 0, failed_frame_count: 2 } })
  expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
})

it.each([null, 'invalid', {}, { frames: null }, { frames: [] }, { frames: [], streams: null },
  { frames: [], streams: [] }, { frames: [], streams: [{}, {}] }])(
  'rejects malformed frame-probe metadata without a context query: %j', async (metadata) => {
    const h = await setup({ ocrFrameIntervalSeconds: 1, ocrBatchFrames: 1 })
    const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
    const queries: string[] = []
    run.mockImplementation(async (...args) => {
      if (!args[1].includes('-read_intervals')) return await recognize(...args)
      const query = args[1][args[1].indexOf('-read_intervals') + 1]
      if (query === undefined) throw Error('Missing malformed probe query')
      queries.push(query)
      return { bytes: Buffer.from(JSON.stringify(metadata)), diagnostic: '' }
    })
    expect((await h.ocr({ start_seconds: 1, end_seconds: 2 })).value).toMatchObject({ scan_status: 'failed', coverage: {
      planned_frame_count: 1, processed_frame_count: 0, failed_frame_count: 1,
    } })
    expect(queries).toEqual(['1%3'])
    expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
  },
)

it.each(['missing format', 'packet duration only'] as const)('validates the actual probe boundary with %s', async (variant) => {
  const h = await setup({ ocrFrameIntervalSeconds: 0.5, ocrBatchFrames: 8 })
  const run = mockWindowsOcr(), recognize = run.getMockImplementation()!
  run.mockImplementation(async (...args) => {
    const output = await recognize(...args)
    if (!args[1].includes('-read_intervals')) return output
    const value = JSON.parse(Buffer.from(output.bytes).toString('utf8')) as {
      format?: unknown
      frames: { duration_time?: string; pkt_duration_time?: string }[]
    }
    if (variant === 'missing format') delete value.format
    else for (const frame of value.frames) {
      if (frame.duration_time !== undefined) frame.pkt_duration_time = frame.duration_time
      delete frame.duration_time
    }
    return { ...output, bytes: Buffer.from(JSON.stringify(value)) }
  })
  const result = await h.ocr({ end_seconds: 4 })
  if (variant === 'missing format') {
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('非零或未知起点')
    expect(run.mock.calls.filter(call => call[1].includes('-read_intervals'))).toHaveLength(1)
    expect(run.mock.calls.some(call => call[1].some(value => value.endsWith('ocr_bridge.ps1')))).toBe(false)
  } else expect(result.value).toMatchObject({ scan_status: 'complete', coverage: {
    planned_frame_count: 8, processed_frame_count: 8, failed_frame_count: 0,
  } })
})
