/** Fixed FFprobe facts for synthetic media; subtitle code and file writes remain real. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { projectSubtitleFixtureReport } from './report-fixture.mjs'

export const name = 'subtitle-probe-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario composition. */
export function apply(ctx) {
  // Normalize only platform-dependent separators in the model projection. Keep
  // the validated canonical value, timing, findings and filesystem effects intact.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'call_subtitle_timing' || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false)
    const report = await projectSubtitleFixtureReport(JSON.parse(result.content[0].text), process.cwd())
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] }
  })
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'subtitle-timing-fixture-ffprobe') return original(command, args, options)
      assert.equal(basename(args.at(-1)), 'media.mp4')
      assert.ok(Array.isArray(options.stdio) && typeof options.stdio[1] === 'number')
      const child = new EventEmitter()
      queueMicrotask(() => {
        writeSync(options.stdio[1], JSON.stringify({
          streams: [
            { codec_type: 'video', codec_name: 'h264', width: 1440, height: 2560,
              avg_frame_rate: '60/1', r_frame_rate: '60/1' },
            { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
          ],
          format: { duration: '1.2', size: '1000', bit_rate: '8000000' },
        }))
        child.emit('close', 0)
      })
      return child
    }
    syncBuiltinESMExports()
    return () => {
      childProcess.spawn = original
      syncBuiltinESMExports()
    }
  })
}
