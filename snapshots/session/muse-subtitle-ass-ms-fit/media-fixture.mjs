/** Control external prepare media only; assert actual display files, source bytes and the following model request. */
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync, writeSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

export const name = 'subtitle-ass-ms-session-media-fixture'
export const inject = ['tools']
const hash = value => createHash('sha256').update(value).digest('hex')

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Loader context. */
export async function apply(ctx) {
  const cwd = process.cwd(), project = join(cwd, '.dsh', 'subtitle-project')
  const raw = '1\n00:00:01,000 --> 00:00:01,700\n' + String.raw`做，\N饭！\n好` + '\n'
  const source = 'Controlled source bytes; not decoded-media evidence.\n'
  const words = [{ text: '做', start: 1, end: 1.2 }, { text: '饭', start: 1.2, end: 1.4 },
    { text: '好', start: 1.5, end: 1.7 }]
  const transcript = JSON.stringify([{ start: 1, end: 1.7, text: '做饭好', words }]) + '\n'
  await mkdir(join(project, 'transcript', 'jobs'), { recursive: true })
  await mkdir(join(project, 'transcript', 'raw'), { recursive: true })
  const seeds = {
    'project_config.json': JSON.stringify({ project_bible: { visual_medium: 'animation_3d',
      delivery: { width: 480, height: 854, fps: 24 } } }) + '\n',
    'shots.json': '{"shots":[{"shot":1,"video":"source.mp4"}]}\n',
    'source.mp4': source, 'source.srt': raw,
    'receipts.json': '{"shots":[{"shot":1,"receipt":"transcript/jobs/source-v1.json"}]}\n',
    'transcript/jobs/source-v1.json': JSON.stringify({ status: 'complete', source: 'source.mp4',
      sourceSha256: hash(source), stem: 'source', version: 1 }) + '\n',
    'transcript/raw/source-v1.json': transcript,
  }
  for (const [path, bytes] of Object.entries(seeds)) await writeFile(join(project, path), bytes, { flag: 'wx' })
  const commands = [], pending = new Set()
  ctx.effect(() => {
    const original = childProcess.spawn
    childProcess.spawn = function (command, args, options) {
      if (command !== 'subtitle-ass-ms-fixture-ffmpeg' && command !== 'subtitle-ass-ms-fixture-ffprobe') {
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
          if (command === 'subtitle-ass-ms-fixture-ffprobe') {
            assert.equal(basename(args.at(-1)), 'source.mp4')
            writeSync(options.stdio[1], JSON.stringify({ streams: [
              { codec_type: 'video', codec_name: 'h264', width: 480, height: 854, avg_frame_rate: '24/1', r_frame_rate: '24/1' },
              { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            ], format: { duration: '5', size: '5000000', bit_rate: '8000000' } }))
          } else {
            assert.equal(basename(args.at(-1)), '01.wav', 'Only prepare audio assembly is controlled')
            assert.ok(args.includes('-filter_complex'))
            writeFileSync(args.at(-1), 'Controlled prepared master; not acoustic evidence.\n')
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
  let accepted
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (exec.callId !== 'call_prepare_ass_ms' || decision.kind !== 'accept') return decision
    assert.equal(result.isError, false)
    const report = JSON.parse(result.content[0].text)
    assert.equal(report.ok, true)
    assert.equal(report.method, 'prepare')
    const displayPath = report.render_preview.subtitle.path
    assert.ok(report.written.includes(displayPath), 'The actual prepare result must name its created display SRT')
    const display = await readFile(displayPath, 'utf8')
    assert.equal(display, '1\n00:00:01,000 --> 00:00:01,700\n做 饭 好\n')
    assert.ok(!/\\[Nn]/u.test(display))
    assert.equal(await readFile(join(project, 'editing', '01.srt'), 'utf8'), raw)
    for (const [path, bytes] of Object.entries(seeds)) assert.equal(await readFile(join(project, path), 'utf8'), bytes)
    assert.deepEqual(JSON.parse(await readFile(join(project, 'transcript/raw/source-v1.json'), 'utf8'))[0].words, words)
    assert.equal(commands.length, 2, 'No glyph probe or video encoding is part of this controlled prepare case')
    assert.ok(!report.warnings.some(warning => warning.includes('现有词级转写或字形测量不可用')))
    accepted = { method: 'prepare', displayText: '做 饭 好', startSeconds: 1, endSeconds: 1.7,
      rawSrtUnchanged: true, wordTimesUnchanged: true, createdDisplaySrt: true,
      mediaCommandCount: commands.length, glyphMeasured: false }
    return { kind: 'accept', content: [{ type: 'text', text: JSON.stringify(accepted, null, 2) }] }
  })
  let observed = false
  ctx.on('llm/stream', async function* (options, next) {
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'call_prepare_ass_ms')
    if (result !== undefined) {
      assert.ok(accepted)
      assert.deepEqual(JSON.parse(result.content[0].text), accepted)
      assert.equal(observed, false)
      observed = true
      await writeFile(join(cwd, 'subtitle-ass-ms-proof.json'), JSON.stringify({ ...accepted, seenInNextModelRequest: true }, null, 2) + '\n', { flag: 'wx' })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => { assert.equal(observed, true) })
}
