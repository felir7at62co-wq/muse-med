/** Control external media facts while production render preflight, file publication and both executor paths remain real. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

export const name = 'subtitle-visual-preflight-media-fixture'
export const inject = ['tools']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated ordinary Loader context. */
export async function apply(ctx) {
  const { buildSourceRecord, sourceRecordPathFor, writeSourceRecord } = await importSnapshotModule(
    new URL('../../../packages/drama/tool-episode-render/src/source-record.ts', import.meta.url),
    new URL('../../../packages/drama/tool-episode-render/lib/types/source-record.js', import.meta.url),
  )
  const cwd = process.cwd(), project = join(cwd, '.dsh', 'visual-project')
  for (const folder of ['editing', 'audio', 'video/01', 'exports']) await mkdir(join(project, folder), { recursive: true })
  const family = 'Zhuque Fangsong (technical preview)'
  const delivery = { visual_medium: 'animation_3d', width: 480, height: 854, fps: 24, subtitle_visual: {
    schema_version: 1, reference_width: 480, reference_height: 854, font_size_px: 46, outline_px: 1.25,
    center_y_ratio: 0.736747073, max_width_ratio: 0.9, font_family: family } }
  const raw = '1\n00:00:00,125 --> 00:00:00,875\n' + String.raw`你好，\N世界！` + '\n'
  await writeFile(join(project, 'project_config.json'), JSON.stringify({ project_bible: { visual_medium: 'animation_3d', delivery } }))
  await writeFile(join(project, 'editing/01-timeline.json'), JSON.stringify({
    clips: [{ shot: 1, start_us: 0, duration_us: 1000000 }], body_end: 1, delivery }))
  await writeFile(join(project, 'editing/01.srt'), raw)
  await writeFile(join(project, 'audio/01.wav'), 'controlled original audio')
  await writeFile(join(project, 'bed.wav'), 'controlled selected music')
  await writeFile(join(project, 'video/01/shot_001.mp4'), 'controlled original video')
  await writeFile(join(project, 'mix.json'), '{"schema_version":1,"mode":"no_bgm","analysis_window_ms":100}')
  const previous = join(project, 'exports/previous.mp4'), priorBytes = 'previous reviewed delivery'
  await writeFile(previous, priorBytes)
  const recordPath = sourceRecordPathFor(previous)
  await writeSourceRecord(recordPath, buildSourceRecord({ episode: '01', output: previous, outputSha256: hash(priorBytes),
    sizeBytes: Buffer.byteLength(priorBytes), durationSeconds: 1, inputs: [], encoder: 'retained', checks: [], now: new Date(0) }))
  const priorRecord = await readFile(recordPath), priorStat = await stat(previous), recordStat = await stat(recordPath)
  const calls = [], pending = new Set()
  let completed = 0
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'visual-preflight-ffmpeg' && command !== 'visual-preflight-ffprobe') return original(command, args, options)
      const child = new EventEmitter()
      assert.ok(Array.isArray(options.stdio) && typeof options.stdio[1] === 'number' && typeof options.stdio[2] === 'number')
      calls.push({ command, args: [...args] })
      let settle
      const done = new Promise(resolve => { settle = resolve })
      pending.add(done)
      queueMicrotask(() => {
        let code = 0
        try {
          if (command === 'visual-preflight-ffprobe') {
            writeSync(options.stdio[1], JSON.stringify({ streams: [
              { codec_type: 'video', codec_name: 'h264', width: 480, height: 854, avg_frame_rate: '24/1', r_frame_rate: '24/1' },
              { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            ], format: { duration: '1', size: '1000000', bit_rate: '8000000' } }))
          } else if (args.some(arg => arg.includes('bbox=min_val=1'))) {
            const face = completed === 0 ? 'SystemFallback' : 'ZhuqueFangsong-Regular'
            writeSync(options.stdio[2], `fontselect: (${family}, 400, 0) -> ${face}, 0, ${face}\n`
              + '[Parsed_bbox] x1:500 x2:599 y1:300 y2:329 w:100 h:30\n')
            for (const path of args.filter(arg => arg.endsWith('.png'))) writeFileSync(path, 'controlled probe image')
          } else if (args.at(-1) !== '-') writeFileSync(args.at(-1), 'controlled encoded bytes')
        } catch (error) {
          code = 1
          child.emit('error', error)
        } finally {
          child.emit('close', code)
          pending.delete(done)
          settle()
        }
      })
      return child
    }
    syncBuiltinESMExports()
    return async () => {
      childProcess.spawn = original
      syncBuiltinESMExports()
      await Promise.all(pending)
    }
  })
  const results = []
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.name !== 'drama_render' || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false, JSON.stringify(result))
    const report = JSON.parse(result.content[0].text)
    const actual = { ok: report.ok, failedChecks: report.checks.filter(check => !check.ok && check.severity === 'failure').map(check => check.id),
      encodedShots: report.encoded_shots }
    assert.equal(await readFile(join(project, 'editing/01.srt'), 'utf8'), raw)
    assert.equal(await readFile(previous, 'utf8'), priorBytes)
    assert.deepEqual(await readFile(recordPath), priorRecord)
    assert.equal((await stat(previous)).ino, priorStat.ino)
    assert.equal((await stat(previous)).dev, priorStat.dev)
    assert.equal((await stat(recordPath)).ino, recordStat.ino)
    assert.equal((await stat(recordPath)).dev, recordStat.dev)
    if (completed === 0) {
      assert.deepEqual(actual, { ok: false, failedChecks: ['subtitle_display_font'], encodedShots: [] })
      assert.equal(report.output, '')
      const probes = calls.filter(call => call.command === 'visual-preflight-ffprobe')
      const layout = calls.filter(call => call.command === 'visual-preflight-ffmpeg')
      assert.ok(probes.length > 0)
      assert.ok(layout.length > 0, 'font refusal must still perform a real bbox layout probe')
      assert.equal(calls.length, probes.length + layout.length)
      assert.ok(layout.every(call => call.args.some(arg => arg.includes('bbox=min_val=1'))))
    } else {
      assert.equal(completed, 1)
      assert.deepEqual(actual, { ok: true, failedChecks: [], encodedShots: [1] })
      assert.deepEqual(report.checks.filter(check => check.id.startsWith('subtitle_display_')).map(check => check.ok), [true, true, true])
      assert.ok(calls.some(call => call.args.includes('libx264')))
      const output = join(project, 'exports/candidate.mp4')
      assert.equal(report.output, output)
      const record = JSON.parse(await readFile(sourceRecordPathFor(output), 'utf8'))
      assert.equal(record.output.sha256, hash(await readFile(output)))
      assert.equal(await readFile(report.render_preview.subtitle.path, 'utf8'), '1\n00:00:00,125 --> 00:00:00,875\n你好 世界\n')
    }
    results.push(actual)
    completed++
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(actual) }] }
  })
  const observed = new Set()
  ctx.on('llm/stream', async function* (options, next) {
    for (const message of options.messages) {
      if (message.role !== 'tool' || !['call_preflight_refuse', 'call_preflight_render'].includes(message.toolCallId)) continue
      const index = message.toolCallId === 'call_preflight_refuse' ? 0 : 1
      const text = message.content[0].text
      assert.doesNotThrow(() => JSON.parse(text), text)
      assert.deepEqual(JSON.parse(text), results[index])
      observed.add(index)
    }
    if (observed.size === 2) await writeFile(join(cwd, 'subtitle-preflight-proof.json'), JSON.stringify({
      refusalBeforeBody: true, priorMp4BytesAndInodePreserved: true, priorSourceRecordBytesAndInodePreserved: true,
      originalSrtPreserved: true, repairedDisplayText: '你好 世界', activeVisualChecks: 3,
      controlledBodyCommandsObserved: true, seenRefusalAndSuccessInModelRequests: true,
    }, null, 2) + '\n', { flag: 'wx' })
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(completed, 2); assert.equal(observed.size, 2) })
}
