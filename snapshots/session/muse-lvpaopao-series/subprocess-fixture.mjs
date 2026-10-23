/** External local-helper JSONL only; real Bridge, Session policy, catalog, series persistence and file copies run unchanged. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'

const { SubprocessRuntime } = await importSnapshotPackage('@deepseek-ai/dsh-subprocess',
  new URL('../../../apps/cli/package.json', import.meta.url))
const actions = ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status']
const selected = { srcAppId: 'wx0000000000000002', dramaId: 'fixture-series-02' }, title = '离线纸灯全集'
const helperSource = '# Synthetic external helper bytes. No Python process runs in this snapshot.\n'
const digest = value => createHash('sha256').update(value).digest('hex')
const mediaBytes = number => Buffer.from(`Synthetic episode ${number}; this fixture does not perform a real media decode.\n`)
const episodeName = number => `episode-${String(number).padStart(4, '0')}.mp4`

/** The fixture owns only managed process IO and the synthetic native source files. */
export default class OfflineSubprocess extends SubprocessRuntime {
  constructor(ctx) {
    assert.ok(isAbsolute(process.env.DSH_HOME), 'The snapshot requires its isolated Harness home')
    const directory = join(process.env.DSH_HOME, 'lvpaopao'), native = join(directory, 'synthetic-native')
    mkdirSync(native, { recursive: true, mode: 0o700 })
    const helper = join(native, 'run-persistent-host.py'), helperSha256 = digest(helperSource)
    writeFileSync(helper, helperSource, { mode: 0o600, flag: 'wx' })
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({ transport: 'local', localPython: process.execPath,
      localHelper: helper, helperSha256, cwd: native, downloadEnabled: true }), { mode: 0o600, flag: 'wx' })
    super(ctx)
    this.native = native; this.helper = helper; this.helperSha256 = helperSha256
    this.launches = 0; this.methods = []; this.downloads = new Map(); this.timeline = []; this.closed = false
    ctx.on('agent/created', ({ agent }) => {
      agent.ctx.tools.restrict({ futureAllow: ['lvpaopao'], includeOwn: true })
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next()
      if (exec.name === 'lvpaopao') this.timeline.push({ callId: exec.callId, nativeRequests: this.methods.length, mediaAcquisitions: this.downloads.size })
      return decision
    })
    ctx.on('agent/turn-stopping', async ({ agent }) => {
      const toolResult = id => {
        const message = agent.session.snapshotEvents().find(event => event.type === 'tool/result'
          && event.data.message.toolCallId === id)?.data.message
        assert.ok(message, `Missing real tool result ${id}`); assert.equal(message.isError, false)
        return JSON.parse(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
      }
      const first = toolResult('call_series_download'), status = toolResult('call_series_status'), repeated = toolResult('call_series_repeat')
      for (const result of [first, status, repeated]) {
        assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.status, 'series-complete')
        assert.equal(result.data.series.episodeCount, 2); assert.deepEqual(result.data.series.completedEpisodeNumbers, [1, 2])
      }
      assert.equal(first.data.series.taskId, status.data.series.taskId); assert.equal(first.data.series.taskId, repeated.data.series.taskId)
      assert.deepEqual(this.timeline, [
        { callId: 'call_series_download', nativeRequests: 5, mediaAcquisitions: 2 },
        { callId: 'call_series_status', nativeRequests: 5, mediaAcquisitions: 2 },
        { callId: 'call_series_repeat', nativeRequests: 8, mediaAcquisitions: 2 },
      ])
      const manifest = JSON.parse(await readFile(repeated.data.series.manifestPath, 'utf8'))
      assert.equal(manifest.schemaVersion, 1); assert.deepEqual(manifest.selection.actualEpisodeNumbers, [1, 2])
      assert.equal(manifest.selection.catalogComplete, true); assert.equal(manifest.episodes.length, 2)
      const files = []
      for (const entry of manifest.episodes) {
        assert.equal(entry.state, 'complete'); assert.equal(entry.attempts, 1); assert.match(entry.requestKey, /^[a-f0-9]{64}$/)
        assert.equal(this.downloads.get(entry.requestKey), entry.episodeNo)
        const bytes = await readFile(entry.media.localPath), receipt = JSON.parse(await readFile(entry.media.receiptPath, 'utf8'))
        assert.deepEqual(bytes, mediaBytes(entry.episodeNo)); assert.equal(digest(bytes), entry.media.sha256)
        assert.equal(receipt.idempotencyKey, entry.requestKey); assert.equal(receipt.episodeNo, entry.episodeNo)
        files.push({ episodeNo: entry.episodeNo, bytes: bytes.length, sha256: digest(bytes), attempts: entry.attempts })
      }
      assert.equal(this.launches, 1); assert.equal(this.downloads.size, 2)
      assert.deepEqual(this.methods, ['search', 'detail', 'episodes', 'download_episode', 'download_episode', 'search', 'detail', 'episodes'])
      this.proofPath = join(agent.session.header.cwd, 'bridge-proof.json')
      this.proof = { title, localHelperLaunches: this.launches, nativeMethods: this.methods, completedEpisodes: [1, 2],
        localFiles: files, statusNativeRequests: 0, repeatedDownloadAcquisitions: 0, stableTask: true,
        originalRequestKeysRetained: true, realExternalCalls: 0, realMediaDecodePerformed: false }
      const downloads = join(agent.session.header.cwd, 'downloads')
      assert.deepEqual(await readdir(downloads), ['lvpaopao'])
      await rm(downloads, { recursive: true })
    })
  }

  spawn(spec) {
    assert.equal(++this.launches, 1, 'All tool calls must share one Host-owned local helper')
    assert.deepEqual(spec.argv, [process.execPath, '-u', this.helper, '--rpc-stdio'])
    assert.equal(digest(readFileSync(this.helper)), this.helperSha256)
    const stdin = new PassThrough(), stdout = new PassThrough(), settled = Promise.withResolvers()
    const reply = frame => stdout.write(JSON.stringify(frame) + '\n')
    const result = (frame, value) => reply({ protocol: 1, type: 'result', id: frame.id, value })
    let buffered = ''
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
          assert.deepEqual(frame.params, { expected_app_id: 'wx404dde55fb12df78', helper_sha256: this.helperSha256 })
          result(frame, { protocol_version: 1, helper_sha256: this.helperSha256, expected_app_id: 'wx404dde55fb12df78', actions, ready: true }); continue
        }
        this.methods.push(frame.method)
        if (frame.method === 'search') {
          assert.deepEqual(frame.params, { query: title })
          result(frame, { operation: 'search', status: 'search-returned', identityMatched: true, resultCount: 1, partial: false,
            candidates: [{ title, srcAppId: selected.srcAppId, originDramaId: selected.dramaId }] })
        } else if (frame.method === 'detail') {
          assert.deepEqual(frame.params, selected)
          result(frame, { operation: 'detail', status: 'detail-returned', identityMatched: true, ...selected, title, episodeCount: 2 })
        } else if (frame.method === 'episodes') {
          assert.deepEqual(frame.params, { ...selected, start: 1, count: 2 })
          result(frame, { operation: 'episodes', status: 'episodes-returned', identityMatched: true, ...selected, episodeCount: 2,
            requestedStart: 1, requestedEndExclusive: 3, episodeNumbers: [1, 2], partial: false })
        } else if (frame.method === 'download_episode') {
          assert.deepEqual({ srcAppId: frame.params.srcAppId, dramaId: frame.params.dramaId }, selected)
          assert.ok([1, 2].includes(frame.params.episodeNo)); assert.match(frame.params.idempotencyKey, /^[a-f0-9]{64}$/)
          assert.equal(this.downloads.has(frame.params.idempotencyKey), false, 'A completed acquisition must not replay')
          this.downloads.set(frame.params.idempotencyKey, frame.params.episodeNo)
          const bytes = mediaBytes(frame.params.episodeNo)
          const relativePath = `downloads/${frame.params.idempotencyKey}/media/${episodeName(frame.params.episodeNo)}`
          const file = join(this.native, relativePath); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
          result(frame, { operation: 'download_episode', ...frame.params, status: 'download-returned', identityMatched: true,
            serialNo: frame.params.episodeNo, isStraight: true, playAuthorization: 'native-straight-playback', receiptReused: false, businessCalls: 1,
            media: { relativePath, bytes: bytes.length, sha256: digest(bytes), durationSeconds: 1.5, width: 720, height: 1280,
              hasAudio: true, fullDecodePassed: true } })
        } else throw Error('The external fixture refuses an unplanned native operation')
      }
    })
    return { stdin, stdout, done: settled.promise, collected: {},
      terminate() { throw Error('The real bridge must await the external cleanup acknowledgement') },
      waitForExit: async () => {
        await settled.promise
        assert.equal(this.closed, true, 'The real Host bridge must await its acknowledged external cleanup')
        assert.ok(this.proofPath); assert.ok(this.proof)
        writeFileSync(this.proofPath, JSON.stringify({ ...this.proof, cleanupAcknowledged: true }, null, 2) + '\n')
        return true
      },
    }
  }
}
