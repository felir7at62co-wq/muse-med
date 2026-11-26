/** Supply external media facts for a real prepare call over two byte-identical inputs. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { projectDeliveryPaths } from '../drama-project-delivery/artifact-fixture.mjs'

export const name = 'repeated-clip-media-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario composition. */
export function apply(ctx) {
  const cwd = process.cwd()
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'repeated-clip-fixture-ffmpeg' && command !== 'repeated-clip-fixture-ffprobe') {
        return original(command, args, options)
      }
      const child = new EventEmitter()
      queueMicrotask(() => {
        try {
          if (command === 'repeated-clip-fixture-ffprobe') {
            assert.ok(['source.mp4', 'copy.mp4'].includes(basename(args.at(-1))))
            assert.ok(Array.isArray(options.stdio) && typeof options.stdio[1] === 'number')
            writeSync(options.stdio[1], JSON.stringify({
              streams: [
                { codec_type: 'video', codec_name: 'h264', width: 480, height: 854,
                  avg_frame_rate: '24/1', r_frame_rate: '24/1' },
                { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
              ],
              format: { duration: '5', size: '5000000', bit_rate: '8000000' },
            }))
          } else {
            assert.equal(basename(args.at(-1)), '01.wav')
            assert.ok(args.includes('-filter_complex'))
            writeFileSync(args.at(-1), 'controlled master audio\n')
          }
        } catch (error) {
          child.emit('error', error)
          child.emit('close', 1)
          return
        }
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
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'call_repeat_clip_prepare' || decision.kind !== 'accept' || result.isError) return decision
    const report = JSON.parse(result.content[0].text)
    const sourcesPath = join(cwd, 'editing', '01-sources.json')
    const raw = JSON.parse(await readFile(sourcesPath, 'utf8'))
    const projected = projectDeliveryPaths(raw, cwd)
    await writeFile(sourcesPath, JSON.stringify(projected, null, 2) + '\n')
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(projectDeliveryPaths(report, cwd), null, 2) }] }
  })
}
