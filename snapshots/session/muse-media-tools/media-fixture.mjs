/** Company media tools keep the real account transport, local verification and delivery writer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/index.js', import.meta.url))
const { writeMuseSession } = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url))
const cookie = '__Host-muse=' + 'snapshot-only-company-login'.padEnd(43, 'x')
const username = 'media-fixture'
const jobId = '91000000-0000-4000-8000-000000000001'
const partialJobId = '91000000-0000-4000-8000-000000000002'
const dataJobId = '91000000-0000-4000-8000-000000000003'
const clock = 1791244800000
const fileName = 'fixture.mp4'
const requestId = 'snapshot-media-stable-1'
const partialRequestId = 'snapshot-media-partial-2'
const mediaNames = ['muse_media_data', 'muse_media_download', 'muse_media_import', 'muse_media_task']
const remoteNames = ['parse_url', 'get_video', 'get_user', 'list_user_posts', 'list_comments', 'get_content_history', 'download_media', 'get_task_result']

async function executable(name) {
  const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const directory of candidates) {
    const path = join(directory, process.platform === 'win32' ? name + '.exe' : name)
    try { await access(path, constants.X_OK); return path }
    catch (_error) { /* Continue through the executable search path. */ }
  }
  throw Error(`muse-media-tools snapshot requires ${name} on PATH`)
}

/** Loader identity for the keyless company-media conversation. */
export const name = 'snapshot-muse-media-tools'
/** Shipped profile services consumed by production account and result assertions. */
export const inject = ['llm', 'tools', 'sessions', 'sessionProjections', 'agentDefaultModel', 'fs', 'subprocess', 'sandboxPolicy']

