/** Offline bootstrap errors and recovery through the production shared bridge and tool executor. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
const { SubprocessRuntime } = await importSnapshotPackage('@deepseek-ai/dsh-subprocess', new URL('../../../apps/cli/package.json', import.meta.url))

/** Replace only subprocess IO; every tool result is produced by the real adapter. */
export default class OfflineSetup extends SubprocessRuntime {
  constructor(ctx) {
    super(ctx)
    const home = process.env.DSH_HOME
    assert.ok(home)
    const cwd = join(home, 'lvpaopao', 'runtime', 'passive-probe', 'next-stage')
    mkdirSync(cwd, { recursive: true })
    const helper = join(cwd, 'run-persistent-host.py'), source = '# offline helper\n'
    writeFileSync(helper, source, { flag: 'wx', mode: 0o600 })
    this.configuration = { transport: 'local', localPython: process.execPath, localHelper: helper, cwd,
      helperSha256: createHash('sha256').update(source).digest('hex') }
    this.setups = 0; this.helpers = 0; this.methods = []; this.closed = false
    ctx.on('agent/created', ({ agent }) => { agent.ctx.tools.restrict({ futureAllow: ['lvpaopao'], includeOwn: true }) })
    ctx.on('agent/turn-stopping', ({ agent }) => {
      const result = id => {
        const message = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === id)?.data.message
        assert.ok(message); assert.equal(message.isError, false)
        return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      }
      for (const id of ['call_lvpaopao_status', 'call_lvpaopao_search']) {
        const failure = result(id)
        assert.equal(failure.ok, false); assert.equal(failure.status, 'mac-isolated-wechat-required')
        assert.match(failure.warnings[0], /status once/)
      }
      const recovered = result('call_lvpaopao_recover'), search = result('call_lvpaopao_query')
      assert.equal(recovered.data.ready, true, JSON.stringify(recovered)); assert.equal(recovered.data.hostLoginState, false)
      assert.match(recovered.warnings[0], /not desktop WeChat login/)
      assert.equal(search.data.candidates[0].title, '离线纸灯')
      assert.equal(this.setups, 2); assert.equal(this.helpers, 1); assert.deepEqual(this.methods, ['status', 'search'])
      writeFileSync(join(agent.session.header.cwd, 'setup-proof.json'), JSON.stringify({ setupLaunches: this.setups,
        helperLaunches: this.helpers, nativeMethods: this.methods, ready: recovered.data.ready,
        auxiliaryLoginState: recovered.data.hostLoginState, realExternalCalls: 0 }, null, 2) + '\n')
    })
    ctx.effect(() => () => { assert.equal(this.closed, true) })
  }

  spawn(spec) {
    assert.equal(spec.argv[0], process.execPath)
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough(), settled = Promise.withResolvers()
    const preparation = spec.argv.includes('--prepare')
    const text = preparation ? (++this.setups === 1
      ? JSON.stringify({ error: { code: 'mac-isolated-wechat-required' } }) : JSON.stringify(this.configuration)) : ''
    const exitCode = preparation && this.setups === 1 ? 1 : 0
    if (preparation) queueMicrotask(() => settled.resolve({ exitCode, signal: null }))
    else {
      assert.equal(++this.helpers, 1)
      let buffer = ''
      const reply = frame => stdout.write(JSON.stringify({ protocol: 1, ...frame }) + '\n')
      stdin.on('data', chunk => {
        buffer += chunk.toString()
        for (;;) {
          const end = buffer.indexOf('\n'); if (end === -1) break
          const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
          if (frame.type === 'close') {
            this.closed = true
            reply({ type: 'event', event: 'closed', details: { status: 'control-close', cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } })
            stdout.end(); settled.resolve({ exitCode: 0, signal: null }); continue
          }
          let value
          if (frame.method === 'hello') value = { protocol_version: 1, helper_sha256: this.configuration.helperSha256,
            expected_app_id: 'wx404dde55fb12df78', actions: ['status', 'search', 'detail', 'episodes', 'download_first_episode'], ready: true }
          else {
            this.methods.push(frame.method)
            value = { operation: frame.method, status: `${frame.method}-returned`, identityMatched: true, hostLoginState: false, timedOut: false }
            if (frame.method === 'search') {
              assert.deepEqual(frame.params, { query: '离线纸灯' })
              value.candidates = [{ title: '离线纸灯', srcAppId: 'wx0000000000000001', originDramaId: 'fixture-drama-01' }]
            } else assert.equal(frame.method, 'status')
          }
          reply({ type: 'result', id: frame.id, value })
        }
      })
    }
    return { stdin, stdout, stderr, done: settled.promise,
      collected: { stdout: { readFrom() { return { text, nextOffset: Buffer.byteLength(text), lossy: false } } } },
      terminate() { assert.ok(preparation, 'The helper must close through acknowledged cleanup') },
      async waitForExit() { await settled.promise; return true },
    }
  }
}
