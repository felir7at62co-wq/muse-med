/** Authored system-proxy TLS failure through the real Fanqie client and model-result renderer. */
import { fileURLToPath } from 'node:url'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { Service } = await importSnapshotPackage('@deepseek-ai/cordis',
  new URL('../../../apps/cli/package.json', import.meta.url))
const engine = fileURLToPath(new URL('../../../third_party/plugins/muse-fanqie-download/python/engine.py', import.meta.url))
export const name = 'snapshot-fanqie-proxy-failure'
export const inject = ['tools', 'agents']

class EngineFixture extends Service {
  constructor(ctx) { super(ctx, 'subprocess') }
  async resolveExecutable(value, _cwd, signal) {
    signal.throwIfAborted()
    if (value !== process.execPath) throw new Error('Fanqie snapshot refuses an unrelated executable')
    return value
  }
  spawn(spec) {
    spec.signal.throwIfAborted()
    const request = JSON.parse(spec.stdio.stdin.data)
    if (JSON.stringify(spec.argv) !== JSON.stringify([process.execPath, '-I', '-B', '-X', 'utf8', engine])
      || request.operation !== 'search' || request.query !== '纸灯回声（测试虚构）'
      || request.settings.networkMode !== 'system' || request.staging !== undefined) {
      throw new Error('Fanqie snapshot refuses an unrelated system-proxy request')
    }
    const text = JSON.stringify({ ok: false, complete: false, code: 'URLError',
      sourceStage: 'registration', host: 'log.snssdk.com', networkMode: 'system',
      error: { type: 'URLError', reasonType: 'SSLEOFError', errno: 8,
        message: 'TLS 连接意外关闭（UNEXPECTED_EOF_WHILE_READING）。',
        privateToken: 'fixture-private-error-detail' },
      privateResponse: 'fixture-private-response' })
    const done = Promise.resolve({ exitCode: 1, signal: null })
    return { done, waitForExit: async () => { await done; return true }, terminate() {},
      collected: { stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) } } }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated headless profile context. */
export async function apply(ctx) {
  await ctx.plugin(EngineFixture)
  const provider = await import('../../../third_party/plugins/muse-fanqie-download/src/index.js')
  await ctx.plugin(provider, { pythonExecutable: process.execPath, networkMode: 'system' })
}
