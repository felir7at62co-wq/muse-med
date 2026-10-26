/** Stub prepare's external media inputs; keep the renderer, filesystem, tool results and Session real. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

export const name = 'subtitle-visual-session-media-fixture'
export const inject = ['tools']

const seedFiles = ['project_config.json', 'shots.json', 'source.mp4', 'source.srt', 'timeline-reset.json',
  'receipts.json', 'transcript/jobs/source-v1.json', 'transcript/raw/source-v1.json']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

/** @param {import('@deepseek-ai/cordis').Context} ctx - Private scenario composition. */
export async function apply(ctx) {
  const cwd = process.cwd(), pending = new Set(), commands = []
  const before = await Promise.all(seedFiles.map(async path => digest(await readFile(join(cwd, path)))))
  const visual = (await readJson(join(cwd, 'project_config.json'))).project_bible.delivery.subtitle_visual
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'subtitle-visual-fixture-ffmpeg' && command !== 'subtitle-visual-fixture-ffprobe') {
        return original(command, args, options)
      }
      assert.ok(Array.isArray(options.stdio) && typeof options.stdio[1] === 'number')
      commands.push({ command, args: [...args] })
      const child = new EventEmitter()
      let settle
      const done = new Promise(resolve => { settle = resolve })
      pending.add(done)
      queueMicrotask(() => {
        let code = 0
        try {
          if (command === 'subtitle-visual-fixture-ffprobe') {
            assert.equal(basename(args.at(-1)), 'source.mp4')
            writeSync(options.stdio[1], JSON.stringify({ streams: [
              { codec_type: 'video', codec_name: 'h264', width: 480, height: 854, avg_frame_rate: '24/1', r_frame_rate: '24/1' },
              { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            ], format: { duration: '5', size: '5000000', bit_rate: '8000000' } }))
          } else {
            assert.equal(basename(args.at(-1)), '01.wav', 'only prepare master execution is stubbed')
            assert.ok(args.includes('-filter_complex'))
            writeFileSync(args.at(-1), 'Synthetic prepared master; not acoustic evidence.\n')
          }
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
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!['call_visual_prepare', 'call_visual_reset_layout', 'call_visual_speech'].includes(exec.callId)
      || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false)
    const report = JSON.parse(result.content[0].text)
    assert.equal(report.ok, true)
    assert.equal(commands.length, 2, 'only prepare probes and prepares media; layout reset and speech never spawn it')
    const timeline = await readJson(join(cwd, 'editing/01-timeline.json'))
    assert.deepEqual(timeline.delivery.subtitle_visual, visual, 'prepare must persist the complete project visual section')
    if (exec.callId === 'call_visual_prepare') {
      assert.equal(report.render_preview.subtitle.font_size_output_px, 52)
      assert.equal(report.render_preview.subtitle.center_y_output_px, 597.8)
      assert.equal(report.render_preview.subtitle.max_width_output_px, 432)
      assert.ok(!Object.hasOwn(report.render_preview.delivery, 'subtitle_visual'))
    }
    if (exec.callId === 'call_visual_reset_layout') {
      assert.deepEqual(report.written, [])
      assert.equal(report.subtitle_layout.status, 'not_requested')
      assert.equal(report.subtitle_layout.measured_texts, 0)
      assert.deepEqual(report.subtitle_layout.preview_paths, [])
      assert.ok(report.warnings.some(warning => warning.includes('未启用 subtitle_visual')))
      await assert.rejects(access(join(cwd, 'exports')), { code: 'ENOENT' })
    }
    if (exec.callId === 'call_visual_speech') {
      const coverage = report.speech_coverage
      assert.equal(coverage.evidence_complete, true)
      assert.equal(coverage.listening_verified, false)
      assert.deepEqual(coverage.findings.map(finding => [finding.kind, finding.text]), [['recognized_without_subtitle', '啦']])
      assert.deepEqual(coverage.matches.map(match => match.text), ['做', '饭'])
      assert.deepEqual(report.written, [])
      assert.deepEqual(await Promise.all(seedFiles.map(async path => digest(await readFile(join(cwd, path))))), before)
      await assert.rejects(access(join(cwd, 'exports')), { code: 'ENOENT' })
      await writeFile(join(cwd, 'session-observations.json'), JSON.stringify({
        media_execution: 'external prepare fixture; no glyph or acoustic measurement',
        visual_snapshotted: timeline.delivery.subtitle_visual,
        layout_reset: 'not_requested; no media execution or layout files',
        matched_text: coverage.matches.map(match => match.text).join(''),
        extra_recognized_text: coverage.findings.map(finding => finding.text),
        evidence_complete: coverage.evidence_complete, listening_verified: coverage.listening_verified,
        media_command_count: commands.length, inputs_unchanged: true, added_bgm: false,
      }, null, 2) + '\n', { flag: 'wx' })
    }
    return decision
  })
}
