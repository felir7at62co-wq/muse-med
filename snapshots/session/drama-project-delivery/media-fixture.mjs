/** Stub only external media execution; the shipped renderer and persisted artifacts stay real. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { basename } from 'node:path'
import { captureInputs, projectDeliveryArtifacts, projectDeliveryPaths, verifyDeliveryArtifacts } from './artifact-fixture.mjs'

export const name = 'project-delivery-media-fixture'
export const inject = ['tools']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Private scenario composition. */
export async function apply(ctx) {
  const cwd = process.cwd()
  const sourceHashes = await captureInputs(cwd)
  const commands = []
  const pending = new Set()
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'project-delivery-fixture-ffmpeg' && command !== 'project-delivery-fixture-ffprobe') {
        return original(command, args, options)
      }
      assert.ok(Array.isArray(options.stdio) && typeof options.stdio[1] === 'number')
      commands.push({ command, args: [...args] })
      const child = new EventEmitter()
      let settled
      const done = new Promise(resolve => { settled = resolve })
      pending.add(done)
      queueMicrotask(() => {
        let code = 0
        try {
        if (command === 'project-delivery-fixture-ffprobe') {
          assert.ok(['source.mp4', 'candidate.mp4'].includes(basename(args.at(-1))))
          writeSync(options.stdio[1], JSON.stringify({
            streams: [
              { codec_type: 'video', codec_name: 'h264', width: 480, height: 854,
                avg_frame_rate: '24/1', r_frame_rate: '24/1' },
              { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            ],
            format: { duration: '5', size: '5000000', bit_rate: '8000000' },
          }))
        } else {
          assert.ok(args.includes('-y'), 'only actual file-producing media commands are expected')
          writeFileSync(args.at(-1), 'fixture encoded media\n')
        }
        } catch (error) {
          code = 1
          child.emit('error', error)
        } finally {
          child.emit('close', code)
          pending.delete(done)
          settled()
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
    if (!['call_delivery_prepare', 'call_delivery_render'].includes(exec.callId) || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false)
    const report = JSON.parse(result.content[0].text)
    await verifyDeliveryArtifacts({ cwd, report, sourceHashes, commands })
    if (exec.callId === 'call_delivery_render') await projectDeliveryArtifacts({ cwd, report, commands, sourceHashes })
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(projectDeliveryPaths(report, cwd), null, 2) }] }
  })
}
