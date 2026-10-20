/** Offline OCR process bytes retain Unicode through the real tool and filesystem. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const [{ SubprocessRuntime }, { FsVersion }] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-subprocess', new URL('../../../apps/cli/package.json', import.meta.url)),
  importSnapshotPackage('@deepseek-ai/dsh-fs', new URL('../../../apps/cli/package.json', import.meta.url)),
])

const TEXT = ['简体：门已经打开。', '繁體：門已經打開。', 'English: The door is open.', 'Emoji: 🎬🙂']
const SOURCE = 'Synthetic local video bytes for UTF-8 OCR regression.\n'
const FRAME_UUID = '00000000-0000-4000-8000-000000000001'

export const name = 'snapshot-ocr-utf8'
export const inject = ['fs', 'tools', 'llm', 'agents']

/** Install deterministic external process inputs and verify actual Unicode artifacts.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless composition.
 */
export function apply(ctx) {
  const commands = [], running = new Set()
  let frameEntropy = false
  ctx.effect(() => {
    const resolve = ctx.fs.resolve.bind(ctx.fs), stat = ctx.fs.stat.bind(ctx.fs)
    const randomUUID = crypto.randomUUID
    let displayTargets
    const displays = () => displayTargets ??= Promise.all(['fixture.mp4', 'qa/ocr.json', 'qa/ocr.txt']
      .map(async display => [(await resolve(display, { cwd: process.cwd() })).targetKey, display]))
      .then(entries => new Map(entries))
    ctx.fs.resolve = async (path, options) => {
      const target = await resolve(path, options)
      // Keep the real target key while fixing only its temporary-root display input.
      const displayPath = (await displays()).get(target.targetKey)
      return displayPath === undefined ? target : { ...target, displayPath }
    }
    ctx.fs.stat = async (target, signal) => {
      const info = await stat(target, signal)
      return info && (await displays()).get(target.targetKey) === 'fixture.mp4'
        ? { ...info, version: FsVersion('fixture-video-version') } : info
    }
    crypto.randomUUID = (...args) => frameEntropy ? FRAME_UUID : randomUUID(...args)
    syncBuiltinESMExports()
    return () => {
      ctx.fs.resolve = resolve
      ctx.fs.stat = stat
      crypto.randomUUID = randomUUID
      syncBuiltinESMExports()
    }
  })

  class OcrMedia extends SubprocessRuntime {
    async resolveExecutable(command) { return command }
    async terminalEnvironment() { return { platform: 'posix' } }
    async spawnTerminal() { throw new Error('The OCR UTF-8 fixture does not allocate terminals') }
    spawn(spec) {
      spec.signal?.throwIfAborted()
      commands.push([...spec.argv])
      let bytes, diagnostic = ''
      switch (spec.argv[0]) {
        case 'ffprobe':
          assert.equal(basename(spec.argv.at(-1)), 'fixture.mp4')
          bytes = Buffer.from(JSON.stringify({ format: { duration: '1' },
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 360 }] }))
          break
        case 'ffmpeg':
          assert.equal(spec.argv[spec.argv.indexOf('-frames:v') + 1], '1')
          bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
          diagnostic = '[showinfo] pts_time:0'
          // Entropy is deterministic only between the frame-output and bridge-input boundaries.
          frameEntropy = true
          break
        case 'ocr-fixture-python': {
          frameEntropy = false
          assert.deepEqual(spec.argv.slice(1, 5), ['-I', '-B', '-X', 'utf8'], 'Python must select UTF-8 despite a legacy host code page')
          assert.equal(basename(spec.argv[5]), 'ocr_bridge.py')
          const input = JSON.parse(spec.stdio.stdin.data)
          assert.equal(input.language, 'auto')
          assert.equal(input.frames.length, 1)
          assert.equal(input.frames[0].id, `frame-${FRAME_UUID}`)
          bytes = Buffer.from(JSON.stringify({ ok: true, language_used: 'auto', frames: [{
            id: input.frames[0].id, timestamp_seconds: input.frames[0].timestamp_seconds,
            image_width: 640, image_height: 360,
            lines: TEXT.map((text, index) => ({ text,
              bounding_box: { x: 10, y: 20 + index * 40, width: 300, height: 30 }, words: [] })),
          }] }), 'utf8')
          break
        }
        default: throw new Error(`Unexpected external command: ${spec.argv[0]}`)
      }
      const handle = { terminated: false }
      running.add(handle)
      return { stdin: undefined, stdout: Readable.from([bytes]), stderr: undefined, control: undefined,
        collected: { stderr: { readFrom: () => ({ text: diagnostic, nextOffset: diagnostic.length, lossy: false }) } },
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() { handle.terminated = true },
        async waitForExit() { assert.ok(handle.terminated); running.delete(handle); return true },
      }
    }
  }
  ctx.plugin(OcrMedia)
  ctx.on('tools/pre-execute', (exec, next) => {
    assert.equal(exec.name, 'video_ocr', 'This local OCR regression calls no ASR or cloud tool')
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (commands.length) {
      assert.deepEqual(commands.map(argv => argv[0]), ['ffprobe', 'ffmpeg', 'ocr-fixture-python'])
      assert.deepEqual(commands[2].slice(1, 5), ['-I', '-B', '-X', 'utf8'], 'The real OCR call requires Python UTF-8 mode')
      assert.equal(running.size, 0, 'Every external media process reaches awaited exit')
      const result = options.messages.flatMap(message => message.content)
        .find(block => block.type === 'text' && block.text.includes('"preview_segments"'))
      assert.ok(result, 'The next real model request contains the OCR tool preview')
      const preview = JSON.parse(result.text)
      assert.equal(preview.scan_status, 'complete')
      assert.deepEqual(preview.preview_segments.map(segment => segment.text), TEXT)
      const cwd = ctx.agents.get(options.sessionId).session.header.cwd
      const raw = JSON.parse(await readFile(join(cwd, 'qa/ocr.json'), 'utf8'))
      assert.deepEqual(raw.frames[0].lines.map(line => line.text), TEXT)
      assert.deepEqual(raw.segments.map(segment => segment.text), TEXT)
      assert.deepEqual(raw.segments.map(({ evidence_frame_ids, ...segment }) => ({
        ...segment, evidence_frame_count: evidence_frame_ids.length,
      })), preview.preview_segments)
      const merged = await readFile(join(cwd, 'qa/ocr.txt'), 'utf8')
      assert.deepEqual(merged.split('\n').slice(7, -1),
        TEXT.map(text => `[00:00:00.000 - 00:00:01.000] [content_candidate] ${text}`))
      assert.equal(await readFile(join(cwd, 'fixture.mp4'), 'utf8'), SOURCE)
      assert.ok(!JSON.stringify({ raw, merged, preview }).includes('\ufffd'), 'No replacement character enters either OCR artifact')
    }
    yield* next()
  })
}
