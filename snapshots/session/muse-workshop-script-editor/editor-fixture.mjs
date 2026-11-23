/** Read the current episode and stage its candidate through the Muse gateway with no draft overwrite. */
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

/** Cordis fixture name. */
export const name = 'workshop-script-editor'
/** Host services exercised by this Headless scenario. */
export const inject = ['agentPresets', 'agents', 'llm', 'systemPrompt', 'tools', 'workingDirectory']

const BASE_REVISION = 'a'.repeat(64)
const DRAFT_REVISION = 'b'.repeat(64)
const CANDIDATE = 'fe3dfd4b-8300-4fa5-8a8b-8b4cdb1b3521'
const CURRENT = '林晚走到柜前，打开账本。'
const PROPOSED = '脚步声逼近。林晚等门外安静下来，才翻开压在柜底的账本。'
const SUMMARY = '压缩动作并保留发现账本。'
const DRAFT_PATH = '/jubengongfang/v1/script-editor/drafts/12'
const EPISODE_PATH = DRAFT_PATH + '/episodes/2'

/**
 * Mount the real Workshop connection and Desktop short-drama preset against fixture routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services.
 * @param {{ tool: string, keyword: string, routes: Record<string, { name: string, response: unknown, body?: unknown }> }} options
 * @returns {Promise<string[]>} Requests in arrival order.
 */
async function mountWorkshopFixture(ctx, options) {
  const patches = loadOverlayPatches(name, overlay)
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
  assert.ok(!discovery.config.alwaysLoad.includes(options.tool), 'The Workshop tool loads on demand')
  assert.ok(discovery.config.keywords[options.tool].includes(options.keyword))
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
        assert.equal(req.headers.cookie, cookie)
        assert.equal(req.headers.origin, gateway)
        assert.equal(req.headers.authorization, undefined)
        const route = req.url === '/jubengongfang/v1/auth/me' && req.method === 'GET'
          ? { name: 'me', response: user }
          : options.routes[req.method + ' ' + req.url]
        assert.ok(route, 'Unexpected Workshop request ' + req.url)
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        assert.deepEqual(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')), route.body)
        calls.push(route.name)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(route.response))
      } catch (error) {
        failure = error
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"detail":"Unexpected fixture request"}')
      }
    },
  })
  const home = await mkdtemp(join(tmpdir(), 'workshop-editor-snapshot-'))
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
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(!JSON.stringify(options.messages).includes(cookie), 'Private login data in model input')
    yield* next()
  })
  return calls
}

/** @param {import('@deepseek-ai/cordis').Context} ctx - Shipped Headless services. */
export async function apply(ctx) {
  const calls = await mountWorkshopFixture(ctx, {
    tool: 'workshop_script_editor', keyword: '精修剧本',
    routes: {
      ['GET ' + DRAFT_PATH]: { name: 'draft', response: {
        id: 12, title: '雨巷', status: 'draft', episodeCount: 2, updatedAt: '2026-11-22T09:00:00Z',
        context: { outline: { synopsis: '林晚追查账本。' }, storyBible: null },
        episodes: [{ episode: 1, title: '回家' }, { episode: 2, title: '查账' }], canFinalize: true, revision: DRAFT_REVISION,
      } },
      ['GET ' + EPISODE_PATH]: { name: 'episode', response: {
        draftId: 12, episode: 2, title: '查账', revision: BASE_REVISION, version: 2, content: CURRENT, candidate: null,
      } },
      ['POST ' + EPISODE_PATH + '/candidates']: {
        name: 'candidate',
        body: { baseRevision: BASE_REVISION, content: PROPOSED, summary: SUMMARY },
        response: { id: CANDIDATE, baseRevision: BASE_REVISION, content: PROPOSED, summary: SUMMARY, createdAt: '2026-11-22T09:20:00Z' },
      },
    },
  })
  let modelSawCandidate = false
  ctx.on('llm/stream', async function* (options, next) {
    assert.ok(options.tools.some(tool => tool.name === 'workshop_script_editor'), 'The short-drama preset registers the editor tool')
    const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'workshop-propose')
    if (result) {
      assert.equal(result.isError, false, JSON.stringify(result.content))
      const receipt = JSON.parse(result.content.find(item => item.type === 'text').text)
      assert.equal(receipt.candidate_id, CANDIDATE)
      assert.equal(receipt.status, 'pending_review')
      assert.equal(receipt.episode, 2)
      assert.equal(receipt.base_revision, BASE_REVISION)
      assert.ok(!('content' in receipt))
      modelSawCandidate = true
    }
    yield* next()
  })
  ctx.on('agent/turn-stopping', () => {
    assert.deepEqual(calls, ['me', 'draft', 'episode', 'candidate'])
    assert.ok(modelSawCandidate)
  })
}
