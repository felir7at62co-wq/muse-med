/** Exact cloud manifest filenames survive authenticated, verified local publication. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const accountLib = process.env.MUSE_MEDIA_ACCOUNT_LIB
if (accountLib !== undefined) assert.equal(process.env.DSH_EXAMPLE_MODE, 'lib', 'The owned account artifact override requires the built lane')
const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  accountLib === undefined ? new URL('../../../packages/host/muse-account/lib/index.js', import.meta.url) : pathToFileURL(join(accountLib, 'index.js')))
const { writeMuseSession } = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url))
const cookie = '__Host-muse=' + 'snapshot-only-safe-filename-login'.padEnd(43, 'x')
const username = 'media-filename-fixture'
const jobId = '91000000-0000-4000-8000-000000000001'
const fileName = 'video (1).mp4'
const alias = 'video_1.mp4'
const clock = 1791244800000
const mediaNames = ['muse_media_data', 'muse_media_download', 'muse_media_import', 'muse_media_task']

async function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = join(directory, process.platform === 'win32' ? name + '.exe' : name)
    try { await access(path, constants.X_OK); return path }
    catch (_error) { /* Continue through the executable search path. */ }
  }
  throw Error(`muse-media-import-safe-filename requires ${name} on PATH`)
}

/** Loader identity for exact safe-filename import. */
export const name = 'snapshot-muse-media-import-safe-filename'
/** Actual account, policy and subprocess services used by the importer. */
export const inject = ['llm', 'tools', 'sessions', 'sessionProjections', 'agentDefaultModel', 'fs', 'subprocess', 'sandboxPolicy']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated shipped Headless context. */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-media-filename-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const bytes = await readFile(new URL('./fixture.mp4', import.meta.url))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const coverage = { reported: 1, accepted: 1, rejected: 0, complete: true, truncated: false }
  const file = { name: fileName, bytes: bytes.length, sha256, kind: 'video' }
  const saved = { job_id: jobId, request_id: 'snapshot-media-stable-1', state: 'cloud_saved', tool: 'download_media',
    files: [file], file_coverage: coverage, automatic_resubmit: false, created_at: clock, updated_at: clock }
  let baseUrl, rejected, modelRequests = 0, verifiedBeforePresent = false
  const jobReads = [], fileReads = [], visible = new Map()
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-media-filename-gateway', onCleanup() {},
    onListening: address => { baseUrl = `http://127.0.0.1:${address.port}` },
    requestListener: (request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk.toString('utf8') })
      request.once('end', () => {
        const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
        try {
          assert.equal(request.headers.cookie, cookie)
          if (request.url === '/api/desktop-models/providers') { send(200, { providers: [] }); return }
          if (request.url === '/api/muse.account') { send(200, { username }); return }
          if (request.url === '/api/muse.activity') { response.writeHead(204); response.end(); return }
          assert.equal(request.headers.origin, baseUrl)
          assert.equal(request.method, 'GET', 'This scenario never submits a remote download')
          assert.equal(body, '')
          if (request.url === `/api/media/jobs/${jobId}`) { jobReads.push(jobId); send(200, saved); return }
          if (request.url === `/api/media/jobs/${jobId}/files/${encodeURIComponent(fileName)}`) {
            fileReads.push(fileName)
            response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length }); response.end(bytes); return
          }
          throw Error(`Unexpected exact-filename request: ${request.method} ${request.url}`)
        } catch (error) {
          rejected = error
          if (!response.headersSent) send(500, { error: 'Safe filename fixture mismatch' })
          else response.end()
        }
      })
    },
  })
  await writeMuseSession(join(home, 'session.json'), { baseUrl, username, cookie })
  await ctx.plugin(account, account.Config({ baseUrl, accountHome: home, mediaTools: true,
    mediaFfmpegPath: await executable('ffmpeg'), mediaFfprobePath: await executable('ffprobe'), mediaNodePath: process.execPath,
  })).await()
  const report = id => {
    const result = visible.get(id)
    assert.ok(result, `Missing model-visible tool result ${id}`)
    return { ...JSON.parse(result.text), isError: result.isError }
  }
  const assertPublication = async () => {
    const imported = report('call_media_import')
    assert.equal(imported.state, 'local_ready', JSON.stringify(imported))
    assert.equal(imported.isError, false)
    assert.equal(imported.fileName, fileName)
    assert.equal(imported.fullDecodeVerified, true)
    assert.equal(imported.sourceJobState, 'cloud_saved')
    assert.deepEqual(imported.fileCoverage, coverage)
    assert.equal(imported.bytes, bytes.length); assert.equal(imported.sha256, sha256)
    assert.equal(imported.width, 128); assert.equal(imported.height, 72); assert.equal(imported.durationSeconds, 1)
    const directory = join(await realpath(process.cwd()), 'source', 'media', 'company')
    const localName = `${jobId}-${fileName}`
    const path = join(directory, localName)
    assert.equal(imported.path, path); assert.equal(imported.receipt, `${path}.source.json`)
    assert.deepEqual(await readFile(path), bytes); assert.equal((await stat(path)).size, bytes.length)
    assert.deepEqual(JSON.parse(await readFile(imported.receipt, 'utf8')), { jobId, fileName, path,
      bytes: bytes.length, sha256, kind: 'video', width: 128, height: 72, durationSeconds: 1, fullDecodeVerified: true })
    assert.deepEqual((await readdir(directory)).sort(), [localName, `${localName}.source.json`].sort(), 'Publication leaves only the verified file and receipt')
    return path
  }
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    if (modelRequests++ === 0) { assert.ok(names.includes('tool_search')); assert.ok(mediaNames.every(tool => !names.includes(tool))) }
    else assert.ok(mediaNames.every(tool => names.includes(tool)))
    assert.ok(!JSON.stringify(options.messages).includes(cookie))
    for (const message of options.messages) {
      if (message.role !== 'tool' || !message.toolCallId.startsWith('call_media_')) continue
      visible.set(message.toolCallId, { text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), isError: message.isError })
    }
    const last = options.messages.findLast(message => message.role === 'tool')
    if (last?.toolCallId === 'call_media_alias') {
      assert.equal(report('call_media_alias').state, 'failed'); assert.equal(report('call_media_alias').code, 'not-found')
      assert.deepEqual(fileReads, [], 'A sanitized alias must not fetch an unlisted file')
    }
    if (last?.toolCallId === 'call_media_import') { await assertPublication(); verifiedBeforePresent = true }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      ['tool_search', 'muse_media_task', 'muse_media_import', 'muse_media_import', 'present'])
    const receipt = report('call_media_query')
    assert.equal(receipt.state, 'cloud_saved'); assert.deepEqual(receipt.files, [file]); assert.equal(receipt.path, undefined)
    assert.equal(jobReads.length, 3); assert.deepEqual(fileReads, [fileName])
    assert.equal(verifiedBeforePresent, true)
    const path = await assertPublication()
    const deliveries = events.filter(event => event.type === 'deliverables/presented')
    assert.equal(deliveries.length, 1); assert.ok(JSON.stringify(deliveries[0]).includes(path))
    assert.ok(!JSON.stringify(events).includes(cookie))
    await writeFile(join(process.cwd(), 'safe-filename-proof.json'), JSON.stringify({
      manifestFileName: fileName, sanitizedAlias: alias, sanitizedAliasCode: 'not-found',
      ownedReceiptReads: jobReads.length, authenticatedFileReads: fileReads.length, remoteDownloadSubmissions: 0,
      localBytes: bytes.length, localSha256: sha256, fullDecodeVerified: true,
      exactNamePublished: true, receiptAndBytesVerifiedBeforePresent: verifiedBeforePresent,
      stagingFilesRemain: false, deliveries: deliveries.length, credentialsLogged: false,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
