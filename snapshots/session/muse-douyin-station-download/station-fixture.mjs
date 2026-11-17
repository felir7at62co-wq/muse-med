/** Data-station Douyin downloads use the production account plugin, a private loopback station and one fixed share redirect. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { importSnapshotModule } from '../muse-fixture-import.mjs'

const account = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/index.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/index.js', import.meta.url))
const { writeMuseSession } = await importSnapshotModule(new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
  new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url))
const token = 'snapshot-only-douyin-login'.padEnd(43, 'x')
const cookie = `__Host-muse=${token}`
const username = 'douyin-fixture'
const prefix = '/data/api/muse-client/douyin'
const work = '7570000000000000001'
const mix = '7529000000000000001'
const limited = '7570000000000000009'
const shareLink = 'https://v.douyin.com/iRNBho6u/'
const storage = 'https://muse.tos-cn-beijing.volces.com/download-video-date/douyin/20261115'

function record(awemeId, patch = {}) {
  return { id: `r-${awemeId}`, awemeId, mixId: null, mixName: null, episode: null, title: '短剧第1集', state: 'done',
    key: `download-video-date/douyin/20261115/${awemeId}/video/000-${awemeId}.mp4`,
    url: `${storage}/${awemeId}/video/000-${awemeId}.mp4`, error: null, attempts: 1, requestedBy: '成员', ...patch }
}

function episode(number, awemeId, patch = {}) {
  return record(awemeId, { mixId: mix, mixName: '示例短剧', episode: number, title: `示例短剧 第${number}集`,
    key: `download-video-date/douyin/20261115/${mix}/video/00${number}-${awemeId}.mp4`,
    url: `${storage}/${mix}/video/00${number}-${awemeId}.mp4`, ...patch })
}

/** Loader identity for the keyless data-station Douyin conversation. */
export const name = 'snapshot-muse-douyin-station'
/** Profile services used by the production account plugin, its company media tools and transcript assertions. */
export const inject = ['llm', 'tools', 'sessions', 'sessionProjections', 'agentDefaultModel', 'fs', 'subprocess', 'sandboxPolicy']

/**
 * Keep account, tools and Session intake real; replace only the Muse gateway, the data station and the share-link host.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Isolated Headless Loader context.
 * @returns {Promise<void>} Completion after the account plugin and loopback station are ready.
 */
