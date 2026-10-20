/** Replay local capability reporting and full skill guidance without cloud transcription. */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const [{ SubprocessRuntime }, { FsVersion }] = await Promise.all([
  importSnapshotPackage('@deepseek-ai/dsh-subprocess', new URL('../../../packages/perception/tool-video-inspect/package.json', import.meta.url)),
  importSnapshotPackage('@deepseek-ai/dsh-fs', new URL('../../../packages/perception/tool-video-inspect/package.json', import.meta.url)),
])

class CapabilityMedia extends SubprocessRuntime {
  async resolveExecutable(command) { return command }
  async terminalEnvironment() { return { platform: 'posix' } }
  async spawnTerminal() { throw new Error('The OCR capability fixture does not allocate terminals') }
  spawn(spec) {
    spec.signal?.throwIfAborted()
    assert.equal(spec.argv[0], 'ffprobe', 'Unsupported-platform OCR only probes the bounded source')
    const bytes = Buffer.from(JSON.stringify({ format: { duration: '4' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 64, height: 48 }] }))
    return { stdin: undefined, stdout: Readable.from([bytes]), stderr: undefined, control: undefined,
      collected: { stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }), terminate() {}, waitForExit: async () => true }
  }
}

export const name = 'snapshot-ocr-capability'
export const inject = ['fs', 'tools', 'llm', 'agents']

/** Install only deterministic external probe output and validate actual request guidance.
 * @param ctx - Shipped Headless composition.
 */
export function apply(ctx) {
  ctx.plugin(CapabilityMedia)
  const original = ctx.fs.stat.bind(ctx.fs)
  ctx.effect(() => {
    ctx.fs.stat = async (target, signal) => {
      const info = await original(target, signal)
      return info && target.displayPath.endsWith('fixture.mp4')
        ? { ...info, version: FsVersion('fixture-video-version') } : info
    }
    return () => { ctx.fs.stat = original }
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    assert.ok(!exec.name.includes('transcribe'), 'Capability reporting does not execute paid ASR')
    return next()
  })
  ctx.on('llm/stream', async function* (options, next) {
    const text = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text.includes('<skill_content name="transcript-to-novel">')) {
      for (const phrase of ['优先复用用户已提供', 'persistent_text_candidate', '稳定位置不是非剧情水印证据',
        '已获授权的 ASR', '只有明确 `queue_full` 的尚未受理任务或未提交集',
        'OCR 的 JSON、TXT 与 ASR 原稿分文件保存', '不由分流绕过授权', '不补写漏掉的对白']) {
        assert.ok(text.includes(phrase), `The actual model request retains ${phrase}`)
      }
      assert.ok(!text.includes('只有完成计划扫描、没有可用字幕'), 'Unsupported OCR does not block explicitly authorized ASR')
    }
    if (text.includes('"failure_code":"windows_only"')) {
      assert.ok(text.includes('"text_status":"indeterminate"'), 'Unsupported OCR never means no subtitles')
      assert.ok(text.includes('<skill_content name="transcript-to-novel">'), 'Recovery request retains the loaded guide')
      const cwd = ctx.agents.get(options.sessionId).session.header.cwd
      const raw = JSON.parse(await readFile(join(cwd, '.dsh/ocr/raw.json'), 'utf8'))
      assert.equal(raw.text_source, 'ocr')
      assert.equal(raw.path, join(cwd, 'fixture.mp4'))
      assert.equal(raw.scan_status, 'failed')
      assert.equal(raw.text_status, 'indeterminate')
      assert.equal(raw.coverage.failed_frame_count, 2)
      assert.equal(raw.coverage.processed_frame_count, 0)
      const merged = await readFile(join(cwd, '.dsh/ocr/text.txt'), 'utf8')
      assert.ok(merged.includes('Text source: ocr') && merged.includes('Text status: indeterminate'),
        'Both actual source-labelled artifacts are readable before the recovery request')
    }
    yield* next()
  })
}
