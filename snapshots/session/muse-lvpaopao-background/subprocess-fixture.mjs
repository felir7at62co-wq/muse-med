/** Synthetic framed native helper; production Bridge and local byte-copy verification remain real. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { importSnapshotPackage } from '../muse-fixture-import.mjs'
import { MP4 } from '../../../third_party/plugins/muse-douyin-download/tests/task-fixtures.js'

const { SubprocessRuntime } = await importSnapshotPackage('@deepseek-ai/dsh-subprocess', new URL('../../../apps/cli/package.json', import.meta.url))
const actions = ['status', 'search', 'detail', 'episodes', 'download_first_episode', 'download_episode', 'download_status']
/** Exact synthetic source shared by the wire peer and transcript assertions. */
export const selected = { srcAppId: 'wx0000000000000002', dramaId: 'fixture-series-02' }
/** Synthetic title with no real catalog association. */
export const title = '离线纸灯全集'
/**
 * Hash observed bytes without changing the native receipt representation.
 * @param {string | Buffer} bytes - Exact observed bytes.
 * @returns {string} Lowercase SHA-256.
 */
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
/** Durable keys seeded in the scenario's pending v1 manifest, never replaced during recovery. */
export const originalKeys = ['1'.repeat(64), '2'.repeat(64)]
/** Existing v1 source-only identity, distinct from the owner-bound outer task. */
export const seriesId = digest(JSON.stringify([selected.srcAppId, selected.dramaId])).slice(0, 24)
const helperSource = '# Synthetic external helper bytes. No Python process runs in this snapshot.\n'

/** Replace only process IO and native-owned source files inside the isolated Harness home. */
export default class OfflineSubprocess extends SubprocessRuntime {
  constructor(ctx) {
    assert.ok(isAbsolute(process.env.DSH_HOME))
    const directory = join(process.env.DSH_HOME, 'lvpaopao'), native = join(directory, 'synthetic-native')
    mkdirSync(native, { recursive: true, mode: 0o700 })
    const helper = join(native, 'run-persistent-host.py'), helperSha256 = digest(helperSource)
    writeFileSync(helper, helperSource, { mode: 0o600, flag: 'wx' })
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({ transport: 'local', localPython: process.execPath,
      localHelper: helper, helperSha256, cwd: native, downloadEnabled: true }), { mode: 0o600, flag: 'wx' })
    super(ctx)
    this.native = native; this.helper = helper; this.helperSha256 = helperSha256
    this.launches = 0; this.methods = []; this.requests = []; this.acquisitions = new Map(); this.closed = false; this.cleanupAcknowledgements = 0
    this.uncertainReturned = false; this.reconciled = false
    ctx.on('agent/created', ({ agent }) => agent.ctx.tools.restrict({ futureAllow: ['lvpaopao', 'job_output'], includeOwn: true }))
    ctx.effect(() => () => {
      assert.equal(this.closed, true, 'Shared Host bridge must await native cleanup')
      assert.equal(this.cleanupAcknowledgements, this.launches)
    })
  }

  spawn(spec) {
    assert.ok(++this.launches <= 2, 'Only explicit resume can open the second native generation')
    const generation = this.launches
    if (generation === 2) assert.equal(this.cleanupAcknowledgements, 1, 'The failed generation must be clean before replacement')
    this.closed = false
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
          this.closed = true; this.cleanupAcknowledgements++
          reply({ protocol: 1, type: 'event', event: 'closed', details: { status: 'control-close',
            cleanup: { dispose: true, unload: true, detach: true, serverClosed: true } } })
          stdout.end(); settled.resolve({ exitCode: 0, signal: null }); continue
        }
        assert.equal(frame.type, 'request')
        if (frame.method === 'hello') {
          assert.deepEqual(frame.params, { expected_app_id: 'wx404dde55fb12df78', helper_sha256: this.helperSha256 })
          result(frame, { protocol_version: 1, helper_sha256: this.helperSha256, expected_app_id: 'wx404dde55fb12df78', actions, ready: true }); continue
        }
        this.methods.push(frame.method); this.requests.push({ method: frame.method, params: frame.params })
        if (frame.method === 'status') {
          assert.deepEqual(frame.params, {})
          result(frame, { operation: 'status', status: 'status-returned', identityMatched: true, ready: true, businessCalls: 0 })
        } else if (frame.method === 'search') {
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
        } else if (frame.method === 'download_episode' || frame.method === 'download_status') {
          const params = frame.params
          assert.deepEqual({ srcAppId: params.srcAppId, dramaId: params.dramaId }, selected)
          assert.ok([1, 2].includes(params.episodeNo)); assert.equal(params.idempotencyKey, originalKeys[params.episodeNo - 1])
          const bound = { operation: 'download_episode', ...params, identityMatched: true }
          if (!this.uncertainReturned) {
            assert.equal(frame.method, 'download_episode'); assert.equal(params.episodeNo, 1)
            this.uncertainReturned = true
            reply({ protocol: 1, type: 'error', id: frame.id, error: { code: 'outcome-unconfirmed' } }); continue
          }
          if (frame.method === 'download_status') {
            assert.equal(params.episodeNo, 1); assert.equal(this.reconciled, false)
            assert.equal(this.acquisitions.size, 0); this.reconciled = true
            result(frame, { ...bound, status: 'request-not-found' }); continue
          }
          assert.equal(this.reconciled, true, 'An unknown original request must be reconciled before acquisition')
          assert.equal(this.acquisitions.has(params.idempotencyKey), false)
          this.acquisitions.set(params.idempotencyKey, params.episodeNo)
          const relativePath = `downloads/${params.idempotencyKey}/media/episode-${String(params.episodeNo).padStart(4, '0')}.mp4`
          const file = join(this.native, relativePath)
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, MP4, { flag: 'wx', mode: 0o600 })
          result(frame, { ...bound, status: 'download-returned', serialNo: params.episodeNo, isStraight: true,
            playAuthorization: 'native-straight-playback', receiptReused: false, businessCalls: 1,
            media: { relativePath, bytes: MP4.length, sha256: digest(MP4), durationSeconds: 1,
              width: 16, height: 16, hasAudio: false, fullDecodePassed: true } })
        } else throw new Error(`Unplanned synthetic native action: ${frame.method}`)
      }
    })
    return { stdin, stdout, done: settled.promise, collected: {},
      terminate() { throw new Error('The real Bridge must await acknowledged cleanup') },
      waitForExit: async () => {
        await settled.promise
        assert.equal(this.closed, true)
        if (generation === 2) {
          assert.ok(this.proofPath); assert.ok(this.proof)
          writeFileSync(this.proofPath, JSON.stringify({ ...this.proof, cleanupAcknowledgements: this.cleanupAcknowledgements }, null, 2) + '\n')
        }
        return true
      },
    }
  }
}