/**
 * Replace the external gateway with deterministic authenticated HTTP responses.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless Loader context.
 * @returns {Promise<void>} Completion after the account tools and loopback gateway are ready.
 */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-media-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const bytes = await readFile(new URL('./fixture.mp4', import.meta.url))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = { name: fileName, bytes: bytes.length, sha256, kind: 'video' }
  const completeCoverage = { reported: 1, accepted: 1, rejected: 0, complete: true, truncated: false }
  const saved = { job_id: jobId, request_id: requestId, state: 'cloud_saved', tool: 'download_media', files: [file],
    file_coverage: completeCoverage, automatic_resubmit: false, created_at: clock, updated_at: clock }
  const pending = { ...saved, state: 'pending', files: [], file_coverage: undefined }
  const partial = { ...saved, job_id: partialJobId, request_id: partialRequestId, state: 'partial',
    file_coverage: { reported: 2, accepted: 1, rejected: 1, complete: false, truncated: false }, code: 'files_rejected' }
  let baseUrl, rejected, queried = false, modelRequests = 0
  const downloads = [], dataReads = [], taskReads = [], fileReads = [], records = new Map(), visible = new Map()
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-muse-media-gateway', onCleanup() {},
    onListening: address => { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk.toString('utf8') })
      request.once('end', () => {
        const send = (status, value) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(value))
        }
        try {
          assert.equal(request.headers.cookie, cookie)
          if (request.url === '/api/desktop-models/providers') { send(200, { providers: [] }); return }
          if (request.url === '/api/muse.account') { send(200, { username }); return }
          if (request.url === '/api/muse.activity') { response.writeHead(204); response.end(); return }
          assert.equal(request.headers.origin, baseUrl)
          assert.ok(!body.includes(cookie))
          if (request.url === '/api/media/mcp/' && request.method === 'POST') {
            const input = JSON.parse(body)
            assert.equal(input.jsonrpc, '2.0'); assert.equal(input.method, 'tools/call')
            assert.equal(typeof input.id, 'string')
            const { name: tool, arguments: args } = input.params
            assert.ok(remoteNames.includes(tool), `Unexpected remote media tool ${tool}`)
            const rpc = value => send(200, { jsonrpc: '2.0', id: input.id, result: {
              content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value.state === 'failed',
            } })
            if (tool === 'parse_url') {
              assert.deepEqual(args, { url: 'https://www.douyin.com/video/7100000000000000001' })
              dataReads.push(tool)
              rpc({ job_id: dataJobId, state: 'ok', tool, files: [], automatic_resubmit: false,
                data: { platform: 'douyin', content_id: '7100000000000000001', title: 'Synthetic public media', metrics: { views: null } } }); return
            }
            if (tool === 'get_video') {
              assert.deepEqual(args, { platform: 'douyin', content_id: '7100000000000000001' })
              dataReads.push('rate_limited'); send(429, { error: 'media_rate_limited', cookie, api_key: 'snapshot-upstream-key' }); return
            }
            if (tool === 'get_user') {
              assert.deepEqual(args, { platform: 'douyin', uid: 'synthetic-author' })
              dataReads.push('forbidden'); send(403, { error: 'media_permission_denied' }); return
            }
            if (tool === 'download_media') {
              assert.ok(args.request_id === requestId || args.request_id === partialRequestId)
              assert.equal(args.url, 'https://www.douyin.com/video/7100000000000000001')
              assert.equal(args.skip_existing, true)
              downloads.push(args)
              const existing = records.get(args.request_id)
              if (existing) assert.deepEqual(existing.args, args)
              else records.set(args.request_id, { args, jobId: args.request_id === requestId ? jobId : partialJobId })
              rpc(args.request_id === partialRequestId ? partial : queried ? saved : pending); return
            }
            if (tool === 'get_task_result') {
              assert.deepEqual(args, { job_id: jobId })
              queried = true; taskReads.push('query_original'); rpc(saved); return
            }
            throw Error(`Unexpected remote media request ${tool}`)
          }
          if (request.url === '/api/media/status' && request.method === 'GET') {
            taskReads.push('status'); send(200, { ready: true, limits: {
              requests_per_minute: 30, concurrent_requests: 2, downloads_per_day: 10, concurrent_downloads: 1,
            } }); return
          }
          if (request.url === '/api/media/jobs?offset=0' && request.method === 'GET') {
            taskReads.push('list'); send(200, { jobs: [saved, partial], next_offset: null }); return
          }
          if (request.url === `/api/media/jobs/${jobId}` && request.method === 'GET') {
            taskReads.push(queried ? 'get_saved' : 'query_original'); queried = true; send(200, saved); return
          }
          if (request.url === `/api/media/jobs/${partialJobId}` && request.method === 'GET') {
            taskReads.push('get_partial'); send(200, partial); return
          }
          if (request.url === `/api/media/jobs/${jobId}/files/${fileName}` && request.method === 'GET') {
            fileReads.push(fileName); response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length });
            response.end(bytes); return
          }
          throw Error(`Unexpected media snapshot request: ${request.method} ${request.url}`)
        } catch (error) {
          rejected = error
          if (!response.headersSent) send(500, { error: 'Media fixture mismatch' })
          else response.end()
        }
      })
    },
  })
  await writeMuseSession(join(home, 'session.json'), { baseUrl, username, cookie })
  await ctx.plugin(account, account.Config({ baseUrl, accountHome: home, mediaTools: true,
    mediaFfmpegPath: await executable('ffmpeg'), mediaFfprobePath: await executable('ffprobe'), mediaNodePath: process.execPath,
  })).await()
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    if (modelRequests++ === 0) {
      assert.ok(names.includes('tool_search'))
      assert.ok(names.includes('present'))
      assert.ok(mediaNames.every(tool => !names.includes(tool)), 'Media definitions must load through discovery')
    } else assert.ok(mediaNames.every(tool => names.includes(tool)), 'All four discovered media definitions must reach the model')
    assert.ok(!JSON.stringify(options.messages).includes(cookie))
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId.startsWith('call_media_')) continue
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      visible.set(message.toolCallId, { text, isError: message.isError })
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    const events = agent.session.snapshotEvents()
    const calls = events.filter(event => event.type === 'tool/call')
    assert.deepEqual(calls.map(event => event.data.name), ['tool_search', 'muse_media_data', 'muse_media_download',
      'muse_media_task', 'muse_media_download', 'muse_media_download', 'muse_media_data', 'muse_media_data',
      'muse_media_task', 'muse_media_data', 'muse_media_import', 'muse_media_import', 'present'])
    assert.equal(downloads.length, 3); assert.equal(records.size, 2)
    assert.deepEqual(downloads[0], downloads[1])
    assert.deepEqual(dataReads, ['parse_url', 'rate_limited', 'forbidden'])
    assert.deepEqual(taskReads, ['query_original', 'list', 'status', 'get_saved', 'get_partial'])
    assert.deepEqual(fileReads, [fileName])
    const report = id => {
      const item = visible.get(id)
      assert.ok(item, `Missing model-visible tool result ${id}`)
      return { ...JSON.parse(item.text), isError: item.isError }
    }
    assert.equal(report('call_media_data').state, 'ok')
    assert.equal(report('call_media_data').data.metrics.views, null)
    assert.equal(report('call_media_pending').state, 'pending')
    assert.equal(report('call_media_query').state, 'cloud_saved')
    assert.equal(report('call_media_duplicate').state, 'cloud_saved')
    assert.equal(report('call_media_partial').state, 'partial')
    assert.equal(report('call_media_partial').file_coverage.complete, false)
    assert.equal(report('call_media_partial').file_coverage.rejected, 1)
    for (const id of ['call_media_pending', 'call_media_query', 'call_media_duplicate', 'call_media_partial']) {
      assert.equal(report(id).path, undefined, 'A cloud receipt cannot announce a local file')
    }
    assert.equal(report('call_media_rate').state, 'failed')
    assert.equal(report('call_media_rate').code, 'rate-limited')
    assert.equal(report('call_media_denied').state, 'failed')
    assert.equal(report('call_media_denied').code, 'company-access-required')
    const imported = report('call_media_import')
    assert.equal(imported.state, 'local_ready', JSON.stringify(imported)); assert.equal(imported.fullDecodeVerified, true)
    assert.equal(imported.sourceJobState, 'cloud_saved'); assert.deepEqual(imported.fileCoverage, completeCoverage)
    assert.equal(imported.sha256, sha256); assert.equal(imported.bytes, bytes.length)
    assert.equal(report('call_media_import_partial').state, 'failed')
    assert.equal(report('call_media_import_partial').code, 'not-found')
    const path = join(process.cwd(), 'source', 'media', 'company', `${jobId}-${fileName}`)
    assert.equal(imported.path, path)
    assert.deepEqual(await readFile(path), bytes)
    assert.equal((await stat(path)).size, bytes.length)
    const deliveries = events.filter(event => event.type === 'deliverables/presented')
    assert.equal(deliveries.length, 1, JSON.stringify(visible.get('call_media_present')))
    assert.ok(deliveries[0].data.files.some(file => file.path === path), 'The delivered file keeps its exact local path')
    assert.ok(!JSON.stringify(events).includes(cookie))
    assert.ok(!JSON.stringify(events).includes('snapshot-upstream-key'))
    await writeFile(join(process.cwd(), 'media-proof.json'), JSON.stringify({
      downloadRequests: downloads.length, downloadJobs: records.size, duplicateReused: true,
      pendingQueriedOriginalJob: queried, partialPromoted: false, authenticatedFileReads: fileReads.length,
      localBytes: bytes.length, localSha256: sha256, fullDecodeVerified: true,
      deliveries: deliveries.length, rateLimitReported: true, permissionDeniedReported: true, credentialsLogged: false,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
