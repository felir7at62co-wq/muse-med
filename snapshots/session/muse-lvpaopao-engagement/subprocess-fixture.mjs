/** Synthetic SSH stdio; real Bridge and ToolRuntime still perform their full execution paths. */
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { SubprocessRuntime } = await importSnapshotPackage('@deepseek-ai/dsh-subprocess',
  new URL('../../../apps/cli/package.json', import.meta.url))
const actions = ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status', 'rankings', 'engagement']
const selected = { srcAppId: 'wx0000000000000001', dramaId: 'fixture-drama-01' }

/** The only mocked capability is the managed subprocess and its external JSONL peer. */
export default class OfflineSubprocess extends SubprocessRuntime {
  constructor(ctx) {
    assert.ok(isAbsolute(process.env.DSH_HOME), 'The snapshot must supply its own isolated Harness home')
    const directory = join(process.env.DSH_HOME, 'lvpaopao')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({
      sshExecutable: 'offline-ssh', sshHostAlias: 'offline-target', remotePython: 'C:\\offline\\python.exe',
      remoteHelper: 'C:\\offline\\helper.py', helperSha256: 'a'.repeat(64), cwd: process.cwd(),
      downloadEnabled: false,
    }), { flag: 'wx', mode: 0o600 })
    super(ctx)
    ctx.effect(() => { const clock = mock.method(Date, 'now', () => 1792730976000); return () => clock.mock.restore() })
    this.launches = 0
    this.methods = []
    this.closed = false
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ futureAllow: ['lvpaopao'], includeOwn: true })
    })
    ctx.on('agent/turn-stopping', ({ agent }) => {
      const result = id => {
        const message = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
          && event.data.message.toolCallId === id)?.data.message
        assert.ok(message, `Missing actual Lvpaopao result ${id}`)
        assert.equal(message.isError, false)
        return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      }
      const status = result('call_lvpaopao_status'), search = result('call_lvpaopao_search')
      const episodes = result('call_lvpaopao_episodes'), engagement = result('call_lvpaopao_engagement')
      assert.equal(status.status, 'waiting-target'); assert.equal(status.data.ready, false)
      assert.equal(search.data.candidates[0].title, '离线纸灯')
      assert.deepEqual(episodes.data.episodeNumbers, [1, 3]); assert.equal(episodes.data.partial, true)
      assert.equal(engagement.status, 'engagement-partial')
      assert.deepEqual(engagement.data.engagement.totals, { likes: 0, comments: null, recommendations: 9, shares: 12 })
      assert.equal(engagement.data.engagement.knownTotals.comments, 4)
      assert.deepEqual(engagement.data.engagement.episodes.map(row => row.episodeNo), [1, 2, 3])
      assert.equal(this.launches, 1)
      assert.deepEqual(this.methods, ['status', 'search', 'episodes', 'detail', 'episodes', 'engagement', 'engagement', 'engagement'])
      writeFileSync(join(agent.session.header.cwd, 'bridge-proof.json'), JSON.stringify({
        sshLaunches: this.launches, nativeMethods: this.methods, status: status.status,
        inventedSearchTitle: search.data.candidates[0].title,
        actualEpisodeNumbers: episodes.data.episodeNumbers, partial: episodes.data.partial,
        engagementStatus: engagement.status, totals: engagement.data.engagement.totals, nativeDownloadCalls: 0, realExternalCalls: 0,
      }, null, 2) + '\n')
    })
    ctx.effect(() => () => {
      assert.equal(this.closed, true, 'The real shared bridge must close its owned synthetic peer')
    })
  }

  spawn(spec) {
    assert.equal(++this.launches, 1, 'All operations must borrow a single Host-owned connection')
    assert.equal(spec.argv[0], 'offline-ssh')
    assert.ok(spec.argv.includes('offline-target'))
    const stdin = new PassThrough(), stdout = new PassThrough(), settled = Promise.withResolvers()
    let buffered = ''
    const reply = frame => stdout.write(JSON.stringify(frame) + '\n')
    const result = (frame, value) => reply({ protocol: 1, type: 'result', id: frame.id, value })
    stdin.on('data', chunk => {
      buffered += chunk.toString()
      for (;;) {
        const end = buffered.indexOf('\n'); if (end === -1) break
        const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1)
        if (frame.type === 'close') {
          this.closed = true
          reply({ protocol: 1, type: 'event', event: 'closed', details: { status: 'control-close',
            cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } })
          stdout.end(); settled.resolve({ exitCode: 0, signal: null }); continue
        }
        assert.equal(frame.type, 'request')
        if (frame.method === 'hello') {
          assert.deepEqual(frame.params, { expected_app_id: 'wx404dde55fb12df78', helper_sha256: 'a'.repeat(64) })
          reply({ protocol: 1, type: 'event', event: 'waiting_target', details: {} })
          result(frame, { protocol_version: 1, helper_sha256: 'a'.repeat(64), expected_app_id: 'wx404dde55fb12df78', actions, ready: false })
          continue
        }
        this.methods.push(frame.method)
        if (frame.method === 'status') {
          result(frame, { status: 'waiting_target', expectedAppId: 'wx404dde55fb12df78', ready: false })
        } else if (frame.method === 'search') {
          assert.deepEqual(frame.params, { query: '离线纸灯' })
          reply({ protocol: 1, type: 'event', event: 'ready', details: {} })
          result(frame, { operation: 'search', status: 'search-returned', identityMatched: true,
            resultCount: 1, partial: false,
            candidates: [{ title: '离线纸灯', srcAppId: selected.srcAppId, originDramaId: selected.dramaId }] })
        } else if (frame.method === 'detail') {
          result(frame, { operation: 'detail', status: 'detail-returned', identityMatched: true, ...selected, title: '离线纸灯', episodeCount: 3 })
        } else if (frame.method === 'engagement') {
          const number = frame.params.episodeNo
          assert.ok([1, 2, 3].includes(number))
          result(frame, { operation: 'engagement', status: 'engagement-returned', identityMatched: true, ...selected,
            episodeNo: number, observedAtMs: 1792730976000, counts: { likes: 0, comments: number === 2 ? null : 2, recommendations: 3, shares: 4 } })
        } else if (frame.method === 'episodes' && frame.params.count === 3) {
          result(frame, { operation: 'episodes', status: 'episodes-returned', identityMatched: true, ...selected,
            episodeCount: 3, requestedStart: 1, requestedEndExclusive: 4, episodeNumbers: [1, 2, 3], partial: false })
        } else if (frame.method === 'episodes') {
          assert.deepEqual(frame.params, { ...selected, start: 1, count: 4 })
          result(frame, { operation: 'episodes', status: 'episodes-returned', identityMatched: true, ...selected,
            episodeCount: 4, requestedStart: 1, requestedEndExclusive: 5, episodeNumbers: [1, 3], partial: true })
        } else throw Error('The offline fixture refuses any unplanned native operation')
      }
    })
    return { stdin, stdout, done: settled.promise, collected: {},
      terminate() { throw Error('The real bridge must use acknowledged cleanup instead of killing this peer') },
      async waitForExit() { await settled.promise; return true },
    }
  }
}
