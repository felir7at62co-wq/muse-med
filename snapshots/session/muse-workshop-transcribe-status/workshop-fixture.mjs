/** Read Script Workshop's 视频转剧本 readiness through the Muse gateway mount, as a short-drama Agent. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLoopbackServerEffect } from '../loopback-fixture-server.mjs'
import { apply as mountPreset } from '../muse-editing-tool-catalog/editing-preset-fixture.mjs'
import { importSnapshotModule, importSnapshotPackage } from '../muse-fixture-import.mjs'

const desktopOwner = new URL('../../../apps/desktop-host/package.json', import.meta.url)
const { composeEntries, loadOverlayPatches } = await importSnapshotPackage('@deepseek-ai/dsh-app-boot', desktopOwner)
const overlay = fileURLToPath(new URL('../../../apps/desktop-host/config/desktop.cordis.patch.yml', import.meta.url))
const cookie = '__Host-muse=snapshot-private-workshop-cookie'
const user = { id: 52, username: 'snapshot-writer', role: 'writer' }
const readiness = { ready: true, queue: { queued: 37, claimed: 2 }, maxSlots: 4 }
const jobs = [
  { id: 8, job_type: 'create_spawn', status: 'running', progress: {}, result: {}, created_at: '2026-11-20T02:00:00' },
  {
    id: 7, job_type: 'video_transcribe', status: 'running', error: null, created_at: '2026-11-20T01:00:00', finished_at: null,
    progress: { percent: 50, status_message: '1 部转写中 · 已出稿 1 部 · 队列 37 部' },
    result: { delivered: [{ series_id: '7481108346636864536', title: '家里家外', episodes: 79, published: false }], attention: [], rejected: [] },
  },
]
const expected = {
  action: 'status',
  service: { ready: true, queue: { queued: 37, claimed: 2 }, max_slots: 4 },
  jobs: [{ id: 7, status: 'running', percent: 50, message: '1 部转写中 · 已出稿 1 部 · 队列 37 部', delivered: 1, attention: 0, rejected: 0, created_at: '2026-11-20T01:00:00' }],
}

/** Cordis fixture name. */
export const name = 'workshop-transcribe-status'
/** Host services exercised by this Headless scenario. */
export const inject = ['agentPresets', 'agents', 'llm', 'systemPrompt', 'tools', 'workingDirectory']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
  const patches = loadOverlayPatches('workshop-transcribe-status', overlay)
  const rows = composeEntries([patches])
  const registry = patches.find(row => row.id === 'agent-preset-registry')?.config
  const connectionRow = rows.find(row => row.id === 'workshop-connection')
  const discovery = rows.find(row => row.id === 'tool-discovery')
  // Recorded on short-drama, which Sessions started before short-drama-v2 became the default keep running on;
  // v2's craft skills need a skill registry this headless composition does not mount.
  const preset = 'short-drama'
  assert.ok(registry?.selectablePresets.includes(preset), 'Existing Sessions can keep the short-drama preset')
  assert.equal(connectionRow?.name, '@deepseek-ai/dsh-workbench-connection')
  assert.ok(!connectionRow.disabled, 'Desktop mounts the Script Workshop connection')
  assert.ok(!discovery.config.alwaysLoad.includes('workshop_video_transcribe'), 'The Workshop tool loads on demand')
  assert.ok(discovery.config.keywords.workshop_video_transcribe.includes('视频转剧本'))
  const { default: WorkshopConnection } = await importSnapshotModule(
    new URL('../../../packages/drama/workbench-connection/src/index.ts', import.meta.url),
    new URL('../../../packages/drama/workbench-connection/lib/index.js', import.meta.url),
  )
  const { MuseWorkbenchLogin } = await importSnapshotModule(
    new URL('../../../packages/host/muse-account/src/workbench-login.ts', import.meta.url),
    new URL('../../../packages/host/muse-account/lib/types/workbench-login.js', import.meta.url),
  )
  const { writeMuseSession } = await importSnapshotModule(
    new URL('../../../packages/host/muse-account/src/session.ts', import.meta.url),
    new URL('../../../packages/host/muse-account/lib/types/session.js', import.meta.url),
  )
  const calls = []
  let failure
  let gateway
  await applyLoopbackServerEffect(ctx, {
    label: 'Muse gateway with the Script Workshop mount',
    onListening: address => { gateway = 'http://127.0.0.1:' + address.port },
    onCleanup: () => { if (failure) throw failure },
    async requestListener(req, res) {
      try {
        for await (const _chunk of req) { /* GET requests carry no body. */ }
        assert.equal(req.method, 'GET')
        assert.equal(req.headers.cookie, cookie)
        assert.equal(req.headers.origin, gateway)
        assert.equal(req.headers.authorization, undefined)
        const routes = {
          '/jubengongfang/v1/auth/me': ['me', user],
          '/jubengongfang/v1/factory/video-transcribe/status': ['status', readiness],
          '/jubengongfang/v1/factory/jobs?limit=50': ['jobs', jobs],
        }
        const route = routes[req.url]
        assert.ok(route, 'Unexpected Workshop request ' + req.url)
        calls.push(route[0])
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(route[1]))
      } catch (error) {
        failure = error
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"detail":"Unexpected fixture request"}')
      }
    },
  })
  const home = await mkdtemp(join(tmpdir(), 'workshop-status-snapshot-'))
  ctx.effect(() => () => rm(home, { recursive: true, force: true }))
  const sessionFile = join(home, 'session.json')
  await writeMuseSession(sessionFile, { baseUrl: gateway, username: 'snapshot-writer', cookie })
  const login = new MuseWorkbenchLogin({ baseUrl: gateway, sessionFile, requestTimeoutMs: 10000 })
  ctx.effect(() => ctx.provide('museAccount', {
    workbenchIdentity: () => login.identity(),
    workbenchGrant: () => { throw new Error('The gateway mount needs no workbench grant') },
    requestMountedWorkbench: (audience, owner, url, init) => login.mounted(audience, owner, url, init),
  }))
  await ctx.plugin(WorkshopConnection, { workshopOrigin: gateway + '/jubengongfang' })
  await mountPreset(ctx.isolate('museAccount'), { presetId: preset, hidePlatformShellTools: true })
  let modelSawStatus = false
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(!JSON.stringify(options.messages).includes(cookie), 'Private login data in model input')
    assert.ok(options.tools.some(tool => tool.name === 'workshop_video_transcribe'), 'The short-drama preset registers the Workshop tool')
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'workshop-status')
    if (result) {
      assert.equal(result.isError, false, JSON.stringify(result.content))
      assert.deepEqual(JSON.parse(result.content.find(item => item.type === 'text').text), expected)
      modelSawStatus = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => {
    assert.deepEqual(calls, ['me', 'status', 'jobs'])
    assert.ok(modelSawStatus, 'The model receives the Workshop readiness and its 视频转剧本 jobs')
  })
}