export async function apply(ctx) {
  const home = await mkdtemp(join(tmpdir(), 'muse-douyin-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  let baseUrl, rejected, quotaReads = 0, shareLinkReads = 0, workListReads = 0, mixListReads = 0, companyDouyinRequests = 0
  const submissions = [], visible = new Map()
  const transport = globalThis.fetch
  ctx.effect(() => {
    // The share-link host is the only external service outside the loopback station; it answers one redirect.
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.hostname !== 'v.douyin.com') return await transport(input, init)
      try {
        assert.equal(url.href, shareLink)
        assert.equal(init?.redirect, 'manual')
        assert.equal(new Headers(init?.headers).has('x-muse-account-token'), false)
        shareLinkReads++
      } catch (error) { rejected = error }
      return new Response(null, { status: 302, headers: { location: `https://www.iesdouyin.com/share/video/${work}/?region=CN` } })
    }
    return () => { globalThis.fetch = transport }
  }, 'snapshot: Douyin share-link host')
  await applyLoopbackServerEffect(ctx, { label: 'snapshot-muse-douyin-station', onCleanup() {},
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
          if (request.url === '/api/desktop-models/providers') { send(200, { providers: [] }); return }
          if (request.url === '/api/muse.account') { send(200, { username }); return }
          if (request.url === '/api/muse.activity') { response.writeHead(204); response.end(); return }
          if (request.url?.startsWith('/api/media/')) { companyDouyinRequests++; send(500, { error: 'Unexpected company media request' }); return }
          assert.ok(request.url?.startsWith(`${prefix}/`), `Unexpected station request ${request.url}`)
          assert.equal(request.headers['x-muse-account-token'], token)
          for (const header of ['origin', 'cookie', 'authorization']) assert.equal(request.headers[header], undefined, header)
          const path = request.url.slice(prefix.length)
          if (request.method === 'GET' && path === '/downloads/status') {
            quotaReads++
            send(200, { enabled: true, access: 'public', linkSeconds: 0, dailyLimit: 50, usedToday: 47, unlimited: false, maxMixEpisodes: 300 })
            return
          }
          if (request.method === 'POST' && path === '/downloads') {
            const input = JSON.parse(body)
            submissions.push(input)
            if (input.awemeId === limited) { send(429, { error: '今天已下载 50 条，明天再试' }); return }
            assert.deepEqual(input, { awemeId: work })
            send(202, { queued: [record(work, { state: 'queued', url: null })], existing: [], skipped: 0 })
            return
          }
          if (request.method === 'POST' && path === '/downloads/mix') {
            const input = JSON.parse(body)
            submissions.push(input)
            assert.deepEqual(input, { mixId: mix })
            send(202, { queued: [episode(2, '7570000000000000102', { state: 'queued', url: null })],
              existing: [episode(1, '7570000000000000101')], skipped: 1 })
            return
          }
          if (request.method === 'GET' && path === `/downloads?limit=300&awemeIds=${work}`) {
            workListReads++
            send(200, [record(work, workListReads === 1 ? { state: 'downloading', url: null } : {})])
            return
          }
          if (request.method === 'GET' && path === `/downloads?limit=300&mixId=${mix}`) {
            mixListReads++
            send(200, [episode(2, '7570000000000000102', { state: 'downloading', url: null }), episode(1, '7570000000000000101')])
            return
          }
          throw Error(`Unexpected station request: ${request.method} ${request.url}`)
        } catch (error) {
          rejected = error
          if (!response.headersSent) send(500, { error: 'Station fixture mismatch' })
          else response.end()
        }
      })
    },
  })
  await writeMuseSession(join(home, 'session.json'), { baseUrl, username, cookie })
  await ctx.plugin(account, account.Config({ baseUrl, accountHome: home, douyinDownloadTool: true, douyinPollIntervalMs: 1000,
    mediaTools: true, mediaNodePath: process.execPath })).await()
  ctx.on('llm/stream', async function* (options, next) {
    const names = options.tools.map(tool => tool.name)
    assert.ok(names.includes('douyin_download'), 'The data-station Douyin tool must reach the model')
    assert.ok(names.includes('muse_media_download'), 'The company media download tool must reach the model')
    assert.ok(!JSON.stringify(options.messages).includes(token))
    for (const message of options.messages) {
      if (message.role !== 'tool') continue
      visible.set(message.toolCallId, message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (rejected) throw rejected
    const events = agent.session.snapshotEvents()
    assert.deepEqual(events.filter(event => event.type === 'tool/call').map(event => event.data.name),
      ['douyin_download', 'douyin_download', 'douyin_download', 'douyin_download', 'muse_media_download'])
    const report = id => {
      const text = visible.get(id)
      assert.ok(text, `Missing model-visible tool result ${id}`)
      return JSON.parse(text)
    }
    assert.equal(report('call_douyin_quota').usedToday, 47)
    assert.equal(report('call_douyin_work').state, 'done')
    assert.equal(report('call_douyin_work').works[0].url, `${storage}/${work}/video/000-${work}.mp4`)
    assert.equal(report('call_douyin_mix').state, 'preparing')
    assert.deepEqual(report('call_douyin_mix').works.map(item => item.episode), [1, 2])
    assert.equal(report('call_douyin_mix').submitted.skipped, 1)
    assert.equal(report('call_douyin_limit').code, 'daily-limit')
    assert.equal(report('call_media_douyin').code, 'douyin-unsupported')
    assert.ok(!JSON.stringify(events).includes(token))
    await writeFile(join(process.cwd(), 'douyin-proof.json'), JSON.stringify({
      quotaReads, shareLinkReads, submissions: submissions.length, workListReads, mixListReads, companyDouyinRequests,
      tokenHeaderOnly: true, credentialsLogged: false,
    }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  })
}
